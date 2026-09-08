import { schema, type Database, type DatabaseTransaction } from '@devflow/database';
import { and, eq } from 'drizzle-orm';
import type { OrganizationId, UserId, Role } from '@devflow/types';

export type MemberRow = typeof schema.organizationMembers.$inferSelect;

export interface MemberWithUser {
  userId: string;
  role: Role;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: Date;
}

export function findMembership(
  db: Database | DatabaseTransaction,
  organizationId: OrganizationId,
  userId: UserId,
) {
  return db.query.organizationMembers.findFirst({
    where: and(
      eq(schema.organizationMembers.organizationId, organizationId),
      eq(schema.organizationMembers.userId, userId),
    ),
  });
}

/** Locks every membership row for the org so concurrent ownership mutations serialize (design doc §4). */
export function lockOrganizationMembers(tx: DatabaseTransaction, organizationId: OrganizationId) {
  return tx
    .select()
    .from(schema.organizationMembers)
    .where(eq(schema.organizationMembers.organizationId, organizationId))
    .for('update');
}

export async function listMembers(
  db: Database,
  organizationId: OrganizationId,
): Promise<MemberWithUser[]> {
  return db
    .select({
      userId: schema.organizationMembers.userId,
      role: schema.organizationMembers.role,
      createdAt: schema.organizationMembers.createdAt,
      email: schema.users.email,
      name: schema.users.name,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.organizationMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMembers.userId))
    .where(eq(schema.organizationMembers.organizationId, organizationId));
}

/** Requires an active transaction — ownership mutations must be transactional (design doc §4). */
export async function addMember(
  tx: DatabaseTransaction,
  input: { organizationId: OrganizationId; userId: UserId; role: Role },
): Promise<MemberRow> {
  const [member] = await tx.insert(schema.organizationMembers).values(input).returning();
  if (!member) throw new Error('addMember: insert returned no row');
  return member;
}

export async function updateMemberRole(
  tx: DatabaseTransaction,
  organizationId: OrganizationId,
  userId: UserId,
  role: Role,
): Promise<void> {
  await tx
    .update(schema.organizationMembers)
    .set({ role, updatedAt: new Date() })
    .where(
      and(
        eq(schema.organizationMembers.organizationId, organizationId),
        eq(schema.organizationMembers.userId, userId),
      ),
    );
}

export async function removeMember(
  tx: DatabaseTransaction,
  organizationId: OrganizationId,
  userId: UserId,
): Promise<void> {
  await tx
    .delete(schema.organizationMembers)
    .where(
      and(
        eq(schema.organizationMembers.organizationId, organizationId),
        eq(schema.organizationMembers.userId, userId),
      ),
    );
}
