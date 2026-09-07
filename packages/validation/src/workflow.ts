import { z } from 'zod';
import type { WorkflowConfig } from '@devflow/types';

/** Mirrors the `WorkflowConfig` type in `@devflow/types` — keep both in sync. */
export const workflowConfigSchema = z.object({
  version: z.literal(1).default(1),
  branchNamingPattern: z.string().min(1).default('{type}/{ticketKey}-{slug}'),
  prTitleTemplate: z.string().min(1).default('[{ticketKey}] {title}'),
  reviewPolicy: z
    .object({
      requiredApprovals: z.number().int().min(0).default(1),
      requireAiReview: z.boolean().default(true),
    })
    .default({ requiredApprovals: 1, requireAiReview: true }),
  notificationChannelId: z.string().min(1).optional(),
});

// Fails to compile if the schema output and WorkflowConfig drift apart.
type _WorkflowConfigMatches =
  z.infer<typeof workflowConfigSchema> extends WorkflowConfig
    ? WorkflowConfig extends z.infer<typeof workflowConfigSchema>
      ? true
      : never
    : never;
const _workflowConfigTypeCheck: _WorkflowConfigMatches = true;
void _workflowConfigTypeCheck;
