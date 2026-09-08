import { defineRoute, type EventRoute } from '@devflow/events';
import type { JobHandle } from '@devflow/queue';
import type { NormalizedIssueEvent, PullRequest } from '@devflow/integrations-core';
import type { reconcileIssueJobSchema } from './jobs/reconcile-issue.job';
import type { reconcilePrJobSchema } from './jobs/reconcile-pr.job';
import type { PrEventKind } from './service/reconcile-pr.service';

/**
 * projectmanagement.issue.created / .updated → the reconcile-issue job
 * (design §5, §6.2). Two routes share one job; `isCreated` is fixed per route
 * so the bind-existing path only fires for created events.
 */
export function createReconciliationRoutes(
  reconcileIssueJob: JobHandle<typeof reconcileIssueJobSchema>,
): EventRoute[] {
  return [
    defineRoute({
      name: 'reconcile-issue.created',
      event: { type: 'projectmanagement.issue.created' },
      job: reconcileIssueJob,
      toJobPayload: (event: NormalizedIssueEvent) => ({ isCreated: true, event }),
    }),
    defineRoute({
      name: 'reconcile-issue.updated',
      event: { type: 'projectmanagement.issue.updated' },
      job: reconcileIssueJob,
      toJobPayload: (event: NormalizedIssueEvent) => ({ isCreated: false, event }),
    }),
  ];
}

/**
 * sourcecontrol.pull_request.{opened,updated,merged,closed} → the
 * reconcile-pr job (design §5, §6.3). Four routes share one job; `kind` is
 * fixed per route so the job can derive the right reconciliation trigger.
 */
export function createPrReconciliationRoutes(
  reconcilePrJob: JobHandle<typeof reconcilePrJobSchema>,
): EventRoute[] {
  const kinds: PrEventKind[] = ['opened', 'updated', 'merged', 'closed'];
  return kinds.map((kind) =>
    defineRoute({
      name: `reconcile-pr.${kind}`,
      event: { type: `sourcecontrol.pull_request.${kind}` },
      job: reconcilePrJob,
      toJobPayload: (pr: PullRequest) => ({ kind, pr }),
    }),
  );
}
