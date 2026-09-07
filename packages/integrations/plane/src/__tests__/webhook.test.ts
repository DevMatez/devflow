import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createPlaneWebhookHandler } from '../webhook';
import type { RawWebhookRequest } from '@devflow/integrations-core';

const SECRET = 'test-plane-webhook-secret';

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function makeRequest(payload: unknown, headers: Record<string, string> = {}): RawWebhookRequest {
  return { headers, rawBody: Buffer.from(JSON.stringify(payload)) };
}

const basePayload = {
  version: 'v2',
  delivery_id: 'delivery-1',
  event_id: 'event-1',
  entity_id: 'item-1',
  entity_type: 'issue',
  event: 'workitem.created',
  webhook_id: 'webhook-1',
  workspace_id: 'workspace-1',
  data: { id: 'item-1', name: 'Test' },
  previous_attributes: {},
};

function makeHandler(
  overrides: {
    getWebhookSecretForWorkspace?: (workspaceId: string) => Promise<string | null>;
    findConnectionByWorkspaceId?: (workspaceId: string) => Promise<unknown>;
  } = {},
) {
  return createPlaneWebhookHandler({
    getWebhookSecretForWorkspace: overrides.getWebhookSecretForWorkspace ?? (async () => SECRET),
    findConnectionByWorkspaceId: (overrides.findConnectionByWorkspaceId ?? vi.fn()) as never,
  });
}

describe('createPlaneWebhookHandler: verify', () => {
  it('resolves for a validly signed payload', async () => {
    const body = JSON.stringify(basePayload);
    const signature = sign(SECRET, body);
    const handler = makeHandler();

    await expect(
      handler.verify({ headers: { 'x-plane-signature': signature }, rawBody: Buffer.from(body) }),
    ).resolves.toBeUndefined();
  });

  it('throws when the signature header is missing', async () => {
    const handler = makeHandler();
    await expect(handler.verify(makeRequest(basePayload))).rejects.toThrow(
      'Missing X-Plane-Signature header',
    );
  });

  it('throws when workspace_id is missing from the payload', async () => {
    const handler = makeHandler();
    const payload = { ...basePayload, workspace_id: undefined };
    await expect(
      handler.verify(makeRequest(payload, { 'x-plane-signature': 'deadbeef' })),
    ).rejects.toThrow('Missing workspace_id in Plane webhook payload');
  });

  it('throws when no connection secret is found for the workspace', async () => {
    const handler = makeHandler({ getWebhookSecretForWorkspace: async () => null });
    await expect(
      handler.verify(makeRequest(basePayload, { 'x-plane-signature': 'deadbeef' })),
    ).rejects.toThrow('No connection found for this Plane workspace');
  });

  it('throws for a signature that does not match', async () => {
    const handler = makeHandler();
    await expect(
      handler.verify(makeRequest(basePayload, { 'x-plane-signature': 'deadbeef' })),
    ).rejects.toThrow('Invalid Plane webhook signature');
  });
});

describe('createPlaneWebhookHandler: extractDeliveryId', () => {
  it('uses event_id, not delivery_id or the X-Plane-Delivery header', () => {
    const handler = makeHandler();
    const id = handler.extractDeliveryId(
      makeRequest(basePayload, { 'x-plane-delivery': 'delivery-1' }),
    );
    expect(id).toBe('event-1');
  });

  it('throws when event_id is missing from the payload', () => {
    const handler = makeHandler();
    const rest = { ...basePayload, event_id: undefined };
    expect(() => handler.extractDeliveryId(makeRequest(rest))).toThrow(
      'Missing event_id in Plane webhook payload',
    );
  });
});

describe('createPlaneWebhookHandler: resolveConnection', () => {
  it('looks up the connection by workspace_id', async () => {
    const findConnectionByWorkspaceId = vi
      .fn()
      .mockResolvedValue({ organizationId: 'org-1', connectionId: 'conn-1' });
    const handler = makeHandler({ findConnectionByWorkspaceId });

    const resolved = await handler.resolveConnection(makeRequest(basePayload));

    expect(findConnectionByWorkspaceId).toHaveBeenCalledWith('workspace-1');
    expect(resolved).toEqual({ organizationId: 'org-1', connectionId: 'conn-1' });
  });

  it('returns null when workspace_id is missing', async () => {
    const handler = makeHandler();
    const rest = { ...basePayload, workspace_id: undefined };
    const resolved = await handler.resolveConnection(makeRequest(rest));
    expect(resolved).toBeNull();
  });
});

describe('createPlaneWebhookHandler: normalize', () => {
  it('normalizes a workitem.created event', async () => {
    const handler = makeHandler();
    const events = await handler.normalize(
      makeRequest(basePayload, { 'x-plane-event': 'workitem.created' }),
    );
    expect(events).toEqual([
      {
        type: 'projectmanagement.issue.created',
        aggregateId: 'item-1',
        payload: {
          externalId: 'item-1',
          key: null,
          title: 'Test',
          statusClass: 'open',
          assigneeExternalId: null,
          projectExternalId: null,
          url: null,
          updatedAt: null,
        },
      },
    ]);
  });

  it('derives completed status from completed_at and treats "None" as null', async () => {
    const handler = makeHandler();
    const payload = {
      ...basePayload,
      event: 'workitem.updated',
      data: {
        id: 'item-1',
        name: 'Done item',
        project_id: 'proj-1',
        assignee_ids: ['user-9'],
        completed_at: '2026-03-31T11:44:41.249304+00:00',
        updated_at: '2026-03-31T11:44:41.249304+00:00',
      },
    };
    const events = await handler.normalize(
      makeRequest(payload, { 'x-plane-event': 'workitem.updated' }),
    );
    expect(events[0]?.payload).toMatchObject({
      statusClass: 'completed',
      assigneeExternalId: 'user-9',
      projectExternalId: 'proj-1',
      updatedAt: '2026-03-31T11:44:41.249304+00:00',
    });
  });

  it('normalizes a workitem.updated event', async () => {
    const handler = makeHandler();
    const events = await handler.normalize(
      makeRequest(
        { ...basePayload, event: 'workitem.updated' },
        { 'x-plane-event': 'workitem.updated' },
      ),
    );
    expect(events[0]?.type).toBe('projectmanagement.issue.updated');
  });

  it('normalizes a workitem.comment.created event', async () => {
    const handler = makeHandler();
    const events = await handler.normalize(
      makeRequest(
        { ...basePayload, event: 'workitem.comment.created' },
        { 'x-plane-event': 'workitem.comment.created' },
      ),
    );
    expect(events[0]?.type).toBe('projectmanagement.issue.comment_created');
  });

  it('falls back to the payload event field when the header is absent', async () => {
    const handler = makeHandler();
    const events = await handler.normalize(makeRequest(basePayload));
    expect(events[0]?.type).toBe('projectmanagement.issue.created');
  });

  it('returns an empty array for an unrecognized event name', async () => {
    const handler = makeHandler();
    const events = await handler.normalize(
      makeRequest(
        { ...basePayload, event: 'project.created' },
        { 'x-plane-event': 'project.created' },
      ),
    );
    expect(events).toEqual([]);
  });
});
