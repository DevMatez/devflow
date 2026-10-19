import { z } from 'zod';
import { REVIEW_SEVERITIES } from '@devflow/ai';

export const projectDraftParamsSchema = z.object({
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
});

export const organizationParamsSchema = z.object({ organizationId: z.string().uuid() });

export const workItemReviewsParamsSchema = z.object({
  organizationId: z.string().uuid(),
  workItemId: z.string().uuid(),
});

export const rerunReviewParamsSchema = workItemReviewsParamsSchema.extend({
  reviewId: z.string().uuid(),
});

export const ticketDraftSchema = z.object({
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
});

export const generateDraftBodySchema = z.object({
  prompt: z.string().trim().min(1).max(4_000),
});

export const improveDraftBodySchema = z.object({
  draft: z.object({
    title: z.string().max(500),
    description: z.string().max(50_000),
    acceptanceCriteria: z.array(z.string().max(2_000)).max(30),
  }),
  instructions: z.string().trim().max(2_000).optional(),
});

export const reviewsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const aiReviewResponseSchema = z.object({
  id: z.string(),
  workItemId: z.string(),
  repo: z.string(),
  prNumber: z.number(),
  headSha: z.string(),
  status: z.enum(['pending', 'completed', 'failed']),
  policyConclusion: z.enum(['success', 'failure']).nullable(),
  summary: z.string().nullable(),
  findings: z
    .array(
      z.object({
        id: z.string(),
        severity: z.enum(REVIEW_SEVERITIES),
        file: z.string(),
        line: z.number().optional(),
        title: z.string(),
        explanation: z.string(),
        suggestion: z.string().optional(),
        source: z.literal('ai'),
      }),
    )
    .nullable(),
  rulesVersion: z.string().nullable(),
  promptVersion: z.string(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const aiReviewsListResponseSchema = z.object({ reviews: z.array(aiReviewResponseSchema) });
