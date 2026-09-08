import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import {
  createOrganization,
  deleteOrganizationById,
  findOrganizationById,
  listOrganizationsForUser,
  updateOrganization,
} from '../organizations.dal';
import { addMember } from '../members.dal';
import type { OrganizationId, UserId } from '@devflow/types';

describe('organizations dal', () => {
  let app: FastifyInstance;
  let userId: UserId;
  const createdOrgIds: OrganizationId[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const githubId = `orgs-dal-test-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    userId = user.id as UserId;
  });

  afterEach(async () => {
    for (const id of createdOrgIds.splice(0)) {
      await deleteOrganizationById(app.db, id);
    }
  });

  afterAll(async () => {
    await app.db.delete(schema.users).where(eq(schema.users.id, userId));
    await app.close();
  });

  it('creates an organization inside a transaction', async () => {
    const org = await app.db.transaction((tx) =>
      createOrganization(tx, { name: 'DAL Test Org', slug: `dal-test-org-${crypto.randomUUID()}` }),
    );
    createdOrgIds.push(org.id as OrganizationId);

    const found = await findOrganizationById(app.db, org.id as OrganizationId);
    expect(found?.name).toBe('DAL Test Org');
  });

  it('updates name and slug', async () => {
    const org = await app.db.transaction((tx) =>
      createOrganization(tx, { name: 'Old Name', slug: `dal-update-${crypto.randomUUID()}` }),
    );
    createdOrgIds.push(org.id as OrganizationId);

    const updated = await updateOrganization(app.db, org.id as OrganizationId, {
      name: 'New Name',
    });
    expect(updated.name).toBe('New Name');
    expect(updated.slug).toBe(org.slug);
  });

  it('lists organizations the user belongs to via membership', async () => {
    const org = await app.db.transaction((tx) =>
      createOrganization(tx, { name: 'Listed Org', slug: `dal-list-${crypto.randomUUID()}` }),
    );
    createdOrgIds.push(org.id as OrganizationId);
    await app.db.transaction((tx) =>
      addMember(tx, { organizationId: org.id as OrganizationId, userId, role: 'owner' }),
    );

    const orgs = await listOrganizationsForUser(app.db, userId);
    expect(orgs.some((o) => o.id === org.id)).toBe(true);
  });

  it('deleting an organization cascades to its memberships', async () => {
    const org = await app.db.transaction((tx) =>
      createOrganization(tx, { name: 'Cascade Org', slug: `dal-cascade-${crypto.randomUUID()}` }),
    );
    await app.db.transaction((tx) =>
      addMember(tx, { organizationId: org.id as OrganizationId, userId, role: 'owner' }),
    );

    await deleteOrganizationById(app.db, org.id as OrganizationId);

    const remainingMembership = await app.db.query.organizationMembers.findFirst({
      where: eq(schema.organizationMembers.organizationId, org.id),
    });
    expect(remainingMembership).toBeUndefined();
  });
});
