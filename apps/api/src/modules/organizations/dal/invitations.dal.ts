import { schema, type Database, type DatabaseTransaction } from '@devflow/database';
import { and, eq, sql } from 'drizzle-orm';
import type { OrganizationId, Role, UserId } from '@devflow/types';

export type InvitationRow = typeof schema.invitations.$inferSelect;

/**
 * Serializes concurrent invite operations for the same (org, email) pair —
 * there is no row to lock with FOR UPDATE when no invitation exists yet, so an
 * advisory lock closes the race the partial unique index alone can't (design
 * doc §12: "concurrent re-invites don't violate the partial unique index").
 */
export async function lockInvitationSlot(
  tx: DatabaseTransaction,
  organizationId: OrganizationId,
  email: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${organizationId}:${email}`}))`);
}

export function findPendingInvitation(
  db: Database | DatabaseTransaction,
  organizationId: OrganizationId,
  email: string,
) {
  return db.query.invitations.findFirst({
    where: and(
      eq(schema.invitations.organizationId, organizationId),
      eq(schema.invitations.email, email),
      eq(schema.invitations.status, 'pending'),
    ),
  });
}

/** Locked so a token can't be redeemed twice concurrently (design doc §12). */
export async function findInvitationByTokenHashForUpdate(
  tx: DatabaseTransaction,
  tokenHash: string,
) {
  const [invitation] = await tx
    .select()
    .from(schema.invitations)
    .where(eq(schema.invitations.tokenHash, tokenHash))
    .for('update');
  return invitation;
}

export interface CreateInvitationInput {
  organizationId: OrganizationId;
  email: string;
  role: Role;
  tokenHash: string;
  invitedByUserId: UserId;
  expiresAt: Date;
}

export async function createInvitation(
  tx: DatabaseTransaction,
  input: CreateInvitationInput,
): Promise<InvitationRow> {
  const [invitation] = await tx.insert(schema.invitations).values(input).returning();
  if (!invitation) throw new Error('createInvitation: insert returned no row');
  return invitation;
}

export async function revokeInvitation(tx: DatabaseTransaction, id: string): Promise<void> {
  await tx
    .update(schema.invitations)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(eq(schema.invitations.id, id));
}

export async function markInvitationAccepted(tx: DatabaseTransaction, id: string): Promise<void> {
  await tx
    .update(schema.invitations)
    .set({ status: 'accepted', updatedAt: new Date() })
    .where(eq(schema.invitations.id, id));
}

export function listPendingInvitations(db: Database, organizationId: OrganizationId) {
  return db.query.invitations.findMany({
    where: and(
      eq(schema.invitations.organizationId, organizationId),
      eq(schema.invitations.status, 'pending'),
    ),
  });
}
