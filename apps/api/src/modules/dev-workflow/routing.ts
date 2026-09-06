import { defineRoute, type EventRoute } from '@devflow/events';
import type { JobHandle } from '@devflow/queue';
import { DevWorkflowWorkStarted, DevWorkflowBranchCreated } from './events';
import type { createBranchJobSchema } from './jobs/create-branch.job';
import type { createPrJobSchema } from './jobs/create-pr.job';

/** work_started → create-branch; branch_created → create-pr (outbox-driven chaining, design §4.2). */
export function createDevWorkflowRoutes(
  createBranchJob: JobHandle<typeof createBranchJobSchema>,
  createPrJob: JobHandle<typeof createPrJobSchema>,
): EventRoute[] {
  return [
    defineRoute({
      name: 'dev-workflow.create-branch',
      event: DevWorkflowWorkStarted,
      job: createBranchJob,
      toJobPayload: (payload: { workItemId: string }) => ({ workItemId: payload.workItemId }),
    }),
    defineRoute({
      name: 'dev-workflow.create-pr',
      event: DevWorkflowBranchCreated,
      job: createPrJob,
      toJobPayload: (payload: { workItemId: string }) => ({ workItemId: payload.workItemId }),
    }),
  ];
}
