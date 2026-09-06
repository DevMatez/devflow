import { defineJob } from '@devflow/queue';
import { z } from 'zod';
import type { Database } from '@devflow/database';
import type { FastifyBaseLogger } from 'fastify';
import { insertActivity } from '../dal/activity.dal';
import { projectActivity, type ProjectionEvent } from '../projection';

// z.ZodType (not ZodObject) so JobHandle<typeof this> matches EventRoute['job'].
export const activityProjectorJobSchema: z.ZodType<ProjectionEvent> = z.object({
  organizationId: z.string(),
  eventId: z.string(),
  type: z.string(),
  aggregateId: z.string(),
  correlationId: z.string(),
  occurredAt: z.string(),
  payload: z.unknown(),
});

/**
 * Projects a DevFlow domain event into an `activity` row (design §7). The
 * write is idempotent (`ON CONFLICT (source_event_id) DO NOTHING`), so an
 * at-least-once redelivery is a successful no-op, not a retry/DLQ entry.
 */
export function createActivityProjectorJob(db: Database, logger: FastifyBaseLogger) {
  return defineJob({
    name: 'activity-projector',
    version: 1,
    schema: activityProjectorJobSchema,
    timeout: 5_000,
    handler: async (payload, ctx) => {
      await insertActivity(db, projectActivity(payload));
      logger.debug(
        { correlationId: ctx.correlationId, sourceEventId: payload.eventId, type: payload.type },
        'activity projected',
      );
    },
  });
}
