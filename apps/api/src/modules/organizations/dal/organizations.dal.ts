import { schema, type Database, type DatabaseTransaction } from '@devflow/database';
import { eq } from 'drizzle-orm';
import type { OrganizationId, UserId } from '@devflow/types';

export type OrganizationRow = typeof schema.organizations.$inferSelect;

export interface CreateOrganizationInput {
  name: string;
  slug: string;
}

/** Requires an active transaction — always paired with inserting the owner's membership (design doc §4). */
export async function createOrganization(
  tx: DatabaseTransaction,
  input: CreateOrganizationInput,
): Promise<OrganizationRow> {
  const [org] = await tx.insert(schema.organizations).values(input).returning();
  if (!org) throw new Error('createOrganization: insert returned no row');
  return org;
}

export function findOrganizationById(db: Database, id: OrganizationId) {
  return db.query.organizations.findFirst({ where: eq(schema.organizations.id, id) });
}

export interface UpdateOrganizationInput {
  name?: string;
  slug?: string;
}

export async function updateOrganization(
  db: Database | DatabaseTransaction,
  id: OrganizationId,
  input: UpdateOrganizationInput,
): Promise<OrganizationRow> {
  const [org] = await db
    .update(schema.organizations)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(schema.organizations.id, id))
    .returning();
  if (!org) throw new Error('updateOrganization: update returned no row');
  return org;
}

/** FKs on organization_members/invitations/teams/projects cascade on delete. */
export async function deleteOrganizationById(db: Database, id: OrganizationId): Promise<void> {
  await db.delete(schema.organizations).where(eq(schema.organizations.id, id));
}

/** Orgs the user belongs to — used for "my organizations" listings, never a raw org id from the client. */
export async function listOrganizationsForUser(
  db: Database,
  userId: UserId,
): Promise<OrganizationRow[]> {
  const rows = await db
    .select({ organization: schema.organizations })
    .from(schema.organizationMembers)
    .innerJoin(
      schema.organizations,
      eq(schema.organizations.id, schema.organizationMembers.organizationId),
    )
    .where(eq(schema.organizationMembers.userId, userId));

  return rows.map((row) => row.organization);
}
