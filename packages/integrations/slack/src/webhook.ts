import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  WebhookHandler,
  RawWebhookRequest,
  ResolvedConnection,
  NormalizedWebhookEvent,
} from '@devflow/integrations-core';

const FRESHNESS_WINDOW_SECONDS = 5 * 60;

export interface SlackWebhookHandlerOptions {
  /** App-wide, from the Slack app's Basic Info page — not per-installation (unlike Plane's). */
  signingSecret: string;
  findConnectionByTeamId(teamId: string): Promise<ResolvedConnection | null>;
}

interface SlackEventEnvelope {
  type?: string;
  team_id?: string;
  event_id?: string;
  event?: { type?: string; [key: string]: unknown };
}

function header(request: RawWebhookRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parsePayload(request: RawWebhookRequest): SlackEventEnvelope {
  return JSON.parse(request.rawBody.toString('utf8'));
}

/** Implements `WebhookHandler` for Slack (design doc §7). */
export function createSlackWebhookHandler(options: SlackWebhookHandlerOptions): WebhookHandler {
  return {
    async verify(request: RawWebhookRequest): Promise<void> {
      const signature = header(request, 'x-slack-signature');
      const timestamp = header(request, 'x-slack-request-timestamp');
      if (!signature) throw new Error('Missing X-Slack-Signature header');
      if (!timestamp) throw new Error('Missing X-Slack-Request-Timestamp header');

      // Defends against replay of an old, validly-signed payload — signature alone doesn't catch this (design doc §7/§12).
      const age = Math.abs(Date.now() / 1000 - Number(timestamp));
      if (!Number.isFinite(age) || age > FRESHNESS_WINDOW_SECONDS) {
        throw new Error('Slack request timestamp is too old');
      }

      const base = `v0:${timestamp}:${request.rawBody.toString('utf8')}`;
      const expected = `v0=${createHmac('sha256', options.signingSecret).update(base).digest('hex')}`;
      const actual = Buffer.from(signature);
      const expectedBuf = Buffer.from(expected);
      if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) {
        throw new Error('Invalid Slack webhook signature');
      }
    },

    extractDeliveryId(request: RawWebhookRequest): string {
      // Dedupe key is event_id (design doc §7); X-Slack-Retry-Num/-Reason are logged elsewhere, not part of this key.
      const payload = parsePayload(request);
      if (!payload.event_id) throw new Error('Missing event_id in Slack event payload');
      return payload.event_id;
    },

    async resolveConnection(request: RawWebhookRequest): Promise<ResolvedConnection | null> {
      const payload = parsePayload(request);
      if (!payload.team_id) return null;
      return options.findConnectionByTeamId(payload.team_id);
    },

    async normalize(request: RawWebhookRequest): Promise<NormalizedWebhookEvent[]> {
      const payload = parsePayload(request);
      const innerType = payload.event?.type;
      if (innerType !== 'message') return [];

      const event = payload.event as { channel?: string; ts?: string };
      if (!event.ts) return [];

      return [{ type: 'chat.message.posted', aggregateId: event.ts, payload: event }];
    },
  };
}
