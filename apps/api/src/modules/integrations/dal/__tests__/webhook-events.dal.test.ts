import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import {
  insertWebhookEvent,
  attachConnection,
  claimWebhookEvents,
  markWebhookEventProcessed,
  markWebhookEventFailed,
} from '../webhook-events.dal';

describe('webhook-events dal', () => {
  let app: FastifyInstance;
  const createdRowIds: string[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    for (const id of createdRowIds.splice(0)) {
      await app.db.delete(schema.webhookEvents).where(eq(schema.webhookEvents.id, id));
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('inserts a new delivery and no-ops on a duplicate (provider, providerDeliveryId)', async () => {
    const deliveryId = crypto.randomUUID();
    const row = await insertWebhookEvent(app.db, {
      provider: 'github',
      providerDeliveryId: deliveryId,
      eventType: 'pull_request',
      payload: { action: 'opened' },
    });
    expect(row).toBeDefined();
    createdRowIds.push(row!.id);

    const duplicate = await insertWebhookEvent(app.db, {
      provider: 'github',
      providerDeliveryId: deliveryId,
      eventType: 'pull_request',
      payload: { action: 'opened-again' },
    });
    expect(duplicate).toBeUndefined();
  });

  it('attaches a resolved connection', async () => {
    const row = await insertWebhookEvent(app.db, {
      provider: 'github',
      providerDeliveryId: crypto.randomUUID(),
      eventType: 'pull_request',
      payload: {},
    });
    createdRowIds.push(row!.id);

    const organizationId = crypto.randomUUID();
    const connectionId = crypto.randomUUID();
    await attachConnection(app.db, row!.id, { organizationId, connectionId });

    const found = await app.db.query.webhookEvents.findFirst({
      where: eq(schema.webhookEvents.id, row!.id),
    });
    expect(found?.organizationId).toBe(organizationId);
    expect(found?.connectionId).toBe(connectionId);
  });

  it('only claims rows with a resolved connection', async () => {
    const unresolved = await insertWebhookEvent(app.db, {
      provider: 'github',
      providerDeliveryId: crypto.randomUUID(),
      eventType: 'pull_request',
      payload: {},
    });
    createdRowIds.push(unresolved!.id);

    const resolved = await insertWebhookEvent(app.db, {
      provider: 'github',
      providerDeliveryId: crypto.randomUUID(),
      eventType: 'pull_request',
      payload: {},
    });
    createdRowIds.push(resolved!.id);
    await attachConnection(app.db, resolved!.id, {
      organizationId: crypto.randomUUID(),
      connectionId: crypto.randomUUID(),
    });

    const claimed = await claimWebhookEvents(app.db, {
      relayId: 'test-relay',
      batchSize: 20,
      leaseMs: 60_000,
    });

    const claimedIds = claimed.map((row) => row.id);
    expect(claimedIds).toContain(resolved!.id);
    expect(claimedIds).not.toContain(unresolved!.id);
  });

  it('does not re-claim a row whose lease has not expired', async () => {
    const row = await insertWebhookEvent(app.db, {
      provider: 'github',
      providerDeliveryId: crypto.randomUUID(),
      eventType: 'pull_request',
      payload: {},
    });
    createdRowIds.push(row!.id);
    await attachConnection(app.db, row!.id, {
      organizationId: crypto.randomUUID(),
      connectionId: crypto.randomUUID(),
    });

    const first = await claimWebhookEvents(app.db, {
      relayId: 'relay-a',
      batchSize: 20,
      leaseMs: 60_000,
    });
    expect(first.map((r) => r.id)).toContain(row!.id);

    const second = await claimWebhookEvents(app.db, {
      relayId: 'relay-b',
      batchSize: 20,
      leaseMs: 60_000,
    });
    expect(second.map((r) => r.id)).not.toContain(row!.id);
  });

  it('marks a row processed only after the publish callback succeeds', async () => {
    const row = await insertWebhookEvent(app.db, {
      provider: 'github',
      providerDeliveryId: crypto.randomUUID(),
      eventType: 'pull_request',
      payload: {},
    });
    createdRowIds.push(row!.id);

    await markWebhookEventProcessed(app.db, row!.id, async () => {
      // no-op publish for this test
    });

    const found = await app.db.query.webhookEvents.findFirst({
      where: eq(schema.webhookEvents.id, row!.id),
    });
    expect(found?.processedAt).not.toBeNull();
  });

  it('leaves the row unprocessed if the publish callback throws', async () => {
    const row = await insertWebhookEvent(app.db, {
      provider: 'github',
      providerDeliveryId: crypto.randomUUID(),
      eventType: 'pull_request',
      payload: {},
    });
    createdRowIds.push(row!.id);

    await expect(
      markWebhookEventProcessed(app.db, row!.id, async () => {
        throw new Error('publish failed');
      }),
    ).rejects.toThrow('publish failed');

    const found = await app.db.query.webhookEvents.findFirst({
      where: eq(schema.webhookEvents.id, row!.id),
    });
    expect(found?.processedAt).toBeNull();
  });

  it('increments processing attempts and records the error on failure', async () => {
    const row = await insertWebhookEvent(app.db, {
      provider: 'github',
      providerDeliveryId: crypto.randomUUID(),
      eventType: 'pull_request',
      payload: {},
    });
    createdRowIds.push(row!.id);

    await markWebhookEventFailed(app.db, row!.id, 'boom');
    await markWebhookEventFailed(app.db, row!.id, 'boom again');

    const found = await app.db.query.webhookEvents.findFirst({
      where: eq(schema.webhookEvents.id, row!.id),
    });
    expect(found?.processingAttempts).toBe(2);
    expect(found?.lastError).toBe('boom again');
  });
});
