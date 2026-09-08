import { type FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAuth } from '../../../plugins/auth';
import {
  acceptInvitation,
  InvalidInvitationError,
  InvitationEmailMismatchError,
} from '../../../modules/organizations/service/invitations.service';
import { acceptInvitationParamsSchema, acceptInvitationResponseSchema } from './schema';

// Tighter than the app-wide default (design doc §8) — token-guessing protection.
const ACCEPT_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

export async function invitationsRouter(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/invitations/:token/accept',
    {
      preHandler: requireAuth,
      config: { rateLimit: ACCEPT_RATE_LIMIT },
      schema: {
        tags: ['Organizations'],
        summary: 'Accept an invitation',
        description:
          "Requires the signed-in account's verified email to match the invitation email.",
        params: acceptInvitationParamsSchema,
        response: { 200: acceptInvitationResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.user) return reply.unauthorized();

      try {
        const result = await acceptInvitation(app.db, {
          token: request.params.token,
          userId: request.user.id,
          userEmail: request.user.email,
          correlationId: request.correlationId,
        });
        return result;
      } catch (error) {
        if (error instanceof InvalidInvitationError) return reply.badRequest(error.message);
        if (error instanceof InvitationEmailMismatchError) return reply.forbidden(error.message);
        throw error;
      }
    },
  );
}
