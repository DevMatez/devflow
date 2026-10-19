import { z } from 'zod';
import { defineEvent } from '@devflow/events';

const reviewRef = {
  workItemId: z.string(),
  repo: z.string(),
  prNumber: z.number(),
  headSha: z.string(),
};

/** A review row for a new commit was created (design §7). */
export const AiReviewRequested = defineEvent({
  type: 'ai.review_requested',
  schemaVersion: 1,
  schema: z.object(reviewRef),
});

/** The policy conclusion was computed and persisted (design §7). */
export const AiReviewCompleted = defineEvent({
  type: 'ai.review_completed',
  schemaVersion: 1,
  schema: z.object({
    ...reviewRef,
    policyConclusion: z.enum(['success', 'failure']),
    findingCount: z.number(),
  }),
});

/** A user asked to re-run the review of an already-reviewed commit (design §8). */
export const AiReviewRerunRequested = defineEvent({
  type: 'ai.review_rerun_requested',
  schemaVersion: 1,
  schema: z.object({ ...reviewRef, reviewId: z.string(), actorUserId: z.string() }),
});

/** The AI call (or the pipeline) ultimately failed; the check resolves `neutral` (design §5.3). */
export const AiReviewFailed = defineEvent({
  type: 'ai.review_failed',
  schemaVersion: 1,
  schema: z.object({ ...reviewRef, error: z.string() }),
});
