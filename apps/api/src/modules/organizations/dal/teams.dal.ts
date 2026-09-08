import { schema, type Database, type DatabaseTransaction } from '@devflow/database';
import { and, eq } from 'drizzle-orm';
import type { OrganizationId, UserId } from '@devflow/types';

export type TeamRow = typeof schema.teams.$inferSelect;

export interface CreateTeamInput {
  organizationId: OrganizationId;
  name: string;
  slug: string;
}

export async function createTeam(
  tx: DatabaseTransaction,
  input: CreateTeamInput,
): Promise<TeamRow> {
  const [team] = await tx.insert(schema.teams).values(input).returning();
  if (!team) throw new Error('createTeam: insert returned no row');
  return team;
}

export function listTeams(db: Database, organizationId: OrganizationId) {
  return db.query.teams.findMany({ where: eq(schema.teams.organizationId, organizationId) });
}

/** Compound where — a team id from another org is simply not found (design doc §3.4). */
export function findTeamById(db: Database, organizationId: OrganizationId, id: string) {
  return db.query.teams.findFirst({
    where: and(eq(schema.teams.id, id), eq(schema.teams.organizationId, organizationId)),
  });
}

export interface UpdateTeamInput {
  name?: string;
  slug?: string;
}

export async function updateTeam(
  tx: DatabaseTransaction,
  organizationId: OrganizationId,
  id: string,
  input: UpdateTeamInput,
): Promise<TeamRow> {
  const [team] = await tx
    .update(schema.teams)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(schema.teams.id, id), eq(schema.teams.organizationId, organizationId)))
    .returning();
  if (!team) throw new Error('updateTeam: update returned no row');
  return team;
}

/** FK on team_members cascades on delete. */
export async function deleteTeam(
  tx: DatabaseTransaction,
  organizationId: OrganizationId,
  id: string,
): Promise<void> {
  await tx
    .delete(schema.teams)
    .where(and(eq(schema.teams.id, id), eq(schema.teams.organizationId, organizationId)));
}

export interface TeamMemberWithUser {
  userId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  createdAt: Date;
}

export function listTeamMembers(db: Database, teamId: string): Promise<TeamMemberWithUser[]> {
  return db
    .select({
      userId: schema.teamMembers.userId,
      createdAt: schema.teamMembers.createdAt,
      email: schema.users.email,
      name: schema.users.name,
      avatarUrl: schema.users.avatarUrl,
    })
    .from(schema.teamMembers)
    .innerJoin(schema.users, eq(schema.users.id, schema.teamMembers.userId))
    .where(eq(schema.teamMembers.teamId, teamId));
}

/** Caller must verify the team belongs to the org first (design doc §3.4/§6.1) — this dal takes a bare teamId. */
export async function addTeamMember(
  tx: DatabaseTransaction,
  teamId: string,
  userId: UserId,
): Promise<void> {
  await tx.insert(schema.teamMembers).values({ teamId, userId });
}

export async function removeTeamMember(
  tx: DatabaseTransaction,
  teamId: string,
  userId: UserId,
): Promise<void> {
  await tx
    .delete(schema.teamMembers)
    .where(and(eq(schema.teamMembers.teamId, teamId), eq(schema.teamMembers.userId, userId)));
}
