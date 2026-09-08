import { z } from 'zod';
import { defineEvent } from '@devflow/events';
import { roleSchema } from '@devflow/validation';

export const OrganizationCreated = defineEvent({
  type: 'organization.created',
  schemaVersion: 1,
  schema: z.object({ name: z.string(), slug: z.string(), ownerId: z.string() }),
});

export const OrganizationUpdated = defineEvent({
  type: 'organization.updated',
  schemaVersion: 1,
  schema: z.object({ name: z.string().optional(), slug: z.string().optional() }),
});

export const MemberRoleChanged = defineEvent({
  type: 'member.role_changed',
  schemaVersion: 1,
  schema: z.object({ userId: z.string(), previousRole: roleSchema, role: roleSchema }),
});

export const MemberRemoved = defineEvent({
  type: 'member.removed',
  schemaVersion: 1,
  schema: z.object({ userId: z.string(), role: roleSchema }),
});

/** Never carries the raw invite token — only metadata (design doc §4, §8). */
export const MemberInvited = defineEvent({
  type: 'member.invited',
  schemaVersion: 1,
  schema: z.object({
    invitationId: z.string(),
    email: z.string(),
    role: roleSchema,
    invitedByUserId: z.string(),
    expiresAt: z.string(),
  }),
});

export const MemberJoined = defineEvent({
  type: 'member.joined',
  schemaVersion: 1,
  schema: z.object({ userId: z.string(), role: roleSchema, invitationId: z.string() }),
});
