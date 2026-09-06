import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { schema, createDatabase, closeDatabase, type Database } from '@devflow/database';
import { eq, isNull, inArray } from 'drizzle-orm';
import { relayOutboxOnce, type EventRoute } from '@devflow/events';
import { env } from '../../config/env';

// A synthetic type no production route ever registers -- keeps this test isolated from any
// real background outbox relay that other concurrently-running test files' app instances may
// have live against the same shared test database.
const FIXTURE_TYPE = 'test.__relay_fixture__';

describe('relayOutboxOnce', () => {
  let db: Database;
  let leasedOutIds: string[] = [];
  const createdOutboxIds: string[] = [];

  beforeAll(async () => {
    db = createDatabase(env.DATABASE_URL);

    // This shared test database accumulates pending rows over time from event types with no
    // registered route (e.g. organization.created) -- they'd otherwise crowd out our fixture
    // rows in the claim query's LIMIT. Lease them all out for the duration of this suite so
    // they're temporarily ineligible, then restore them in afterAll.
    const pending = await db
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(isNull(schema.outboxEvents.relayedAt));
    leasedOutIds = pending.map((row) => row.id);
    if (leasedOutIds.length > 0) {
      await db
        .update(schema.outboxEvents)
        .set({ claimExpiresAt: new Date(Date.now() + 60 * 60 * 1000) })
        .where(inArray(schema.outboxEvents.id, leasedOutIds));
    }
  });

  afterEach(async () => {
    for (const id of createdOutboxIds.splice(0)) {
      await db.delete(schema.outboxEvents).where(eq(schema.outboxEvents.id, id));
    }
  });

  afterAll(async () => {
    if (leasedOutIds.length > 0) {
      await db
        .update(schema.outboxEvents)
        .set({ claimExpiresAt: null })
        .where(inArray(schema.outboxEvents.id, leasedOutIds));
    }
    await closeDatabase(db);
  });

  async function seedFixture(): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(schema.outboxEvents).values({
      id,
      type: FIXTURE_TYPE,
      organizationId: crypto.randomUUID(),
      aggregateId: crypto.randomUUID(),
      correlationId: crypto.randomUUID(),
      payload: { message: 'test' },
      schemaVersion: 1,
      occurredAt: new Date(),
    });
    createdOutboxIds.push(id);
    return id;
  }

  it('stops reclaiming a row once it has hit maxAttempts (dead-lettered in place)', async () => {
    const id = await seedFixture();
    // leaseMs: 0 -- each call's claim expires immediately, so successive calls in this test
    // simulate successive relay cycles instead of hitting the (still-active) lease from the
    // previous call.
    const opts = { db, routes: [], relayId: 'test-relay', maxAttempts: 2, leaseMs: 0 };

    // No route registered for the fixture type -- every cycle increments attempts.
    await relayOutboxOnce(opts);
    await relayOutboxOnce(opts);

    let row = await db.query.outboxEvents.findFirst({ where: eq(schema.outboxEvents.id, id) });
    expect(row?.attempts).toBe(2);

    // A third cycle must not claim (and therefore not increment) this row anymore -- it has
    // hit maxAttempts, so it's excluded from the claim query regardless of batch size.
    await relayOutboxOnce(opts);

    row = await db.query.outboxEvents.findFirst({ where: eq(schema.outboxEvents.id, id) });
    expect(row?.attempts).toBe(2);
    expect(row?.relayedAt).toBeNull();
  });

  it('records a non-Error throw as a string, not "undefined"', async () => {
    const id = await seedFixture();
    const route: EventRoute = {
      eventType: FIXTURE_TYPE,
      name: 'test-throws-string',
      enqueue: () => {
        throw 'plain string failure';
      },
    };

    await relayOutboxOnce({ db, routes: [route], relayId: 'test-relay' });

    const row = await db.query.outboxEvents.findFirst({ where: eq(schema.outboxEvents.id, id) });
    expect(row?.lastError).toBe('plain string failure');
    expect(row?.attempts).toBe(1);
  });
});
