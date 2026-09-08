import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import { createOrganization } from '../organizations.service';
import {
  addTeamMember,
  createTeam,
  deleteTeam,
  listTeamMembers,
  listTeams,
  removeTeamMember,
  TeamNotFoundError,
  updateTeam,
} from '../teams.service';
import type { OrgContext } from '../../../access/org-context';
import type { OrganizationId, UserId } from '@devflow/types';

async function makeUser(app: FastifyInstance, label: string): Promise<UserId> {
  const githubId = `${label}-${crypto.randomUUID()}`;
  const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
  return user.id as UserId;
}

describe('teams service', () => {
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

  async function makeOrgWithOwner(label: string): Promise<OrgContext> {
    const ownerId = await makeUser(app, label);
    createdUserIds.push(ownerId);
    const org = await createOrganization(app.db, {
      name: `${label} Org`,
      userId: ownerId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    return { organizationId: org.id as OrganizationId, userId: ownerId, role: 'owner' };
  }

  it('creates a team and derives the slug from the name', async () => {
    const ctx = await makeOrgWithOwner('team-create');
    const team = await createTeam(app.db, ctx, { name: 'Platform Team' });
    expect(team.slug).toBe('platform-team');

    const teams = await listTeams(app.db, ctx);
    expect(teams.some((t) => t.id === team.id)).toBe(true);
  });

  it('updates a team', async () => {
    const ctx = await makeOrgWithOwner('team-update');
    const team = await createTeam(app.db, ctx, { name: 'Before' });

    const updated = await updateTeam(app.db, ctx, team.id, { name: 'After' });
    expect(updated.name).toBe('After');
  });

  it('deletes a team', async () => {
    const ctx = await makeOrgWithOwner('team-delete');
    const team = await createTeam(app.db, ctx, { name: 'Temp' });

    await deleteTeam(app.db, ctx, team.id);

    const teams = await listTeams(app.db, ctx);
    expect(teams.some((t) => t.id === team.id)).toBe(false);
  });

  it('adds, lists, and removes a team member', async () => {
    const ctx = await makeOrgWithOwner('team-members');
    const memberId = await makeUser(app, 'team-members-member');
    createdUserIds.push(memberId);
    const team = await createTeam(app.db, ctx, { name: 'Membership' });

    await addTeamMember(app.db, ctx, team.id, memberId);
    const members = await listTeamMembers(app.db, ctx, team.id);
    expect(members.some((m) => m.userId === memberId)).toBe(true);

    await removeTeamMember(app.db, ctx, team.id, memberId);
    const afterRemoval = await listTeamMembers(app.db, ctx, team.id);
    expect(afterRemoval.some((m) => m.userId === memberId)).toBe(false);
  });

  it('rejects operations on a team that belongs to a different organization', async () => {
    const ctxA = await makeOrgWithOwner('team-cross-org-a');
    const ctxB = await makeOrgWithOwner('team-cross-org-b');
    const team = await createTeam(app.db, ctxA, { name: 'Org A Team' });

    await expect(updateTeam(app.db, ctxB, team.id, { name: 'Hijacked' })).rejects.toThrow(
      TeamNotFoundError,
    );
    await expect(listTeamMembers(app.db, ctxB, team.id)).rejects.toThrow(TeamNotFoundError);
    await expect(deleteTeam(app.db, ctxB, team.id)).rejects.toThrow(TeamNotFoundError);
  });
});
