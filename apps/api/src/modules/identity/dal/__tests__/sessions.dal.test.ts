import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../users.dal';
import {
  createSession,
  findSessionByTokenHash,
  refreshSessionExpiry,
  deleteSession,
} from '../sessions.dal';
import type { UserId, SessionId } from '@devflow/types';

describe('sessions dal', () => {
  let app: FastifyInstance;
  let userId: UserId;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const githubId = `sessions-dal-test-${crypto.randomUUID()}`;
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

  it('creates a session and finds it by token hash', async () => {
    const tokenHash = `hash-${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60);
    const session = await createSession(app.db, { userId, tokenHash, expiresAt });

    const found = await findSessionByTokenHash(app.db, tokenHash);
    expect(found?.id).toBe(session.id);
    expect(found?.userId).toBe(userId);
  });

  it('returns undefined for an unknown token hash', async () => {
    const result = await findSessionByTokenHash(app.db, `unknown-${crypto.randomUUID()}`);
    expect(result).toBeUndefined();
  });

  it('refreshSessionExpiry updates expiresAt', async () => {
    const tokenHash = `hash-${crypto.randomUUID()}`;
    const originalExpiresAt = new Date(Date.now() + 1000 * 60 * 60);
    const session = await createSession(app.db, {
      userId,
      tokenHash,
      expiresAt: originalExpiresAt,
    });

    const newExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
    await refreshSessionExpiry(app.db, session.id as SessionId, newExpiresAt);

    const found = await findSessionByTokenHash(app.db, tokenHash);
    expect(found?.expiresAt.getTime()).toBe(newExpiresAt.getTime());
  });

  it('deleteSession removes the row', async () => {
    const tokenHash = `hash-${crypto.randomUUID()}`;
    const session = await createSession(app.db, {
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    });

    await deleteSession(app.db, session.id as SessionId);

    const found = await findSessionByTokenHash(app.db, tokenHash);
    expect(found).toBeUndefined();
  });
});
