import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../dal/users.dal';
import { createSession } from '../../dal/sessions.dal';
import {
  createUserSession,
  verifySessionToken,
  revokeSessionToken,
  hashSessionToken,
  type SessionConfig,
} from '../session.service';
import type { UserId } from '@devflow/types';

const config: SessionConfig = { ttlDays: 30, refreshThresholdDays: 7 };

describe('session service', () => {
  let app: FastifyInstance;
  let userId: UserId;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const githubId = `session-svc-test-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    userId = user.id as UserId;
  });

  afterEach(async () => {
    await app.db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
  });

  afterAll(async () => {
    await app.db.delete(schema.users).where(eq(schema.users.id, userId));
    await app.close();
  });

  it('creates a session whose stored hash matches the returned token', async () => {
    const { token, session } = await createUserSession(app.db, config, { userId });

    expect(session.tokenHash).toBe(hashSessionToken(token));
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('verifies a valid token and returns null for an unknown one', async () => {
    const { token } = await createUserSession(app.db, config, { userId });

    const verified = await verifySessionToken(app.db, config, token);
    expect(verified?.userId).toBe(userId);

    const unknown = await verifySessionToken(app.db, config, 'not-a-real-token');
    expect(unknown).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const token = 'expired-token';
    await createSession(app.db, {
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: new Date(Date.now() - 1000),
    });

    const verified = await verifySessionToken(app.db, config, token);
    expect(verified).toBeNull();
  });

  it('slides the expiry forward once under the refresh threshold', async () => {
    const token = 'near-expiry-token';
    await createSession(app.db, {
      userId,
      tokenHash: hashSessionToken(token),
      // 3 days remaining, under the 7-day refreshThresholdDays.
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3),
    });

    const verified = await verifySessionToken(app.db, config, token);
    const expectedFloor = Date.now() + 1000 * 60 * 60 * 24 * (config.ttlDays - 1);
    expect(verified?.expiresAt.getTime()).toBeGreaterThan(expectedFloor);
  });

  it('does not slide the expiry when well within the TTL', async () => {
    const token = 'fresh-token';
    const originalExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 29);
    await createSession(app.db, {
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: originalExpiresAt,
    });

    const verified = await verifySessionToken(app.db, config, token);
    expect(verified?.expiresAt.getTime()).toBe(originalExpiresAt.getTime());
  });

  it('revokeSessionToken deletes the session', async () => {
    const { token } = await createUserSession(app.db, config, { userId });

    await revokeSessionToken(app.db, token);

    const verified = await verifySessionToken(app.db, config, token);
    expect(verified).toBeNull();
  });
});
