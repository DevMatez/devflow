import { defineRoute, type EventRoute } from '@devflow/events';
import type { JobHandle } from '@devflow/queue';
import type { PullRequest } from '@devflow/integrations-core';
import type { aiReviewRequestJobSchema } from './jobs/ai-review-request.job';

/**
 * Both PR origins → one ai-review.request job (design §5.1): DevFlow's own
 * saga output and out-of-band GitHub opens/pushes. Duplicate triggers for the
 * same commit collapse on the `ai_reviews` unique key + lease, not here.
 */
export function createAiReviewRoutes(
  job: JobHandle<typeof aiReviewRequestJobSchema>,
): EventRoute[] {
  return [
    defineRoute({
      name: 'ai-review.devworkflow-pr-opened',
      event: { type: 'devworkflow.pull_request_opened' },
      job,
      toJobPayload: (p: {
        workItemId: string;
        repo: string;
        number: number;
        headSha?: string;
      }) => ({
        repo: p.repo,
        prNumber: p.number,
        workItemId: p.workItemId,
        headSha: p.headSha,
      }),
    }),
    ...(['opened', 'updated'] as const).map((kind) =>
      defineRoute({
        name: `ai-review.pr-${kind}`,
        event: { type: `sourcecontrol.pull_request.${kind}` },
        job,
        toJobPayload: (pr: PullRequest) => ({
          repo: pr.repo,
          prNumber: pr.number,
          headSha: pr.headSha,
          headRef: pr.headRef,
          prState: pr.state,
        }),
      }),
    ),
  ];
}
