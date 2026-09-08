import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import { createOrganization, deleteOrganizationById } from '../organizations.dal';
import {
  addMember,
  findMembership,
  listMembers,
  lockOrganizationMembers,
  removeMember,
  updateMemberRole,
} from '../members.dal';
import type { OrganizationId, UserId } from '@devflow/types';

describe('members dal', () => {
  let app: FastifyInstance;
  let organizationId: OrganizationId;
  let userId: UserId;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const githubId = `members-dal-test-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    userId = user.id as UserId;

    const org = await app.db.transaction((tx) =>
      createOrganization(tx, {
        name: 'Members DAL Org',
        slug: `members-dal-${crypto.randomUUID()}`,
      }),
    );
    organizationId = org.id as OrganizationId;
  });

  afterAll(async () => {
    await deleteOrganizationById(app.db, organizationId);
    await app.db.delete(schema.users).where(eq(schema.users.id, userId));
    await app.close();
  });

  it('adds a member and finds their membership', async () => {
    await app.db.transaction((tx) => addMember(tx, { organizationId, userId, role: 'owner' }));

    const membership = await findMembership(app.db, organizationId, userId);
    expect(membership?.role).toBe('owner');
  });

  it('lists members joined with user details', async () => {
    const members = await listMembers(app.db, organizationId);
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(userId);
    expect(members[0]?.email).toContain('@example.test');
  });

  it('updates a member role', async () => {
    await app.db.transaction((tx) => updateMemberRole(tx, organizationId, userId, 'admin'));
    const membership = await findMembership(app.db, organizationId, userId);
    expect(membership?.role).toBe('admin');
  });

  it('locks membership rows for update inside a transaction', async () => {
    const locked = await app.db.transaction((tx) => lockOrganizationMembers(tx, organizationId));
    expect(locked).toHaveLength(1);
    expect(locked[0]?.userId).toBe(userId);
  });

  it('removes a member', async () => {
    await app.db.transaction((tx) => removeMember(tx, organizationId, userId));
    const membership = await findMembership(app.db, organizationId, userId);
    expect(membership).toBeUndefined();
  });
});
