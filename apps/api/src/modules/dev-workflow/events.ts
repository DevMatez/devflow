import { z } from 'zod';
import { defineEvent } from '@devflow/events';

/** startWork accepted — drives the create-branch job via the outbox relay (design §4.2). */
export const DevWorkflowWorkStarted = defineEvent({
  type: 'devworkflow.work_started',
  schemaVersion: 1,
  schema: z.object({ workItemId: z.string(), actorUserId: z.string() }),
});

/** Branch step succeeded — drives the create-pr job (design §4.2). */
export const DevWorkflowBranchCreated = defineEvent({
  type: 'devworkflow.branch_created',
  schemaVersion: 1,
  schema: z.object({ workItemId: z.string(), repo: z.string(), branch: z.string() }),
});

export const DevWorkflowPullRequestOpened = defineEvent({
  type: 'devworkflow.pull_request_opened',
  schemaVersion: 1,
  schema: z.object({
    workItemId: z.string(),
    repo: z.string(),
    number: z.number(),
    url: z.string(),
  }),
});

/** A saga step permanently failed (exhausted retries → DLQ), execution marked FAILED (design §4.5). */
export const DevWorkflowWorkflowFailed = defineEvent({
  type: 'devworkflow.workflow_failed',
  schemaVersion: 1,
  schema: z.object({ workItemId: z.string(), step: z.string(), error: z.string() }),
});
