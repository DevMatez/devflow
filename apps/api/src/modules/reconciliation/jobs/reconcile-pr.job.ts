import { defineJob } from '@devflow/queue';
import { z } from 'zod';
import type { Database } from '@devflow/database';
import type { FastifyBaseLogger } from 'fastify';
import type { PullRequest } from '@devflow/integrations-core';
import { reconcilePrEvent, type PrEventKind } from '../service/reconcile-pr.service';

const pullRequestSchema: z.ZodType<PullRequest> = z.object({
  externalId: z.string(),
  repo: z.string(),
  number: z.number(),
  title: z.string(),
  state: z.enum(['open', 'closed', 'merged']),
  url: z.string(),
  headRef: z.string(),
  baseRef: z.string(),
  authorExternalId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const reconcilePrJobSchema: z.ZodType<{
  organizationId: string;
  kind: PrEventKind;
  pr: PullRequest;
}> = z.object({
  organizationId: z.string(),
  kind: z.enum(['opened', 'updated', 'merged', 'closed']),
  pr: pullRequestSchema,
});

/** Consumes sourcecontrol.pull_request.* -> reconciles into DevFlow (design §6.3). Idempotent; retries -> DLQ. */
export function createReconcilePrJob(db: Database, logger: FastifyBaseLogger) {
  return defineJob({
    name: 'reconcile-pr',
    version: 1,
    schema: reconcilePrJobSchema,
    timeout: 15_000,
    handler: async (payload, ctx) => {
      await reconcilePrEvent(
        db,
        payload.organizationId,
        payload.kind,
        payload.pr,
        ctx.correlationId,
      );
      logger.debug({ repo: payload.pr.repo, number: payload.pr.number }, 'reconcile-pr processed');
    },
  });
}
