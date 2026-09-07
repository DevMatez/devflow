import { defineJob } from '@devflow/queue';
import { z } from 'zod';
import type { Database } from '@devflow/database';
import type { FastifyBaseLogger } from 'fastify';
import type { NormalizedIssueEvent } from '@devflow/integrations-core';
import { reconcileIssueEvent } from '../service/reconcile-issue.service';

const normalizedIssueEventSchema: z.ZodType<NormalizedIssueEvent> = z.object({
  externalId: z.string(),
  key: z.string().nullable(),
  title: z.string(),
  statusClass: z.enum(['open', 'completed', 'cancelled']),
  assigneeExternalId: z.string().nullable(),
  projectExternalId: z.string().nullable(),
  url: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const reconcileIssueJobSchema: z.ZodType<{
  organizationId: string;
  isCreated: boolean;
  event: NormalizedIssueEvent;
}> = z.object({
  organizationId: z.string(),
  isCreated: z.boolean(),
  event: normalizedIssueEventSchema,
});

/** Consumes projectmanagement.issue.* → reconciles into DevFlow (design §6.2). Idempotent; retries → DLQ. */
export function createReconcileIssueJob(db: Database, logger: FastifyBaseLogger) {
  return defineJob({
    name: 'reconcile-issue',
    version: 1,
    schema: reconcileIssueJobSchema,
    timeout: 15_000,
    handler: async (payload, ctx) => {
      await reconcileIssueEvent(
        db,
        payload.organizationId,
        payload.event,
        payload.isCreated,
        ctx.correlationId,
      );
      logger.debug({ externalId: payload.event.externalId }, 'reconcile-issue processed');
    },
  });
}
