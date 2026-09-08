import { z } from 'zod';
import { roleSchema, slugSchema, emailSchema, invitationStatusSchema } from '@devflow/validation';

export const organizationParamsSchema = z.object({
  organizationId: z.string().uuid().describe('Organization id.'),
});

export const memberParamsSchema = organizationParamsSchema.extend({
  userId: z.string().uuid().describe('Target member id.'),
});

export const teamParamsSchema = organizationParamsSchema.extend({
  teamId: z.string().uuid().describe('Team id.'),
});

export const teamMemberParamsSchema = teamParamsSchema.extend({
  userId: z.string().uuid().describe('Target member id.'),
});

export const createOrganizationBodySchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema
    .optional()
    .describe('Canonical form required if supplied; derived from name otherwise.'),
});

export const updateOrganizationBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: slugSchema.optional(),
});

export const changeMemberRoleBodySchema = z.object({
  role: roleSchema,
});

export const inviteMemberBodySchema = z.object({
  email: emailSchema,
  role: roleSchema,
});

export const transferOwnershipBodySchema = z.object({
  userId: z.string().uuid().describe('Member to promote to owner; caller is demoted to admin.'),
});

export const createTeamBodySchema = z.object({
  name: z.string().min(1).max(100),
  slug: slugSchema.optional(),
});

export const updateTeamBodySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: slugSchema.optional(),
});

export const addTeamMemberBodySchema = z.object({
  userId: z.string().uuid(),
});

export const organizationResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const organizationsListResponseSchema = z.object({
  organizations: z.array(organizationResponseSchema),
});

export const memberResponseSchema = z.object({
  userId: z.string(),
  role: roleSchema,
  email: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  createdAt: z.coerce.date(),
});

export const membersListResponseSchema = z.object({
  members: z.array(memberResponseSchema),
});

export const invitationCreatedResponseSchema = z.object({
  invitationId: z.string(),
  token: z.string().describe('Raw invite token, returned once. Never logged; share it directly.'),
});

export const pendingInvitationResponseSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: roleSchema,
  status: invitationStatusSchema,
  expiresAt: z.coerce.date(),
  createdAt: z.coerce.date(),
});

export const pendingInvitationsListResponseSchema = z.object({
  invitations: z.array(pendingInvitationResponseSchema),
});

export const teamResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const teamsListResponseSchema = z.object({
  teams: z.array(teamResponseSchema),
});

export const teamMemberResponseSchema = z.object({
  userId: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  createdAt: z.coerce.date(),
});

export const teamMembersListResponseSchema = z.object({
  members: z.array(teamMemberResponseSchema),
});
