import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser, findUserByGithubId, findUserById, touchLastLogin } from '../users.dal';
import type { UserId } from '@devflow/types';

describe('users dal', () => {
  let app: FastifyInstance;
  const createdUserIds: UserId[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    for (const id of createdUserIds.splice(0)) {
      await app.db.delete(schema.users).where(eq(schema.users.id, id));
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a user and finds it by githubId and id', async () => {
    const githubId = `dal-test-${crypto.randomUUID()}`;
    const user = await createUser(app.db, {
      githubId,
      email: `${githubId}@example.test`,
      name: 'Ada Lovelace',
      avatarUrl: null,
    });
    createdUserIds.push(user.id as UserId);

    const byGithubId = await findUserByGithubId(app.db, githubId);
    expect(byGithubId?.id).toBe(user.id);

    const byId = await findUserById(app.db, user.id as UserId);
    expect(byId?.email).toBe(user.email);
  });

  it('returns undefined for an unknown githubId', async () => {
    const result = await findUserByGithubId(app.db, `unknown-${crypto.randomUUID()}`);
    expect(result).toBeUndefined();
  });

  it('touchLastLogin sets lastLoginAt', async () => {
    const githubId = `dal-test-${crypto.randomUUID()}`;
    const user = await createUser(app.db, {
      githubId,
      email: `${githubId}@example.test`,
    });
    createdUserIds.push(user.id as UserId);
    expect(user.lastLoginAt).toBeNull();

    await touchLastLogin(app.db, user.id as UserId);

    const updated = await findUserById(app.db, user.id as UserId);
    expect(updated?.lastLoginAt).not.toBeNull();
  });
});
