import { z } from 'zod';

export const REVIEW_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

export interface RepoRef {
  /** `owner/name`. */
  fullName: string;
}

export interface PullRequestRef {
  number: number;
  title?: string;
  headRef?: string;
  baseRef?: string;
  headSha?: string;
}

/** Project-specific review rules. `version` makes every result traceable to the rules used. */
export interface ProjectAiRules {
  content: string;
  version: number;
}

/**
 * Optional contextual evidence only. Must never carry instructions or policy
 * ("merge this", "ignore that") — policy lives outside this package. Additive only.
 */
export interface ReviewContext {
  relatedTicket?: { title: string; description?: string };
}

export interface ReviewCodeInput {
  repository: RepoRef;
  pullRequest: PullRequestRef;
  diff: string;
  projectRules?: ProjectAiRules;
  context?: ReviewContext;
  signal?: AbortSignal;
}

/** What the model is asked to produce. `id` and `source` are added by `reviewCode`, not the model. */
export const ModelReviewOutputSchema = z.object({
  summary: z.string(),
  findings: z.array(
    z.object({
      severity: z.enum(REVIEW_SEVERITIES),
      file: z.string(),
      line: z.number().int().optional(),
      title: z.string(),
      explanation: z.string(),
      suggestion: z.string().optional(),
    }),
  ),
});
export type ModelReviewOutput = z.infer<typeof ModelReviewOutputSchema>;

export const CodeReviewFindingSchema = ModelReviewOutputSchema.shape.findings.element.extend({
  /** Stable across re-reviews of the same content — dedupe key for the pipeline. */
  id: z.string(),
  /** Discriminated on purpose — later merged with static-analysis/human findings. */
  source: z.literal('ai'),
});
export type CodeReviewFinding = z.infer<typeof CodeReviewFindingSchema>;

export const CodeReviewResultSchema = z.object({
  summary: z.string(),
  findings: z.array(CodeReviewFindingSchema),
});
export type CodeReviewResult = z.infer<typeof CodeReviewResultSchema>;
