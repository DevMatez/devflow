import type { FastifyReply, FastifyRequest } from 'fastify';
import type { OrganizationId, UserId, Role } from '@devflow/types';
import { findMembership } from './dal/organization-members.dal';

export interface OrgContext {
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    orgContext?: OrgContext;
  }
}

// developer/reviewer are peers (design doc §3.3) — same rank, above viewer, below admin.
const ROLE_RANK: Record<Role, number> = {
  viewer: 0,
  reviewer: 1,
  developer: 1,
  admin: 2,
  owner: 3,
};

function meetsMinRole(role: Role, minRole: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

/**
 * Shared by `requireOrgRole` and OAuth-style callbacks that can't rely on a
 * route param preHandler (design doc §10) — same membership + rank check,
 * callable directly once an organization id has been recovered another way
 * (e.g. from a signed OAuth state).
 */
export async function resolveOrgContext(
  db: Parameters<typeof findMembership>[0],
  organizationId: OrganizationId,
  userId: UserId,
  minRole: Role,
): Promise<OrgContext | null> {
  const membership = await findMembership(db, organizationId, userId);
  if (!membership || !meetsMinRole(membership.role, minRole)) return null;
  return { organizationId, userId, role: membership.role };
}

/**
 * Route-level authZ gate for org-scoped resources. Reads `:organizationId` from
 * the (already-validated) route params, loads the caller's membership, and
 * builds `OrgContext` — the only way to construct one (design doc §3.4).
 * Requires the auth plugin to have run first (`request.user`).
 */
export function requireOrgRole(minRole: Role) {
  return async function orgRoleGate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.user) return reply.unauthorized();

    const { organizationId } = request.params as { organizationId: string };
    const ctx = await resolveOrgContext(
      request.server.db,
      organizationId as OrganizationId,
      request.user.id,
      minRole,
    );

    if (!ctx) return reply.forbidden();
    request.orgContext = ctx;
  };
}
