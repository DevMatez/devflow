import type { Database, DatabaseTransaction } from '@devflow/database';
import { publishOutbox } from '@devflow/events';
import { normalizeSlug } from '@devflow/validation';
import type { OrganizationId, UserId, Role } from '@devflow/types';
import type { OrgContext } from '../../access/org-context';
import {
  createOrganization as createOrganizationRow,
  findOrganizationById,
  listOrganizationsForUser as listOrganizationsForUserRows,
  updateOrganization as updateOrganizationRow,
  deleteOrganizationById,
  type OrganizationRow,
} from '../dal/organizations.dal';
import {
  addMember,
  listMembers as listMembersRows,
  lockOrganizationMembers,
  removeMember as removeMemberRow,
  updateMemberRole,
  type MemberRow,
  type MemberWithUser,
} from '../dal/members.dal';
import {
  OrganizationCreated,
  OrganizationUpdated,
  MemberRoleChanged,
  MemberRemoved,
} from '../events';

export class MemberNotFoundError extends Error {
  constructor() {
    super('Member not found in this organization');
  }
}

export class LastOwnerError extends Error {
  constructor() {
    super('Organization must have at least one owner');
  }
}

export class SelfTransferError extends Error {
  constructor() {
    super('Cannot transfer ownership to yourself');
  }
}

export interface CreateOrganizationInput {
  name: string;
  slug?: string;
}

/** Creator becomes owner; org row + owner membership + event are one transaction (design doc §4). */
export async function createOrganization(
  db: Database,
  input: CreateOrganizationInput & { userId: UserId; correlationId: string },
): Promise<OrganizationRow> {
  const slug = input.slug ?? normalizeSlug(input.name);

  return db.transaction(async (tx) => {
    const org = await createOrganizationRow(tx, { name: input.name, slug });

    await addMember(tx, {
      organizationId: org.id as OrganizationId,
      userId: input.userId,
      role: 'owner',
    });

    const event = OrganizationCreated.create({
      organizationId: org.id,
      aggregateId: org.id,
      correlationId: input.correlationId,
      payload: { name: org.name, slug: org.slug, ownerId: input.userId },
    });
    await publishOutbox(tx, event);

    return org;
  });
}

export function getOrganization(db: Database, ctx: OrgContext) {
  return findOrganizationById(db, ctx.organizationId);
}

export function listOrganizationsForUser(db: Database, userId: UserId) {
  return listOrganizationsForUserRows(db, userId);
}

export interface UpdateOrganizationSettingsInput {
  name?: string;
  slug?: string;
  correlationId: string;
}

export async function updateOrganizationSettings(
  db: Database,
  ctx: OrgContext,
  input: UpdateOrganizationSettingsInput,
): Promise<OrganizationRow> {
  const slug = input.slug !== undefined ? normalizeSlug(input.slug) : undefined;

  return db.transaction(async (tx) => {
    const org = await updateOrganizationRow(tx, ctx.organizationId, { name: input.name, slug });

    const event = OrganizationUpdated.create({
      organizationId: ctx.organizationId,
      aggregateId: ctx.organizationId,
      correlationId: input.correlationId,
      payload: { name: input.name, slug },
    });
    await publishOutbox(tx, event);

    return org;
  });
}

export function listMembers(db: Database, ctx: OrgContext): Promise<MemberWithUser[]> {
  return listMembersRows(db, ctx.organizationId);
}

/** Runs `fn` with every membership row for the org locked (`FOR UPDATE`) so concurrent ownership mutations serialize. */
async function withLockedMembers<T>(
  db: Database,
  organizationId: OrganizationId,
  fn: (tx: DatabaseTransaction, members: MemberRow[]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const members = await lockOrganizationMembers(tx, organizationId);
    return fn(tx, members);
  });
}

export async function changeMemberRole(
  db: Database,
  ctx: OrgContext,
  targetUserId: UserId,
  newRole: Role,
  correlationId: string,
): Promise<void> {
  await withLockedMembers(db, ctx.organizationId, async (tx, members) => {
    const target = members.find((m) => m.userId === targetUserId);
    if (!target) throw new MemberNotFoundError();

    const ownerCount = members.filter((m) => m.role === 'owner').length;
    const demotesLastOwner = target.role === 'owner' && newRole !== 'owner' && ownerCount <= 1;
    if (demotesLastOwner) throw new LastOwnerError();

    await updateMemberRole(tx, ctx.organizationId, targetUserId, newRole);

    const event = MemberRoleChanged.create({
      organizationId: ctx.organizationId,
      aggregateId: ctx.organizationId,
      correlationId,
      payload: { userId: targetUserId, previousRole: target.role, role: newRole },
    });
    await publishOutbox(tx, event);
  });
}

/** Also used for self-service "leave organization" — the last-owner invariant applies identically. */
export async function removeMember(
  db: Database,
  ctx: OrgContext,
  targetUserId: UserId,
  correlationId: string,
): Promise<void> {
  await withLockedMembers(db, ctx.organizationId, async (tx, members) => {
    const target = members.find((m) => m.userId === targetUserId);
    if (!target) throw new MemberNotFoundError();

    const ownerCount = members.filter((m) => m.role === 'owner').length;
    if (target.role === 'owner' && ownerCount <= 1) throw new LastOwnerError();

    await removeMemberRow(tx, ctx.organizationId, targetUserId);

    const event = MemberRemoved.create({
      organizationId: ctx.organizationId,
      aggregateId: ctx.organizationId,
      correlationId,
      payload: { userId: targetUserId, role: target.role },
    });
    await publishOutbox(tx, event);
  });
}

/** Promotes the target to owner and demotes the caller to admin in one locked transaction — never transiently ownerless. */
export async function transferOwnership(
  db: Database,
  ctx: OrgContext,
  targetUserId: UserId,
  correlationId: string,
): Promise<void> {
  await withLockedMembers(db, ctx.organizationId, async (tx, members) => {
    const target = members.find((m) => m.userId === targetUserId);
    if (!target) throw new MemberNotFoundError();
    if (targetUserId === ctx.userId) throw new SelfTransferError();

    await updateMemberRole(tx, ctx.organizationId, targetUserId, 'owner');
    await updateMemberRole(tx, ctx.organizationId, ctx.userId, 'admin');

    const event = MemberRoleChanged.create({
      organizationId: ctx.organizationId,
      aggregateId: ctx.organizationId,
      correlationId,
      payload: { userId: targetUserId, previousRole: target.role, role: 'owner' },
    });
    await publishOutbox(tx, event);
  });
}

/** Owner-only gate is enforced by the route (`requireOrgRole('owner')`), not here. */
export function deleteOrganization(db: Database, ctx: OrgContext): Promise<void> {
  return deleteOrganizationById(db, ctx.organizationId);
}
