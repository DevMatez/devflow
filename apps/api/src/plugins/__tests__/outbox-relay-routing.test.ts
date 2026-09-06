import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createDatabase,
  closeDatabase,
  runMigrations,
  schema,
  type Database,
} from '@devflow/database';
import { relayOutboxOnce, type EventRoute } from '@devflow/events';
import { env } from '../../config/env';

/**
 * Runs against a dedicated, throwaway database so the relay's claim/mark
 * behavior is deterministic — the shared dev DB has other suites' relays
 * churning the outbox in parallel, which would race these assertions.
 */
describe('outbox relay routing', () => {
  let admin: Database;
  let db: Database;
  const dbName = `relaytest_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    admin = createDatabase(env.DATABASE_URL);
    await admin.execute(sql.raw(`CREATE DATABASE ${dbName}`));
    db = createDatabase(env.DATABASE_URL.replace(/\/[^/]+$/, `/${dbName}`));
    await runMigrations(db);
  });

  afterAll(async () => {
    await closeDatabase(db);
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${dbName}`));
    await closeDatabase(admin);
  });

  async function insertOutbox(type: string): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(schema.outboxEvents).values({
      id,
      type,
      organizationId: crypto.randomUUID(),
      aggregateId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      occurredAt: new Date(),
      schemaVersion: 1,
      payload: { hello: 'world' },
    });
    return id;
  }

  function fakeRoute(eventType: string, name: string): EventRoute {
    return { eventType, name, enqueue: vi.fn().mockResolvedValue(undefined) };
  }

  function rowById(id: string) {
    return db.query.outboxEvents.findFirst({ where: eq(schema.outboxEvents.id, id) });
  }

  it('fans one event type out to every matching route and marks it relayed', async () => {
    const type = 'test.fanout';
    const id = await insertOutbox(type);
    const routeA = fakeRoute(type, 'a');
    const routeB = fakeRoute(type, 'b');

    const result = await relayOutboxOnce({ db, routes: [routeA, routeB], relayId: 'test' });

    expect(routeA.enqueue).toHaveBeenCalledTimes(1);
    expect(routeB.enqueue).toHaveBeenCalledTimes(1);
    expect(result.relayed).toBe(1);
    expect((await rowById(id))?.relayedAt).not.toBeNull();
  });

  it('acknowledges an intentionally-ignored type without enqueuing', async () => {
    const type = 'test.ignored';
    const id = await insertOutbox(type);
    const route = fakeRoute(type, 'never');

    const result = await relayOutboxOnce({
      db,
      routes: [route],
      relayId: 'test',
      ignoredEventTypes: [type],
    });

    expect(route.enqueue).not.toHaveBeenCalled();
    expect(result.ignored).toBe(1);
    expect((await rowById(id))?.relayedAt).not.toBeNull();
  });

  it('dead-letters an unknown type (no route, not ignored)', async () => {
    const id = await insertOutbox('test.unknown');

    await relayOutboxOnce({ db, routes: [], relayId: 'test' });

    const row = await rowById(id);
    expect(row?.relayedAt).toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('No route registered');
  });
});
