import { type FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { pingSystemBodySchema, pingSystemResponseSchema } from './schema';
import { pingSystem } from '../../../modules/system/service/system.service';
import { requireAuth } from '../../../plugins/auth';
import { resolveOrgContext } from '../../../modules/access/org-context';
import type { OrganizationId } from '@devflow/types';

export async function systemRouter(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().post(
    '/system/ping',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['System'],
        summary: 'Publish a ping through the outbox → relay → queue pipeline',
        description:
          'Wave 0 foundation-proving endpoint: writes a domain event to the ' +
          'transactional outbox in a DB transaction; a background relay picks ' +
          'it up and enqueues it onto BullMQ, where a worker processes it. ' +
          'Returns immediately — the round trip completes asynchronously.',
        body: pingSystemBodySchema,
        response: { 202: pingSystemResponseSchema },
      },
    },
    async (request, reply) => {
      // organizationId comes from the body, not a route param, so requireOrgRole (params-based) doesn't apply here.
      const ctx = await resolveOrgContext(
        app.db,
        request.body.organizationId as OrganizationId,
        request.user!.id,
        'viewer',
      );
      if (!ctx) return reply.forbidden();

      const result = await pingSystem(app.db, {
        organizationId: request.body.organizationId,
        correlationId: request.correlationId,
        message: request.body.message,
      });

      reply.code(202);
      return { eventId: result.eventId, correlationId: request.correlationId };
    },
  );
}
