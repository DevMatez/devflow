import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import type { WebhookHandler } from '@devflow/integrations-core';
import { buildApp } from '../../app';
import { webhookHandlers } from '../../modules/integrations/webhook-handlers';
import {
  insertWebhookEvent,
  attachConnection,
} from '../../modules/integrations/dal/webhook-events.dal';

describe('webhook relay plugin', () => {
  let app: FastifyInstance;
  const createdWebhookRowIds: string[] = [];
  const createdOutboxIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    delete webhookHandlers.github;
    for (const id of createdOutboxIds.splice(0)) {
      await app.db.delete(schema.outboxEvents).where(eq(schema.outboxEvents.id, id));
    }
    for (const id of createdWebhookRowIds.splice(0)) {
      await app.db.delete(schema.webhookEvents).where(eq(schema.webhookEvents.id, id));
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('normalizes a resolved, claimed row and publishes its events to the outbox', async () => {
    const organizationId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();

    const row = await insertWebhookEvent(app.db, {
      provider: 'github',
      providerDeliveryId: crypto.randomUUID(),
      eventType: 'pull_request',
      payload: { action: 'opened', number: 7 },
    });
    createdWebhookRowIds.push(row!.id);
    await attachConnection(app.db, row!.id, { organizationId, connectionId });

    const handler: WebhookHandler = {
      verify: async () => {},
      extractDeliveryId: () => 'unused',
      resolveConnection: async () => null,
      normalize: async () => [
        {
          type: 'sourcecontrol.pull_request.opened',
          aggregateId: crypto.randomUUID(),
          payload: { number: 7 },
        },
      ],
    };
    webhookHandlers.github = handler;

    const result = await app.runWebhookRelayOnce();
    expect(result.claimed).toBeGreaterThanOrEqual(1);
    expect(result.processed).toBeGreaterThanOrEqual(1);

    const processedRow = await app.db.query.webhookEvents.findFirst({
      where: eq(schema.webhookEvents.id, row!.id),
    });
    expect(processedRow?.processedAt).not.toBeNull();

    const outboxRow = await app.db.query.outboxEvents.findFirst({
      where: eq(schema.outboxEvents.organizationId, organizationId),
    });
    expect(outboxRow).toBeDefined();
    createdOutboxIds.push(outboxRow!.id);
    expect(outboxRow?.type).toBe('sourcecontrol.pull_request.opened');
  });

  it('records a failed attempt and leaves the row unprocessed when normalize() throws', async () => {
    const organizationId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();

    const row = await insertWebhookEvent(app.db, {
      provider: 'github',
      providerDeliveryId: crypto.randomUUID(),
      eventType: 'pull_request',
      payload: {},
    });
    createdWebhookRowIds.push(row!.id);
    await attachConnection(app.db, row!.id, { organizationId, connectionId });

    webhookHandlers.github = {
      verify: async () => {},
      extractDeliveryId: () => 'unused',
      resolveConnection: async () => null,
      normalize: async () => {
        throw new Error('normalize failed');
      },
    };

    await app.runWebhookRelayOnce();

    const found = await app.db.query.webhookEvents.findFirst({
      where: eq(schema.webhookEvents.id, row!.id),
    });
    expect(found?.processedAt).toBeNull();
    expect(found?.processingAttempts).toBeGreaterThanOrEqual(1);
    expect(found?.lastError).toBe('normalize failed');
  });
});
