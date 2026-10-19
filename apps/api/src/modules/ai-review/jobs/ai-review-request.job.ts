import { defineJob } from '@devflow/queue';
import { z } from 'zod';
import type { Database } from '@devflow/database';
import type { AiProvider } from '@devflow/ai';
import type { FastifyBaseLogger } from 'fastify';
import {
  resolveGithubSourceControl,
  type ResolveSourceControl,
} from '../../dev-workflow/service/dev-workflow.service';
import { runAiReview, type AiReviewRequest } from '../service/ai-review.service';

export const aiReviewRequestJobSchema: z.ZodType<AiReviewRequest> = z.object({
  organizationId: z.string(),
  repo: z.string(),
  prNumber: z.number().int(),
  headSha: z.string().optional(),
  headRef: z.string().optional(),
  workItemId: z.string().optional(),
  prState: z.enum(['open', 'closed', 'merged']).optional(),
});

const MAX_ATTEMPTS = 3;

/**
 * One AI review of one PR commit (design §5.3). Retries cover transient
 * GitHub/AI failures; a non-retryable AI error or the final attempt resolves
 * the review as failed with a `neutral` check (never `failure`).
 */
export function createAiReviewRequestJob(
  db: Database,
  logger: FastifyBaseLogger,
  credentialsKey: Buffer,
  ai: AiProvider,
  resolveSourceControl: ResolveSourceControl = resolveGithubSourceControl,
) {
  return defineJob({
    name: 'ai-review.request',
    version: 1,
    schema: aiReviewRequestJobSchema,
    defaults: { attempts: MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 10_000 } },
    // The model call itself is bounded by the provider timeout (5 min); leave room for GitHub calls.
    timeout: 10 * 60_000,
    handler: async (payload, ctx) => {
      const review = await runAiReview(
        { db, ai, credentialsKey, resolveSourceControl, logger },
        payload,
        {
          correlationId: ctx.correlationId,
          claimant: ctx.jobId ?? ctx.correlationId,
          attempt: ctx.attempt,
          maxAttempts: MAX_ATTEMPTS,
        },
      );
      if (review) {
        logger.info(
          { reviewId: review.id, status: review.status, conclusion: review.policyConclusion },
          'ai-review: processed',
        );
      }
    },
  });
}
