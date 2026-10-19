import { z } from 'zod';
import { defineEvent } from '@devflow/events';

export const ProjectCreated = defineEvent({
  type: 'project.created',
  schemaVersion: 1,
  schema: z.object({ projectId: z.string(), name: z.string(), slug: z.string() }),
});

/** Carries the full new config — it's small and consumers shouldn't need a read-back. */
export const ProjectWorkflowConfigUpdated = defineEvent({
  type: 'project.workflow_config_updated',
  schemaVersion: 1,
  schema: z.object({ projectId: z.string(), workflowConfig: z.unknown() }),
});
