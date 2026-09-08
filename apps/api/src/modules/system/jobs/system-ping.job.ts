import { defineJob } from '@devflow/queue';
import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';

// Typed as z.ZodType (not the narrower ZodObject) so JobHandle<typeof this>
// structurally matches @devflow/events' EventRoute['job'] expectations.
export const systemPingJobSchema: z.ZodType<{ organizationId: string; message: string }> = z.object(
  {
    organizationId: z.string(),
    message: z.string(),
  },
);

/** Built with a logger so the handler never uses `console.*` (repo lint rule). */
export function createSystemPingJob(logger: FastifyBaseLogger) {
  return defineJob({
    name: 'system-ping',
    version: 1,
    schema: systemPingJobSchema,
    timeout: 5_000,
    handler: async (payload, ctx) => {
      logger.info(
        { correlationId: ctx.correlationId, organizationId: payload.organizationId },
        `system-ping processed: ${payload.message}`,
      );
    },
  });
}
