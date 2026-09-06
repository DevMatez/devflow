import { z } from 'zod';
import { defineEvent } from '@devflow/events';
import { workflowStateSchema } from '@devflow/validation';

/** Emitted once a work item is bound to its external issue (design §8, §3.1). */
export const WorkItemCreated = defineEvent({
  type: 'workitem.created',
  schemaVersion: 1,
  ordering: 'aggregate',
  schema: z.object({
    workItemId: z.string(),
    projectId: z.string(),
    externalKey: z.string().nullable(),
  }),
});

/** Every accepted transition, actor- or reconciliation-driven (design §3.2, §8). */
export const WorkItemStateChanged = defineEvent({
  type: 'workitem.state_changed',
  schemaVersion: 1,
  ordering: 'aggregate',
  schema: z.object({
    workItemId: z.string(),
    from: workflowStateSchema,
    to: workflowStateSchema,
    reason: z.enum(['actor', 'reconciliation']),
    trigger: z.string(),
  }),
});

/** A reconciliation applied to (or observed against) a work item, incl. anomalies (design §6, §8). */
export const WorkItemReconciled = defineEvent({
  type: 'workitem.reconciled',
  schemaVersion: 1,
  schema: z.object({
    workItemId: z.string().nullable(),
    source: z.string(),
    anomaly: z.boolean(),
    detail: z.string(),
  }),
});
