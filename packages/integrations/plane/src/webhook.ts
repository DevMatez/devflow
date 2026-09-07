import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  WebhookHandler,
  RawWebhookRequest,
  ResolvedConnection,
  NormalizedWebhookEvent,
} from '@devflow/integrations-core';
import { toNormalizedIssueEvent } from './mappers';

export interface PlaneWebhookHandlerOptions {
  /**
   * Plane has no App-level shared secret (unlike GitHub) -- each org
   * configures its own webhook in its own workspace and gets its own
   * auto-generated secret, stored per-connection. Looks it up (decrypted)
   * by workspace_id; both injected, this package never touches a database
   * or decrypts anything itself.
   */
  getWebhookSecretForWorkspace(workspaceId: string): Promise<string | null>;
  findConnectionByWorkspaceId(workspaceId: string): Promise<ResolvedConnection | null>;
}

interface PlaneWebhookPayload {
  event_id?: string;
  entity_id?: string;
  event?: string;
  workspace_id?: string;
  data?: unknown;
}

function header(request: RawWebhookRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parsePayload(request: RawWebhookRequest): PlaneWebhookPayload {
  return JSON.parse(request.rawBody.toString('utf8'));
}

/** Implements `WebhookHandler` for Plane (design doc §6). */
export function createPlaneWebhookHandler(options: PlaneWebhookHandlerOptions): WebhookHandler {
  return {
    async verify(request: RawWebhookRequest): Promise<void> {
      const signature = header(request, 'x-plane-signature');
      if (!signature) throw new Error('Missing X-Plane-Signature header');

      const payload = parsePayload(request);
      if (!payload.workspace_id) throw new Error('Missing workspace_id in Plane webhook payload');

      const secret = await options.getWebhookSecretForWorkspace(payload.workspace_id);
      if (!secret) throw new Error('No connection found for this Plane workspace');

      const expected = createHmac('sha256', secret).update(request.rawBody).digest('hex');
      const actual = Buffer.from(signature);
      const expectedBuf = Buffer.from(expected);
      if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) {
        throw new Error('Invalid Plane webhook signature');
      }
    },

    extractDeliveryId(request: RawWebhookRequest): string {
      // Dedupe key is `event_id`, explicitly NOT the X-Plane-Delivery header/`delivery_id`
      // (design doc §4.1/§6 — Plane's delivery_id changes on every retry, event_id doesn't).
      const payload = parsePayload(request);
      if (!payload.event_id) throw new Error('Missing event_id in Plane webhook payload');
      return payload.event_id;
    },

    async resolveConnection(request: RawWebhookRequest): Promise<ResolvedConnection | null> {
      const payload = parsePayload(request);
      if (!payload.workspace_id) return null;
      return options.findConnectionByWorkspaceId(payload.workspace_id);
    },

    async normalize(request: RawWebhookRequest): Promise<NormalizedWebhookEvent[]> {
      const payload = parsePayload(request);
      const eventName = header(request, 'x-plane-event') ?? payload.event;
      if (!eventName || !payload.entity_id) return [];
      return normalizeEvent(eventName, payload.entity_id, payload.data);
    },
  };
}

const EVENT_TYPE_MAP: Record<string, string> = {
  'workitem.created': 'projectmanagement.issue.created',
  'workitem.updated': 'projectmanagement.issue.updated',
  'workitem.comment.created': 'projectmanagement.issue.comment_created',
};

function normalizeEvent(
  eventName: string,
  entityId: string,
  data: unknown,
): NormalizedWebhookEvent[] {
  const type = EVENT_TYPE_MAP[eventName];
  if (!type) return [];
  if (type === 'projectmanagement.issue.created' || type === 'projectmanagement.issue.updated') {
    return [{ type, aggregateId: entityId, payload: toNormalizedIssueEvent(data) }];
  }
  return [{ type, aggregateId: entityId, payload: data ?? {} }];
}
