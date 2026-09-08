import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../../modules/identity/dal/users.dal';
import { createUserSession } from '../../../../modules/identity/service/session.service';
import { SESSION_COOKIE_NAME } from '../../../../plugins/auth';
import type { UserId } from '@devflow/types';

async function makeAuthedUser(app: FastifyInstance, label: string) {
  const githubId = `route-org-test-${label}-${crypto.randomUUID()}`;
  const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
  const { token } = await createUserSession(
    app.db,
    { ttlDays: 30, refreshThresholdDays: 7 },
    { userId: user.id as UserId },
  );
  return { userId: user.id as UserId, cookie: `${SESSION_COOKIE_NAME}=${app.signCookie(token)}` };
}

describe('organizations routes', () => {
  let app: FastifyInstance;
  const createdUserIds: UserId[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    for (const id of createdUserIds.splice(0)) {
      await app.db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await app.close();
  });

  it('rejects unauthenticated create/list', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      payload: { name: 'X' },
    });
    expect(create.statusCode).toBe(401);

    const list = await app.inject({ method: 'GET', url: '/api/v1/organizations' });
    expect(list.statusCode).toBe(401);
  });

  it('drives the full organization lifecycle end to end', async () => {
    const owner = await makeAuthedUser(app, 'owner');
    createdUserIds.push(owner.userId);
    const viewer = await makeAuthedUser(app, 'viewer');
    createdUserIds.push(viewer.userId);
    const outsider = await makeAuthedUser(app, 'outsider');
    createdUserIds.push(outsider.userId);

    // Create.
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: { cookie: owner.cookie },
      payload: { name: 'Route Test Org' },
    });
    expect(create.statusCode).toBe(201);
    const org = create.json();
    expect(org.slug).toBe('route-test-org');
    const organizationId = org.id as string;

    // Listed for the owner.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/organizations',
      headers: { cookie: owner.cookie },
    });
    expect(list.json().organizations.some((o: { id: string }) => o.id === organizationId)).toBe(
      true,
    );

    // A non-member is forbidden from reading it.
    const forbiddenGet = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}`,
      headers: { cookie: outsider.cookie },
    });
    expect(forbiddenGet.statusCode).toBe(403);

    // Invite a viewer, who accepts.
    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/invitations`,
      headers: { cookie: owner.cookie },
      payload: {
        email: `route-org-test-viewer-${crypto.randomUUID()}@example.test`,
        role: 'viewer',
      },
    });
    expect(invite.statusCode).toBe(201);

    // The invite email won't match the viewer's real email, so re-invite at their actual email.
    const viewerRow = await app.db.query.users.findFirst({
      where: eq(schema.users.id, viewer.userId),
    });
    const reinvite = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/invitations`,
      headers: { cookie: owner.cookie },
      payload: { email: viewerRow!.email, role: 'viewer' },
    });
    expect(reinvite.statusCode).toBe(201);
    const { token } = reinvite.json();

    const accept = await app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${token}/accept`,
      headers: { cookie: viewer.cookie },
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().organizationId).toBe(organizationId);

    // Viewer can read but not update.
    const viewerGet = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}`,
      headers: { cookie: viewer.cookie },
    });
    expect(viewerGet.statusCode).toBe(200);

    const viewerUpdate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}`,
      headers: { cookie: viewer.cookie },
      payload: { name: 'Hijacked' },
    });
    expect(viewerUpdate.statusCode).toBe(403);

    // Owner updates settings.
    const update = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}`,
      headers: { cookie: owner.cookie },
      payload: { name: 'Renamed Org' },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json().name).toBe('Renamed Org');

    // Members list includes both.
    const members = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/members`,
      headers: { cookie: owner.cookie },
    });
    expect(members.json().members).toHaveLength(2);

    // Promote viewer to admin.
    const promote = await app.inject({
      method: 'PATCH',
      url: `/api/v1/organizations/${organizationId}/members/${viewer.userId}`,
      headers: { cookie: owner.cookie },
      payload: { role: 'admin' },
    });
    expect(promote.statusCode).toBe(204);

    // Owner can't be removed while they're the only owner.
    const blockedRemoval = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/members/${owner.userId}`,
      headers: { cookie: owner.cookie },
    });
    expect(blockedRemoval.statusCode).toBe(409);

    // Unknown member id -> 404.
    const unknownMember = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/members/${crypto.randomUUID()}`,
      headers: { cookie: owner.cookie },
    });
    expect(unknownMember.statusCode).toBe(404);

    // Teams.
    const createTeam = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/teams`,
      headers: { cookie: owner.cookie },
      payload: { name: 'Platform' },
    });
    expect(createTeam.statusCode).toBe(201);
    const teamId = createTeam.json().id as string;

    const addTeamMemberRes = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/teams/${teamId}/members`,
      headers: { cookie: owner.cookie },
      payload: { userId: viewer.userId },
    });
    expect(addTeamMemberRes.statusCode).toBe(204);

    const teamMembers = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/teams/${teamId}/members`,
      headers: { cookie: owner.cookie },
    });
    expect(teamMembers.json().members).toHaveLength(1);

    // Transfer ownership, then leave.
    const transfer = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/transfer-ownership`,
      headers: { cookie: owner.cookie },
      payload: { userId: viewer.userId },
    });
    expect(transfer.statusCode).toBe(204);

    const leave = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/leave`,
      headers: { cookie: owner.cookie },
    });
    expect(leave.statusCode).toBe(204);

    // New owner deletes the org.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}`,
      headers: { cookie: viewer.cookie },
    });
    expect(del.statusCode).toBe(204);
  });

  it('rejects transferring ownership to yourself', async () => {
    const owner = await makeAuthedUser(app, 'self-transfer-owner');
    createdUserIds.push(owner.userId);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: { cookie: owner.cookie },
      payload: { name: `Self Transfer Route Org ${crypto.randomUUID()}` },
    });
    const organizationId = create.json().id as string;

    const transfer = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/transfer-ownership`,
      headers: { cookie: owner.cookie },
      payload: { userId: owner.userId },
    });
    expect(transfer.statusCode).toBe(409);

    await app.db.delete(schema.organizations).where(eq(schema.organizations.id, organizationId));
  });

  it('rejects delete from a non-owner admin', async () => {
    const owner = await makeAuthedUser(app, 'delete-owner');
    createdUserIds.push(owner.userId);
    const admin = await makeAuthedUser(app, 'delete-admin');
    createdUserIds.push(admin.userId);

    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/organizations',
      headers: { cookie: owner.cookie },
      payload: { name: 'Delete Perms Org' },
    });
    const organizationId = create.json().id as string;

    const adminRow = await app.db.query.users.findFirst({
      where: eq(schema.users.id, admin.userId),
    });
    const invite = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/invitations`,
      headers: { cookie: owner.cookie },
      payload: { email: adminRow!.email, role: 'admin' },
    });
    const { token } = invite.json();
    await app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${token}/accept`,
      headers: { cookie: admin.cookie },
    });

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}`,
      headers: { cookie: admin.cookie },
    });
    expect(del.statusCode).toBe(403);

    await app.db.delete(schema.organizations).where(eq(schema.organizations.id, organizationId));
  });
});
