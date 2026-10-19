import { z } from 'zod';
import { slugSchema, workflowConfigSchema } from '@devflow/validation';

export const organizationProjectsParamsSchema = z.object({
  organizationId: z.string().uuid().describe('Organization id.'),
});

export const projectParamsSchema = organizationProjectsParamsSchema.extend({
  projectId: z.string().uuid().describe('Project id.'),
});

/** Short uppercase code reserved for future ticket numbering (e.g. `ENG`). */
const projectKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{1,9}$/, 'Must be 2-10 uppercase letters/digits, starting with a letter');

const workflowConfigPatchSchema = z
  .object({
    branchNamingPattern: z.string().min(1).max(200).optional(),
    prTitleTemplate: z.string().min(1).max(200).optional(),
    reviewPolicy: z
      .object({
        requiredApprovals: z.number().int().min(0).max(10).optional(),
        requireAiReview: z.boolean().optional(),
      })
      .optional(),
    notificationChannelId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('Slack channel for notifications; null clears it.'),
  })
  .describe('Partial config — merged onto the current (or default) config.');

export const createProjectBodySchema = z.object({
  name: z.string().min(1).max(200),
  slug: slugSchema
    .optional()
    .describe('Canonical form required if supplied; derived from name otherwise.'),
  key: projectKeySchema.optional(),
  workflowConfig: workflowConfigPatchSchema.optional(),
});

export const updateProjectBodySchema = z.object({
  name: z.string().min(1).max(200).optional(),
  slug: slugSchema.optional(),
  key: projectKeySchema.nullable().optional(),
  workflowConfig: workflowConfigPatchSchema.optional(),
});

export const projectResponseSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  slug: z.string(),
  key: z.string().nullable(),
  workflowConfig: workflowConfigSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const projectsListResponseSchema = z.object({ projects: z.array(projectResponseSchema) });
