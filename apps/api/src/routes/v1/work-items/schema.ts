import { z } from 'zod';
import {
  workflowStateSchema,
  workflowExecutionStatusSchema,
  branchRefSchema,
  prRefSchema,
} from '@devflow/validation';

export const organizationParamsSchema = z.object({ organizationId: z.string().uuid() });

export const projectWorkItemsParamsSchema = z.object({
  organizationId: z.string().uuid(),
  projectId: z.string().uuid(),
});

export const workItemParamsSchema = z.object({
  organizationId: z.string().uuid(),
  workItemId: z.string().uuid(),
});

export const createWorkItemBodySchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(50_000).optional(),
  /** The provider's project the issue is authored in (e.g. the Plane project id). */
  externalProjectId: z.string().min(1),
});

export const listWorkItemsQuerySchema = z.object({
  workflowState: workflowStateSchema.optional(),
  assigneeUserId: z.string().uuid().optional(),
});

export const transitionWorkItemBodySchema = z
  .object({
    action: z.enum(['advance', 'block', 'unblock', 'cancel']),
    to: workflowStateSchema.optional(),
  })
  .refine((body) => body.action !== 'advance' || body.to !== undefined, {
    message: 'action "advance" requires a target "to" state',
    path: ['to'],
  });

export const startWorkBodySchema = z.object({
  /** The GitHub repo (owner/name) the branch + PR are created in. */
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected "owner/name"'),
  baseBranch: z.string().min(1).optional(),
});

export const startWorkResponseSchema = z.object({
  workItemId: z.string(),
  status: z.literal('starting'),
});

export const workItemResponseSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  externalProvider: z.string(),
  externalIssueId: z.string(),
  externalIssueKey: z.string().nullable(),
  externalIssueUrl: z.string().nullable(),
  workflowState: workflowStateSchema,
  blockedFromState: workflowStateSchema.nullable(),
  workflowExecutionStatus: workflowExecutionStatusSchema,
  workflowExecutionError: z.string().nullable(),
  assigneeUserId: z.string().nullable(),
  externalAssigneeId: z.string().nullable(),
  branchRef: branchRefSchema.nullable(),
  prRef: prRefSchema.nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const workItemsListResponseSchema = z.object({
  workItems: z.array(workItemResponseSchema),
});
