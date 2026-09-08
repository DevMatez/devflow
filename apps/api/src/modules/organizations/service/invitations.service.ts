import { randomBytes, createHash } from 'node:crypto';
import type { Database } from '@devflow/database';
import { publishOutbox } from '@devflow/events';
import type { OrganizationId, Role, UserId } from '@devflow/types';
import type { OrgContext } from '../../access/org-context';
import {
  createInvitation,
  findInvitationByTokenHashForUpdate,
  findPendingInvitation,
  listPendingInvitations as listPendingInvitationsRows,
  lockInvitationSlot,
  markInvitationAccepted,
  revokeInvitation,
} from '../dal/invitations.dal';
import { addMember, findMembership } from '../dal/members.dal';
import { MemberInvited, MemberJoined } from '../events';

export class InvalidInvitationError extends Error {
  constructor() {
    super('Invitation not found, expired, or already used');
  }
}

export class InvitationEmailMismatchError extends Error {
  constructor() {
    super("Invitation email does not match the signed-in account's email");
  }
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface InviteMemberInput {
  email: string;
  role: Role;
  correlationId: string;
}

export interface InviteMemberResult {
  invitationId: string;
  token: string;
}

/**
 * Transactionally replaces any existing pending invite for (org, email) with a
 * new one. The raw token is returned here only — never logged (design doc §4).
 */
export async function inviteMember(
  db: Database,
  ctx: OrgContext,
  input: InviteMemberInput,
): Promise<InviteMemberResult> {
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashInvitationToken(token);
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const invitation = await db.transaction(async (tx) => {
    await lockInvitationSlot(tx, ctx.organizationId, input.email);

    const existing = await findPendingInvitation(tx, ctx.organizationId, input.email);
    if (existing) await revokeInvitation(tx, existing.id);

    const created = await createInvitation(tx, {
      organizationId: ctx.organizationId,
      email: input.email,
      role: input.role,
      tokenHash,
      invitedByUserId: ctx.userId,
      expiresAt,
    });

    const event = MemberInvited.create({
      organizationId: ctx.organizationId,
      aggregateId: ctx.organizationId,
      correlationId: input.correlationId,
      payload: {
        invitationId: created.id,
        email: input.email,
        role: input.role,
        invitedByUserId: ctx.userId,
        expiresAt: expiresAt.toISOString(),
      },
    });
    await publishOutbox(tx, event);

    return created;
  });

  return { invitationId: invitation.id, token };
}

export function listPendingInvitations(db: Database, ctx: OrgContext) {
  return listPendingInvitationsRows(db, ctx.organizationId);
}

export interface AcceptInvitationInput {
  token: string;
  userId: UserId;
  userEmail: string;
  correlationId: string;
}

/**
 * Requires the accepting account's email to match the invitation email
 * (case-insensitively) — a leaked token can't be redeemed onto another
 * account (design doc §4). Already-a-member is treated as idempotent success.
 */
export async function acceptInvitation(
  db: Database,
  input: AcceptInvitationInput,
): Promise<{ organizationId: OrganizationId }> {
  const tokenHash = hashInvitationToken(input.token);

  return db.transaction(async (tx) => {
    const invitation = await findInvitationByTokenHashForUpdate(tx, tokenHash);
    const isUsable =
      invitation && invitation.status === 'pending' && invitation.expiresAt.getTime() > Date.now();
    if (!invitation || !isUsable) throw new InvalidInvitationError();

    if (invitation.email.toLowerCase() !== input.userEmail.toLowerCase()) {
      throw new InvitationEmailMismatchError();
    }

    await markInvitationAccepted(tx, invitation.id);

    const organizationId = invitation.organizationId as OrganizationId;
    const alreadyMember = await findMembership(tx, organizationId, input.userId);
    if (alreadyMember) return { organizationId };

    await addMember(tx, { organizationId, userId: input.userId, role: invitation.role });

    const event = MemberJoined.create({
      organizationId,
      aggregateId: organizationId,
      correlationId: input.correlationId,
      payload: { userId: input.userId, role: invitation.role, invitationId: invitation.id },
    });
    await publishOutbox(tx, event);

    return { organizationId };
  });
}
