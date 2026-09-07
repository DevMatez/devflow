import { defineRoute, type EventRoute } from '@devflow/events';
import type { JobHandle } from '@devflow/queue';
import type { NormalizedIssueEvent } from '@devflow/integrations-core';
import type { reconcileIssueJobSchema } from './jobs/reconcile-issue.job';

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
