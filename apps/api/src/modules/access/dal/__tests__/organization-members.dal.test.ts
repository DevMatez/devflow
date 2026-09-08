import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import { findMembership } from '../organization-members.dal';
import type { OrganizationId, UserId } from '@devflow/types';

describe('access: organization-members dal', () => {
  let app: FastifyInstance;
  let organizationId: OrganizationId;
  let userId: UserId;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const githubId = `access-dal-test-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    userId = user.id as UserId;

    const [org] = await app.db
      .insert(schema.organizations)
      .values({ name: 'Access DAL Test Org', slug: `access-dal-test-${crypto.randomUUID()}` })
      .returning();
    organizationId = org!.id as OrganizationId;
    await app.db
      .insert(schema.organizationMembers)
      .values({ organizationId, userId, role: 'admin' });
  });

  afterAll(async () => {
    await app.db.delete(schema.organizations).where(eq(schema.organizations.id, organizationId));
    await app.db.delete(schema.users).where(eq(schema.users.id, userId));
    await app.close();
  });

  it('finds an existing membership with its role', async () => {
    const membership = await findMembership(app.db, organizationId, userId);
    expect(membership?.role).toBe('admin');
  });

  it('returns undefined when the user has no membership in the org', async () => {
    const membership = await findMembership(app.db, organizationId, crypto.randomUUID() as UserId);
    expect(membership).toBeUndefined();
  });
});
