import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import { createOrganization, deleteOrganizationById } from '../organizations.dal';
import {
  createInvitation,
  findInvitationByTokenHashForUpdate,
  findPendingInvitation,
  listPendingInvitations,
  lockInvitationSlot,
  markInvitationAccepted,
  revokeInvitation,
} from '../invitations.dal';
import type { OrganizationId, UserId } from '@devflow/types';

describe('invitations dal', () => {
  let app: FastifyInstance;
  let organizationId: OrganizationId;
  let inviterId: UserId;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    const githubId = `invitations-dal-test-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    inviterId = user.id as UserId;

    const org = await app.db.transaction((tx) =>
      createOrganization(tx, {
        name: 'Invitations DAL Org',
        slug: `invitations-dal-${crypto.randomUUID()}`,
      }),
    );
    organizationId = org.id as OrganizationId;
  });

  afterAll(async () => {
    await deleteOrganizationById(app.db, organizationId);
    await app.db.delete(schema.users).where(eq(schema.users.id, inviterId));
    await app.close();
  });

  it('creates a pending invitation and finds it', async () => {
    const email = `invitee-${crypto.randomUUID()}@example.test`;
    const invitation = await app.db.transaction(async (tx) => {
      await lockInvitationSlot(tx, organizationId, email);
      return createInvitation(tx, {
        organizationId,
        email,
        role: 'developer',
        tokenHash: `hash-${crypto.randomUUID()}`,
        invitedByUserId: inviterId,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      });
    });

    const found = await findPendingInvitation(app.db, organizationId, email);
    expect(found?.id).toBe(invitation.id);

    const listed = await listPendingInvitations(app.db, organizationId);
    expect(listed.some((i) => i.id === invitation.id)).toBe(true);
  });

  it('revokes an invitation, removing it from the pending set', async () => {
    const email = `invitee-${crypto.randomUUID()}@example.test`;
    const invitation = await app.db.transaction((tx) =>
      createInvitation(tx, {
        organizationId,
        email,
        role: 'viewer',
        tokenHash: `hash-${crypto.randomUUID()}`,
        invitedByUserId: inviterId,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      }),
    );

    await app.db.transaction((tx) => revokeInvitation(tx, invitation.id));

    const found = await findPendingInvitation(app.db, organizationId, email);
    expect(found).toBeUndefined();
  });

  it('marks an invitation accepted and locks it for update', async () => {
    const tokenHash = `hash-${crypto.randomUUID()}`;
    const invitation = await app.db.transaction((tx) =>
      createInvitation(tx, {
        organizationId,
        email: `invitee-${crypto.randomUUID()}@example.test`,
        role: 'reviewer',
        tokenHash,
        invitedByUserId: inviterId,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      }),
    );

    await app.db.transaction((tx) => markInvitationAccepted(tx, invitation.id));

    const locked = await app.db.transaction((tx) =>
      findInvitationByTokenHashForUpdate(tx, tokenHash),
    );
    expect(locked?.status).toBe('accepted');
  });
});
