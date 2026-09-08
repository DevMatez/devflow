import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import { addMember, findMembership } from '../../dal/members.dal';
import { findPendingInvitation, listPendingInvitations } from '../../dal/invitations.dal';
import { createOrganization } from '../organizations.service';
import {
  acceptInvitation,
  InvalidInvitationError,
  InvitationEmailMismatchError,
  inviteMember,
} from '../invitations.service';
import type { OrgContext } from '../../../access/org-context';
import type { OrganizationId, UserId } from '@devflow/types';

async function makeUser(app: FastifyInstance, label: string): Promise<UserId> {
  const githubId = `${label}-${crypto.randomUUID()}`;
  const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
  return user.id as UserId;
}

describe('invitations service', () => {
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

  async function makeOrgWithOwner(label: string): Promise<{ ctx: OrgContext; ownerId: UserId }> {
    const ownerId = await makeUser(app, label);
    createdUserIds.push(ownerId);
    const org = await createOrganization(app.db, {
      name: `${label} Org`,
      userId: ownerId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    return {
      ctx: { organizationId: org.id as OrganizationId, userId: ownerId, role: 'owner' },
      ownerId,
    };
  }

  it('creates an invitation whose token hashes to the stored token_hash', async () => {
    const { ctx } = await makeOrgWithOwner('invite-basic');
    const email = `invitee-${crypto.randomUUID()}@example.test`;

    const { invitationId, token } = await inviteMember(app.db, ctx, {
      email,
      role: 'developer',
      correlationId: crypto.randomUUID(),
    });

    const pending = await findPendingInvitation(app.db, ctx.organizationId, email);
    expect(pending?.id).toBe(invitationId);
    expect(token).toBeTruthy();
  });

  it('re-inviting replaces the prior pending invitation', async () => {
    const { ctx } = await makeOrgWithOwner('invite-replace');
    const email = `invitee-${crypto.randomUUID()}@example.test`;

    const first = await inviteMember(app.db, ctx, {
      email,
      role: 'viewer',
      correlationId: crypto.randomUUID(),
    });
    const second = await inviteMember(app.db, ctx, {
      email,
      role: 'admin',
      correlationId: crypto.randomUUID(),
    });

    const pending = await listPendingInvitations(app.db, ctx.organizationId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.id).toBe(second.invitationId);
    expect(pending[0]?.id).not.toBe(first.invitationId);
  });

  it('accepts a matching invitation and creates the membership', async () => {
    const { ctx } = await makeOrgWithOwner('accept-basic');
    const accepterId = await makeUser(app, 'accept-basic-user');
    createdUserIds.push(accepterId);
    const email = `invitee-${crypto.randomUUID()}@example.test`;

    const { token } = await inviteMember(app.db, ctx, {
      email,
      role: 'developer',
      correlationId: crypto.randomUUID(),
    });

    const result = await acceptInvitation(app.db, {
      token,
      userId: accepterId,
      userEmail: email,
      correlationId: crypto.randomUUID(),
    });
    expect(result.organizationId).toBe(ctx.organizationId);

    const membership = await findMembership(app.db, ctx.organizationId, accepterId);
    expect(membership?.role).toBe('developer');
  });

  it('matches the invitation email case-insensitively', async () => {
    const { ctx } = await makeOrgWithOwner('accept-case');
    const accepterId = await makeUser(app, 'accept-case-user');
    createdUserIds.push(accepterId);
    const email = `Invitee-${crypto.randomUUID()}@Example.Test`;

    const { token } = await inviteMember(app.db, ctx, {
      email,
      role: 'viewer',
      correlationId: crypto.randomUUID(),
    });

    await acceptInvitation(app.db, {
      token,
      userId: accepterId,
      userEmail: email.toLowerCase(),
      correlationId: crypto.randomUUID(),
    });

    const membership = await findMembership(app.db, ctx.organizationId, accepterId);
    expect(membership?.role).toBe('viewer');
  });

  it('rejects acceptance when the account email does not match the invitation', async () => {
    const { ctx } = await makeOrgWithOwner('accept-mismatch');
    const accepterId = await makeUser(app, 'accept-mismatch-user');
    createdUserIds.push(accepterId);

    const { token } = await inviteMember(app.db, ctx, {
      email: `invited-${crypto.randomUUID()}@example.test`,
      role: 'developer',
      correlationId: crypto.randomUUID(),
    });

    await expect(
      acceptInvitation(app.db, {
        token,
        userId: accepterId,
        userEmail: `different-${crypto.randomUUID()}@example.test`,
        correlationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(InvitationEmailMismatchError);
  });

  it('rejects an unknown token', async () => {
    const accepterId = await makeUser(app, 'accept-unknown-user');
    createdUserIds.push(accepterId);

    await expect(
      acceptInvitation(app.db, {
        token: 'not-a-real-token',
        userId: accepterId,
        userEmail: 'whoever@example.test',
        correlationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(InvalidInvitationError);
  });

  it('rejects an expired invitation', async () => {
    const { ctx } = await makeOrgWithOwner('accept-expired');
    const accepterId = await makeUser(app, 'accept-expired-user');
    createdUserIds.push(accepterId);
    const email = `invitee-${crypto.randomUUID()}@example.test`;

    const { token } = await inviteMember(app.db, ctx, {
      email,
      role: 'developer',
      correlationId: crypto.randomUUID(),
    });
    const pending = await findPendingInvitation(app.db, ctx.organizationId, email);
    await app.db
      .update(schema.invitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invitations.id, pending!.id));

    await expect(
      acceptInvitation(app.db, {
        token,
        userId: accepterId,
        userEmail: email,
        correlationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(InvalidInvitationError);
  });

  it('is idempotent when the account is already a member', async () => {
    const { ctx } = await makeOrgWithOwner('accept-already-member');
    const accepterId = await makeUser(app, 'accept-already-member-user');
    createdUserIds.push(accepterId);
    const email = `invitee-${crypto.randomUUID()}@example.test`;

    const { token } = await inviteMember(app.db, ctx, {
      email,
      role: 'developer',
      correlationId: crypto.randomUUID(),
    });
    // Added another way (e.g. a different invite) while this one is still pending.
    await app.db.transaction((tx) =>
      addMember(tx, { organizationId: ctx.organizationId, userId: accepterId, role: 'viewer' }),
    );

    await expect(
      acceptInvitation(app.db, {
        token,
        userId: accepterId,
        userEmail: email,
        correlationId: crypto.randomUUID(),
      }),
    ).resolves.toEqual({ organizationId: ctx.organizationId });

    const membership = await findMembership(app.db, ctx.organizationId, accepterId);
    expect(membership?.role).toBe('viewer'); // unchanged, not overwritten by the invite's role
  });

  it('concurrent re-invites for the same (org, email) never violate the partial unique index', async () => {
    const { ctx } = await makeOrgWithOwner('invite-race');
    const email = `invitee-${crypto.randomUUID()}@example.test`;

    const results = await Promise.allSettled([
      inviteMember(app.db, ctx, { email, role: 'viewer', correlationId: crypto.randomUUID() }),
      inviteMember(app.db, ctx, { email, role: 'admin', correlationId: crypto.randomUUID() }),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const pending = await listPendingInvitations(app.db, ctx.organizationId);
    expect(pending).toHaveLength(1);
  });

  it('concurrent accepts of the same token only ever create one membership', async () => {
    const { ctx } = await makeOrgWithOwner('accept-race');
    const accepterId = await makeUser(app, 'accept-race-user');
    createdUserIds.push(accepterId);
    const email = `invitee-${crypto.randomUUID()}@example.test`;

    const { token } = await inviteMember(app.db, ctx, {
      email,
      role: 'developer',
      correlationId: crypto.randomUUID(),
    });

    const results = await Promise.allSettled([
      acceptInvitation(app.db, {
        token,
        userId: accepterId,
        userEmail: email,
        correlationId: crypto.randomUUID(),
      }),
      acceptInvitation(app.db, {
        token,
        userId: accepterId,
        userEmail: email,
        correlationId: crypto.randomUUID(),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InvalidInvitationError);

    const membership = await findMembership(app.db, ctx.organizationId, accepterId);
    expect(membership?.role).toBe('developer');
  });
});
