import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import { createOrganization, deleteOrganizationById } from '../organizations.dal';
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  findTeamById,
  listTeamMembers,
  listTeams,
  removeTeamMember,
  updateTeam,
} from '../teams.dal';
import type { OrganizationId, UserId } from '@devflow/types';

describe('teams dal', () => {
  let app: FastifyInstance;
  let organizationId: OrganizationId;
  let otherOrganizationId: OrganizationId;
  let userId: UserId;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const githubId = `teams-dal-test-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    userId = user.id as UserId;

    const org = await app.db.transaction((tx) =>
      createOrganization(tx, { name: 'Teams DAL Org', slug: `teams-dal-${crypto.randomUUID()}` }),
    );
    organizationId = org.id as OrganizationId;

    const otherOrg = await app.db.transaction((tx) =>
      createOrganization(tx, { name: 'Other Org', slug: `teams-dal-other-${crypto.randomUUID()}` }),
    );
    otherOrganizationId = otherOrg.id as OrganizationId;
  });

  afterAll(async () => {
    await deleteOrganizationById(app.db, organizationId);
    await deleteOrganizationById(app.db, otherOrganizationId);
    await app.db.delete(schema.users).where(eq(schema.users.id, userId));
    await app.close();
  });

  it('creates a team, lists it, and finds it by (org, id)', async () => {
    const team = await app.db.transaction((tx) =>
      createTeam(tx, { organizationId, name: 'Platform', slug: 'platform' }),
    );

    const found = await findTeamById(app.db, organizationId, team.id);
    expect(found?.name).toBe('Platform');

    const teams = await listTeams(app.db, organizationId);
    expect(teams.some((t) => t.id === team.id)).toBe(true);
  });

  it('does not find a team scoped to a different org', async () => {
    const team = await app.db.transaction((tx) =>
      createTeam(tx, { organizationId, name: 'Cross Org', slug: 'cross-org' }),
    );

    const found = await findTeamById(app.db, otherOrganizationId, team.id);
    expect(found).toBeUndefined();
  });

  it('updates a team', async () => {
    const team = await app.db.transaction((tx) =>
      createTeam(tx, { organizationId, name: 'Before', slug: 'before-slug' }),
    );

    const updated = await app.db.transaction((tx) =>
      updateTeam(tx, organizationId, team.id, { name: 'After' }),
    );
    expect(updated.name).toBe('After');
  });

  it('adds, lists, and removes a team member', async () => {
    const team = await app.db.transaction((tx) =>
      createTeam(tx, { organizationId, name: 'Membership Team', slug: 'membership-team' }),
    );

    await app.db.transaction((tx) => addTeamMember(tx, team.id, userId));
    const members = await listTeamMembers(app.db, team.id);
    expect(members).toHaveLength(1);
    expect(members[0]?.userId).toBe(userId);

    await app.db.transaction((tx) => removeTeamMember(tx, team.id, userId));
    const afterRemoval = await listTeamMembers(app.db, team.id);
    expect(afterRemoval).toHaveLength(0);
  });

  it('deleting a team cascades to team_members', async () => {
    const team = await app.db.transaction((tx) =>
      createTeam(tx, { organizationId, name: 'Delete Me', slug: 'delete-me' }),
    );
    await app.db.transaction((tx) => addTeamMember(tx, team.id, userId));

    await app.db.transaction((tx) => deleteTeam(tx, organizationId, team.id));

    const remaining = await app.db.query.teamMembers.findFirst({
      where: eq(schema.teamMembers.teamId, team.id),
    });
    expect(remaining).toBeUndefined();
  });
});
