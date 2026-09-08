import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../../modules/identity/dal/users.dal';
import { createUserSession } from '../../../../modules/identity/service/session.service';
import { createOrganization } from '../../../../modules/organizations/service/organizations.service';
import { inviteMember } from '../../../../modules/organizations/service/invitations.service';
import { SESSION_COOKIE_NAME } from '../../../../plugins/auth';
import type { OrgContext } from '../../../../modules/access/org-context';
import type { OrganizationId, UserId } from '@devflow/types';

async function makeAuthedUser(app: FastifyInstance, label: string) {
  const githubId = `route-invite-test-${label}-${crypto.randomUUID()}`;
  const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
  const { token } = await createUserSession(
    app.db,
    { ttlDays: 30, refreshThresholdDays: 7 },
    { userId: user.id as UserId },
  );
  return {
    userId: user.id as UserId,
    email: user.email,
    cookie: `${SESSION_COOKIE_NAME}=${app.signCookie(token)}`,
  };
}

describe('invitations routes', () => {
  let app: FastifyInstance;
  const createdUserIds: UserId[] = [];
  const createdOrgIds: OrganizationId[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    for (const id of createdOrgIds.splice(0)) {
      await app.db.delete(schema.organizations).where(eq(schema.organizations.id, id));
    }
    for (const id of createdUserIds.splice(0)) {
      await app.db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await app.close();
  });

  async function makeOrgWithOwner(label: string): Promise<OrgContext> {
    const owner = await makeAuthedUser(app, label);
    createdUserIds.push(owner.userId);
    const org = await createOrganization(app.db, {
      name: `${label} Org`,
      userId: owner.userId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    return { organizationId: org.id as OrganizationId, userId: owner.userId, role: 'owner' };
  }

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/invitations/some-token/accept' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 for an unknown or invalid token', async () => {
    const accepter = await makeAuthedUser(app, 'unknown-token');
    createdUserIds.push(accepter.userId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/invitations/not-a-real-token/accept',
      headers: { cookie: accepter.cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 when the account's email does not match the invitation", async () => {
    const ctx = await makeOrgWithOwner('mismatch-org');
    const accepter = await makeAuthedUser(app, 'mismatch-accepter');
    createdUserIds.push(accepter.userId);

    const { token } = await inviteMember(app.db, ctx, {
      email: `someone-else-${crypto.randomUUID()}@example.test`,
      role: 'developer',
      correlationId: crypto.randomUUID(),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${token}/accept`,
      headers: { cookie: accepter.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('accepts a matching invitation', async () => {
    const ctx = await makeOrgWithOwner('accept-org');
    const accepter = await makeAuthedUser(app, 'accept-accepter');
    createdUserIds.push(accepter.userId);

    const { token } = await inviteMember(app.db, ctx, {
      email: accepter.email,
      role: 'reviewer',
      correlationId: crypto.randomUUID(),
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/invitations/${token}/accept`,
      headers: { cookie: accepter.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().organizationId).toBe(ctx.organizationId);
  });
});
