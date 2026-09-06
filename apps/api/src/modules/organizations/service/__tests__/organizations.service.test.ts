import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import { addMember } from '../../dal/members.dal';
import {
  changeMemberRole,
  createOrganization,
  deleteOrganization,
  getOrganization,
  LastOwnerError,
  listMembers,
  listOrganizationsForUser,
  MemberNotFoundError,
  removeMember,
  SelfTransferError,
  transferOwnership,
  updateOrganizationSettings,
} from '../organizations.service';
import type { OrgContext } from '../../../access/org-context';
import type { OrganizationId, UserId } from '@devflow/types';

async function createTestUser(app: FastifyInstance, label: string): Promise<UserId> {
  const githubId = `${label}-${crypto.randomUUID()}`;
  const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
  return user.id as UserId;
}

describe('organizations service', () => {
  let app: FastifyInstance;
  const createdUserIds: UserId[] = [];
  const createdOrgIds: OrganizationId[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    for (const id of createdOrgIds.splice(0)) {
      await app.db.delete(schema.organizations).where(eq(schema.organizations.id, id));
    }
  });

  afterAll(async () => {
    for (const id of createdUserIds.splice(0)) {
      await app.db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await app.close();
  });

  async function makeUser(label: string): Promise<UserId> {
    const id = await createTestUser(app, label);
    createdUserIds.push(id);
    return id;
  }

  it('creates an organization with the creator as owner and derives the slug from the name', async () => {
    const userId = await makeUser('create-org');

    const org = await createOrganization(app.db, {
      name: 'Acme Engineering',
      userId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);

    expect(org.slug).toBe('acme-engineering');

    const ctx: OrgContext = { organizationId: org.id as OrganizationId, userId, role: 'owner' };
    const members = await listMembers(app.db, ctx);
    expect(members).toHaveLength(1);
    expect(members[0]?.role).toBe('owner');

    const orgs = await listOrganizationsForUser(app.db, userId);
    expect(orgs.some((o) => o.id === org.id)).toBe(true);
  });

  it('respects a client-supplied slug', async () => {
    const userId = await makeUser('create-org-slug');
    const org = await createOrganization(app.db, {
      name: 'Custom',
      slug: 'my-custom-slug',
      userId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    expect(org.slug).toBe('my-custom-slug');
  });

  it('gets and updates organization settings', async () => {
    const userId = await makeUser('update-org');
    const org = await createOrganization(app.db, {
      name: 'Old Name',
      userId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    const ctx: OrgContext = { organizationId: org.id as OrganizationId, userId, role: 'owner' };

    const fetched = await getOrganization(app.db, ctx);
    expect(fetched?.name).toBe('Old Name');

    const updated = await updateOrganizationSettings(app.db, ctx, {
      name: 'New Name',
      correlationId: crypto.randomUUID(),
    });
    expect(updated.name).toBe('New Name');
  });

  it('changes a member role when it would not remove the last owner', async () => {
    const ownerId = await makeUser('change-role-owner');
    const memberId = await makeUser('change-role-member');
    const org = await createOrganization(app.db, {
      name: 'Role Change Org',
      userId: ownerId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    const organizationId = org.id as OrganizationId;
    await app.db.transaction((tx) =>
      addMember(tx, { organizationId, userId: memberId, role: 'viewer' }),
    );

    const ctx: OrgContext = { organizationId, userId: ownerId, role: 'owner' };
    await changeMemberRole(app.db, ctx, memberId, 'developer', crypto.randomUUID());

    const members = await listMembers(app.db, ctx);
    expect(members.find((m) => m.userId === memberId)?.role).toBe('developer');
  });

  it('throws MemberNotFoundError for an unknown target', async () => {
    const ownerId = await makeUser('not-found-owner');
    const org = await createOrganization(app.db, {
      name: 'Not Found Org',
      userId: ownerId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    const ctx: OrgContext = {
      organizationId: org.id as OrganizationId,
      userId: ownerId,
      role: 'owner',
    };

    await expect(
      changeMemberRole(app.db, ctx, crypto.randomUUID() as UserId, 'admin', crypto.randomUUID()),
    ).rejects.toThrow(MemberNotFoundError);
  });

  it('blocks demoting the last owner', async () => {
    const ownerId = await makeUser('last-owner-demote');
    const org = await createOrganization(app.db, {
      name: 'Last Owner Org',
      userId: ownerId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    const ctx: OrgContext = {
      organizationId: org.id as OrganizationId,
      userId: ownerId,
      role: 'owner',
    };

    await expect(
      changeMemberRole(app.db, ctx, ownerId, 'admin', crypto.randomUUID()),
    ).rejects.toThrow(LastOwnerError);
  });

  it('blocks removing the last owner, but allows removal once a second owner exists', async () => {
    const ownerId = await makeUser('remove-last-owner');
    const secondOwnerId = await makeUser('remove-second-owner');
    const org = await createOrganization(app.db, {
      name: 'Remove Owner Org',
      userId: ownerId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    const organizationId = org.id as OrganizationId;
    const ctx: OrgContext = { organizationId, userId: ownerId, role: 'owner' };

    await expect(removeMember(app.db, ctx, ownerId, crypto.randomUUID())).rejects.toThrow(
      LastOwnerError,
    );

    await app.db.transaction((tx) =>
      addMember(tx, { organizationId, userId: secondOwnerId, role: 'owner' }),
    );
    await removeMember(app.db, ctx, ownerId, crypto.randomUUID());

    const members = await listMembers(app.db, ctx);
    expect(members.some((m) => m.userId === ownerId)).toBe(false);
  });

  it('transfers ownership, promoting the target and demoting the caller', async () => {
    const ownerId = await makeUser('transfer-owner');
    const targetId = await makeUser('transfer-target');
    const org = await createOrganization(app.db, {
      name: 'Transfer Org',
      userId: ownerId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    const organizationId = org.id as OrganizationId;
    await app.db.transaction((tx) =>
      addMember(tx, { organizationId, userId: targetId, role: 'admin' }),
    );

    const ctx: OrgContext = { organizationId, userId: ownerId, role: 'owner' };
    await transferOwnership(app.db, ctx, targetId, crypto.randomUUID());

    const members = await listMembers(app.db, ctx);
    expect(members.find((m) => m.userId === targetId)?.role).toBe('owner');
    expect(members.find((m) => m.userId === ownerId)?.role).toBe('admin');
  });

  it('rejects transferring ownership to yourself', async () => {
    const ownerId = await makeUser('self-transfer-owner');
    const org = await createOrganization(app.db, {
      name: 'Self Transfer Org',
      userId: ownerId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    const organizationId = org.id as OrganizationId;
    const ctx: OrgContext = { organizationId, userId: ownerId, role: 'owner' };

    await expect(transferOwnership(app.db, ctx, ownerId, crypto.randomUUID())).rejects.toThrow(
      SelfTransferError,
    );

    // Role must be unchanged — the rejected call must not have partially applied.
    const members = await listMembers(app.db, ctx);
    expect(members.find((m) => m.userId === ownerId)?.role).toBe('owner');
  });

  it('deletes an organization', async () => {
    const ownerId = await makeUser('delete-org-owner');
    const org = await createOrganization(app.db, {
      name: 'To Delete',
      userId: ownerId,
      correlationId: crypto.randomUUID(),
    });
    const organizationId = org.id as OrganizationId;
    const ctx: OrgContext = { organizationId, userId: ownerId, role: 'owner' };

    await deleteOrganization(app.db, ctx);

    const found = await getOrganization(app.db, ctx);
    expect(found).toBeUndefined();
  });

  it('concurrent remove-vs-remove on a 2-owner org never drops below one owner', async () => {
    const ownerAId = await makeUser('concurrent-remove-a');
    const ownerBId = await makeUser('concurrent-remove-b');
    const org = await createOrganization(app.db, {
      name: 'Concurrency Remove Org',
      userId: ownerAId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    const organizationId = org.id as OrganizationId;
    await app.db.transaction((tx) =>
      addMember(tx, { organizationId, userId: ownerBId, role: 'owner' }),
    );

    const ctx: OrgContext = { organizationId, userId: ownerAId, role: 'owner' };

    const results = await Promise.allSettled([
      removeMember(app.db, ctx, ownerAId, crypto.randomUUID()),
      removeMember(app.db, ctx, ownerBId, crypto.randomUUID()),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(LastOwnerError);

    const remainingMembers = await listMembers(app.db, ctx);
    const remainingOwners = remainingMembers.filter((m) => m.role === 'owner');
    expect(remainingOwners).toHaveLength(1);
  });

  it('concurrent remove-vs-transfer on a 2-owner org never drops below one owner', async () => {
    const ownerAId = await makeUser('concurrent-transfer-a');
    const ownerBId = await makeUser('concurrent-transfer-b');
    const org = await createOrganization(app.db, {
      name: 'Concurrency Transfer Org',
      userId: ownerAId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    const organizationId = org.id as OrganizationId;
    await app.db.transaction((tx) =>
      addMember(tx, { organizationId, userId: ownerBId, role: 'owner' }),
    );

    const ctxA: OrgContext = { organizationId, userId: ownerAId, role: 'owner' };
    const ctxB: OrgContext = { organizationId, userId: ownerBId, role: 'owner' };

    await Promise.allSettled([
      removeMember(app.db, ctxA, ownerAId, crypto.randomUUID()),
      transferOwnership(app.db, ctxB, ownerAId, crypto.randomUUID()),
    ]);

    const remainingMembers = await listMembers(app.db, ctxA);
    const remainingOwners = remainingMembers.filter((m) => m.role === 'owner');
    expect(remainingOwners.length).toBeGreaterThanOrEqual(1);
  });
});
