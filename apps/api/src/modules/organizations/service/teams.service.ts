import type { Database } from '@devflow/database';
import { normalizeSlug } from '@devflow/validation';
import type { UserId } from '@devflow/types';
import type { OrgContext } from '../../access/org-context';
import {
  addTeamMember as addTeamMemberRow,
  createTeam as createTeamRow,
  deleteTeam as deleteTeamRow,
  findTeamById,
  listTeamMembers as listTeamMembersRows,
  listTeams as listTeamsRows,
  removeTeamMember as removeTeamMemberRow,
  updateTeam as updateTeamRow,
  type TeamRow,
} from '../dal/teams.dal';

export class TeamNotFoundError extends Error {
  constructor() {
    super('Team not found in this organization');
  }
}

export interface CreateTeamInput {
  name: string;
  slug?: string;
}

export function createTeam(
  db: Database,
  ctx: OrgContext,
  input: CreateTeamInput,
): Promise<TeamRow> {
  const slug = input.slug ?? normalizeSlug(input.name);
  return db.transaction((tx) =>
    createTeamRow(tx, { organizationId: ctx.organizationId, name: input.name, slug }),
  );
}

export function listTeams(db: Database, ctx: OrgContext) {
  return listTeamsRows(db, ctx.organizationId);
}

/** Throws if `teamId` doesn't belong to `ctx.organizationId` — the compound lookup that closes cross-org team access. */
async function requireTeam(db: Database, ctx: OrgContext, teamId: string): Promise<TeamRow> {
  const team = await findTeamById(db, ctx.organizationId, teamId);
  if (!team) throw new TeamNotFoundError();
  return team;
}

export interface UpdateTeamInput {
  name?: string;
  slug?: string;
}

export async function updateTeam(
  db: Database,
  ctx: OrgContext,
  teamId: string,
  input: UpdateTeamInput,
): Promise<TeamRow> {
  await requireTeam(db, ctx, teamId);
  const slug = input.slug !== undefined ? normalizeSlug(input.slug) : undefined;
  return db.transaction((tx) =>
    updateTeamRow(tx, ctx.organizationId, teamId, { name: input.name, slug }),
  );
}

export async function deleteTeam(db: Database, ctx: OrgContext, teamId: string): Promise<void> {
  await requireTeam(db, ctx, teamId);
  await db.transaction((tx) => deleteTeamRow(tx, ctx.organizationId, teamId));
}

export async function listTeamMembers(db: Database, ctx: OrgContext, teamId: string) {
  await requireTeam(db, ctx, teamId);
  return listTeamMembersRows(db, teamId);
}

export async function addTeamMember(
  db: Database,
  ctx: OrgContext,
  teamId: string,
  userId: UserId,
): Promise<void> {
  await requireTeam(db, ctx, teamId);
  await db.transaction((tx) => addTeamMemberRow(tx, teamId, userId));
}

export async function removeTeamMember(
  db: Database,
  ctx: OrgContext,
  teamId: string,
  userId: UserId,
): Promise<void> {
  await requireTeam(db, ctx, teamId);
  await db.transaction((tx) => removeTeamMemberRow(tx, teamId, userId));
}
