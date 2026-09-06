import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import type { WebhookHandler } from '@devflow/integrations-core';
import type { OrganizationId } from '@devflow/types';
import { buildApp } from '../../../../app';
import { webhookHandlers } from '../../../../modules/integrations/webhook-handlers';

function makeHandler(overrides: Partial<WebhookHandler> = {}): WebhookHandler {
  return {
    verify: async () => {},
    extractDeliveryId: () => crypto.randomUUID(),
    resolveConnection: async () => null,
    normalize: async () => [],
    ...overrides,
  };
}

describe('webhooks route', () => {
  let app: FastifyInstance;
  const createdRowIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    delete webhookHandlers.github;
    delete webhookHandlers.slack;
    for (const id of createdRowIds.splice(0)) {
      await app.db.delete(schema.webhookEvents).where(eq(schema.webhookEvents.id, id));
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unknown provider path segment', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/bogus-vendor',
      payload: { hello: 'world' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 for a known provider with no registered handler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/calendar',
      payload: { hello: 'world' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('responds to the Slack url_verification handshake without touching dedupe/persistence', async () => {
    webhookHandlers.slack = makeHandler({
      extractDeliveryId: () => {
        throw new Error('should not be called for a url_verification payload');
      },
    });
    const challenge = 'test-challenge-value';

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/slack',
      payload: { type: 'url_verification', challenge },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ challenge });
  });

  it('returns 401 when signature verification fails', async () => {
    webhookHandlers.github = makeHandler({
      verify: async () => {
        throw new Error('bad signature');
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      payload: { hello: 'world' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('records the delivery and acks 200 when no connection resolves yet', async () => {
    const deliveryId = crypto.randomUUID();
    webhookHandlers.github = makeHandler({
      extractDeliveryId: () => deliveryId,
      resolveConnection: async () => null,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: { 'x-github-event': 'pull_request' },
      payload: { action: 'opened' },
    });
    expect(res.statusCode).toBe(200);

    const row = await app.db.query.webhookEvents.findFirst({
      where: eq(schema.webhookEvents.providerDeliveryId, deliveryId),
    });
    expect(row).toBeDefined();
    createdRowIds.push(row!.id);
    expect(row?.eventType).toBe('pull_request');
    expect(row?.organizationId).toBeNull();
  });

  it('attaches the resolved connection when the handler finds one', async () => {
    const deliveryId = crypto.randomUUID();
    const organizationId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    webhookHandlers.github = makeHandler({
      extractDeliveryId: () => deliveryId,
      resolveConnection: async () => ({
        organizationId: organizationId as OrganizationId,
        connectionId,
      }),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: { 'x-github-event': 'pull_request' },
      payload: { action: 'opened' },
    });
    expect(res.statusCode).toBe(200);

    const row = await app.db.query.webhookEvents.findFirst({
      where: eq(schema.webhookEvents.providerDeliveryId, deliveryId),
    });
    createdRowIds.push(row!.id);
    expect(row?.organizationId).toBe(organizationId);
    expect(row?.connectionId).toBe(connectionId);
  });

  it('no-ops on a duplicate delivery instead of inserting a second row', async () => {
    const deliveryId = crypto.randomUUID();
    webhookHandlers.github = makeHandler({ extractDeliveryId: () => deliveryId });

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: { 'x-github-event': 'pull_request' },
      payload: { action: 'opened' },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/webhooks/github',
      headers: { 'x-github-event': 'pull_request' },
      payload: { action: 'opened' },
    });
    expect(second.statusCode).toBe(200);

    const rows = await app.db.query.webhookEvents.findMany({
      where: eq(schema.webhookEvents.providerDeliveryId, deliveryId),
    });
    expect(rows).toHaveLength(1);
    createdRowIds.push(rows[0]!.id);
  });
});
