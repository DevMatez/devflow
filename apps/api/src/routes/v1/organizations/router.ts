import { type FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { UserId } from '@devflow/types';
import { requireAuth } from '../../../plugins/auth';
import { requireOrgRole } from '../../../modules/access/org-context';
import {
  createOrganization,
  getOrganization,
  listOrganizationsForUser,
  updateOrganizationSettings,
  listMembers,
  changeMemberRole,
  removeMember,
  transferOwnership,
  deleteOrganization,
  MemberNotFoundError,
  LastOwnerError,
  SelfTransferError,
} from '../../../modules/organizations/service/organizations.service';
import {
  inviteMember,
  listPendingInvitations,
} from '../../../modules/organizations/service/invitations.service';
import {
  createTeam,
  listTeams,
  updateTeam,
  deleteTeam,
  listTeamMembers,
  addTeamMember,
  removeTeamMember,
  TeamNotFoundError,
} from '../../../modules/organizations/service/teams.service';
import {
  organizationParamsSchema,
  memberParamsSchema,
  teamParamsSchema,
  teamMemberParamsSchema,
  createOrganizationBodySchema,
  updateOrganizationBodySchema,
  changeMemberRoleBodySchema,
  inviteMemberBodySchema,
  transferOwnershipBodySchema,
  createTeamBodySchema,
  updateTeamBodySchema,
  addTeamMemberBodySchema,
  organizationResponseSchema,
  organizationsListResponseSchema,
  membersListResponseSchema,
  invitationCreatedResponseSchema,
  pendingInvitationsListResponseSchema,
  teamResponseSchema,
  teamsListResponseSchema,
  teamMembersListResponseSchema,
} from './schema';

export async function organizationsRouter(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  // --- Organizations ---------------------------------------------------

  typed.post(
    '/organizations',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Organizations'],
        summary: 'Create an organization',
        description: 'Creates an organization; the caller becomes its owner.',
        body: createOrganizationBodySchema,
        response: { 201: organizationResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.user) return reply.unauthorized();

      const org = await createOrganization(app.db, {
        name: request.body.name,
        slug: request.body.slug,
        userId: request.user.id,
        correlationId: request.correlationId,
      });

      reply.code(201);
      return org;
    },
  );

  typed.get(
    '/organizations',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Organizations'],
        summary: 'List my organizations',
        description: 'Lists organizations the caller is a member of.',
        response: { 200: organizationsListResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.user) return reply.unauthorized();
      const organizations = await listOrganizationsForUser(app.db, request.user.id);
      return { organizations };
    },
  );

  typed.get(
    '/organizations/:organizationId',
    {
      preHandler: requireOrgRole('viewer'),
      schema: {
        tags: ['Organizations'],
        summary: 'Get an organization',
        description: 'Returns organization details. Any member can read.',
        params: organizationParamsSchema,
        response: { 200: organizationResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const org = await getOrganization(app.db, request.orgContext);
      if (!org) return reply.notFound();
      return org;
    },
  );

  typed.patch(
    '/organizations/:organizationId',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Organizations'],
        summary: 'Update organization settings',
        description: 'Updates name and/or slug. Admin/owner only.',
        params: organizationParamsSchema,
        body: updateOrganizationBodySchema,
        response: { 200: organizationResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      return updateOrganizationSettings(app.db, request.orgContext, {
        name: request.body.name,
        slug: request.body.slug,
        correlationId: request.correlationId,
      });
    },
  );

  typed.delete(
    '/organizations/:organizationId',
    {
      preHandler: requireOrgRole('owner'),
      schema: {
        tags: ['Organizations'],
        summary: 'Delete an organization',
        description: 'Owner-only. Cascades to members, invitations, teams, and projects.',
        params: organizationParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      await deleteOrganization(app.db, request.orgContext);
      return reply.code(204).send();
    },
  );

  // --- Members -----------------------------------------------------------

  typed.get(
    '/organizations/:organizationId/members',
    {
      preHandler: requireOrgRole('viewer'),
      schema: {
        tags: ['Organizations'],
        summary: 'List organization members',
        description: 'Lists members and their roles. Any member can read.',
        params: organizationParamsSchema,
        response: { 200: membersListResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const members = await listMembers(app.db, request.orgContext);
      return { members };
    },
  );

  typed.patch(
    '/organizations/:organizationId/members/:userId',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Organizations'],
        summary: "Change a member's role",
        description: 'Admin/owner only. Cannot demote the last owner.',
        params: memberParamsSchema,
        body: changeMemberRoleBodySchema,
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        await changeMemberRole(
          app.db,
          request.orgContext,
          request.params.userId as UserId,
          request.body.role,
          request.correlationId,
        );
      } catch (error) {
        if (error instanceof MemberNotFoundError) return reply.notFound(error.message);
        if (error instanceof LastOwnerError) return reply.conflict(error.message);
        throw error;
      }

      return reply.code(204).send();
    },
  );

  typed.delete(
    '/organizations/:organizationId/members/:userId',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Organizations'],
        summary: 'Remove a member',
        description: 'Admin/owner only. Cannot remove the last owner.',
        params: memberParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        await removeMember(
          app.db,
          request.orgContext,
          request.params.userId as UserId,
          request.correlationId,
        );
      } catch (error) {
        if (error instanceof MemberNotFoundError) return reply.notFound(error.message);
        if (error instanceof LastOwnerError) return reply.conflict(error.message);
        throw error;
      }

      return reply.code(204).send();
    },
  );

  typed.post(
    '/organizations/:organizationId/leave',
    {
      preHandler: requireOrgRole('viewer'),
      schema: {
        tags: ['Organizations'],
        summary: 'Leave an organization',
        description: 'Self-service removal. Blocked if the caller is the last owner.',
        params: organizationParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        await removeMember(
          app.db,
          request.orgContext,
          request.orgContext.userId,
          request.correlationId,
        );
      } catch (error) {
        if (error instanceof LastOwnerError) return reply.conflict(error.message);
        throw error;
      }

      return reply.code(204).send();
    },
  );

  typed.post(
    '/organizations/:organizationId/transfer-ownership',
    {
      preHandler: requireOrgRole('owner'),
      schema: {
        tags: ['Organizations'],
        summary: 'Transfer ownership',
        description: 'Owner-only. Promotes the target to owner and demotes the caller to admin.',
        params: organizationParamsSchema,
        body: transferOwnershipBodySchema,
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        await transferOwnership(
          app.db,
          request.orgContext,
          request.body.userId as UserId,
          request.correlationId,
        );
      } catch (error) {
        if (error instanceof MemberNotFoundError) return reply.notFound(error.message);
        if (error instanceof SelfTransferError) return reply.conflict(error.message);
        throw error;
      }

      return reply.code(204).send();
    },
  );

  // --- Invitations ---------------------------------------------------------

  typed.post(
    '/organizations/:organizationId/invitations',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Organizations'],
        summary: 'Invite a member',
        description: 'Admin/owner only. Returns the raw token once; it is never logged.',
        params: organizationParamsSchema,
        body: inviteMemberBodySchema,
        response: { 201: invitationCreatedResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      const result = await inviteMember(app.db, request.orgContext, {
        email: request.body.email,
        role: request.body.role,
        correlationId: request.correlationId,
      });

      reply.code(201);
      return result;
    },
  );

  typed.get(
    '/organizations/:organizationId/invitations',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Organizations'],
        summary: 'List pending invitations',
        description: 'Admin/owner only.',
        params: organizationParamsSchema,
        response: { 200: pendingInvitationsListResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const invitations = await listPendingInvitations(app.db, request.orgContext);
      return { invitations };
    },
  );

  // --- Teams ---------------------------------------------------------------

  typed.post(
    '/organizations/:organizationId/teams',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Organizations'],
        summary: 'Create a team',
        description: 'Admin/owner only. Teams are a grouping label only in Wave 1 (no own ACL).',
        params: organizationParamsSchema,
        body: createTeamBodySchema,
        response: { 201: teamResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const team = await createTeam(app.db, request.orgContext, request.body);
      reply.code(201);
      return team;
    },
  );

  typed.get(
    '/organizations/:organizationId/teams',
    {
      preHandler: requireOrgRole('viewer'),
      schema: {
        tags: ['Organizations'],
        summary: 'List teams',
        description: 'Any member can read.',
        params: organizationParamsSchema,
        response: { 200: teamsListResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const teams = await listTeams(app.db, request.orgContext);
      return { teams };
    },
  );

  typed.patch(
    '/organizations/:organizationId/teams/:teamId',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Organizations'],
        summary: 'Update a team',
        description: 'Admin/owner only.',
        params: teamParamsSchema,
        body: updateTeamBodySchema,
        response: { 200: teamResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        return await updateTeam(app.db, request.orgContext, request.params.teamId, request.body);
      } catch (error) {
        if (error instanceof TeamNotFoundError) return reply.notFound(error.message);
        throw error;
      }
    },
  );

  typed.delete(
    '/organizations/:organizationId/teams/:teamId',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Organizations'],
        summary: 'Delete a team',
        description: 'Admin/owner only. Cascades to team membership.',
        params: teamParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        await deleteTeam(app.db, request.orgContext, request.params.teamId);
      } catch (error) {
        if (error instanceof TeamNotFoundError) return reply.notFound(error.message);
        throw error;
      }

      return reply.code(204).send();
    },
  );

  typed.get(
    '/organizations/:organizationId/teams/:teamId/members',
    {
      preHandler: requireOrgRole('viewer'),
      schema: {
        tags: ['Organizations'],
        summary: 'List team members',
        description: 'Any org member can read.',
        params: teamParamsSchema,
        response: { 200: teamMembersListResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        const members = await listTeamMembers(app.db, request.orgContext, request.params.teamId);
        return { members };
      } catch (error) {
        if (error instanceof TeamNotFoundError) return reply.notFound(error.message);
        throw error;
      }
    },
  );

  typed.post(
    '/organizations/:organizationId/teams/:teamId/members',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Organizations'],
        summary: 'Add a team member',
        description: 'Admin/owner only.',
        params: teamParamsSchema,
        body: addTeamMemberBodySchema,
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        await addTeamMember(
          app.db,
          request.orgContext,
          request.params.teamId,
          request.body.userId as UserId,
        );
      } catch (error) {
        if (error instanceof TeamNotFoundError) return reply.notFound(error.message);
        throw error;
      }

      return reply.code(204).send();
    },
  );

  typed.delete(
    '/organizations/:organizationId/teams/:teamId/members/:userId',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Organizations'],
        summary: 'Remove a team member',
        description: 'Admin/owner only.',
        params: teamMemberParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        await removeTeamMember(
          app.db,
          request.orgContext,
          request.params.teamId,
          request.params.userId as UserId,
        );
      } catch (error) {
        if (error instanceof TeamNotFoundError) return reply.notFound(error.message);
        throw error;
      }

      return reply.code(204).send();
    },
  );
}
