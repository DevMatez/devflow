import { z } from 'zod';

export const acceptInvitationParamsSchema = z.object({
  token: z.string().min(1).describe('Raw invitation token from the invite link.'),
});

export const acceptInvitationResponseSchema = z.object({
  organizationId: z.string().describe('The organization the caller just joined.'),
});
