import { z } from 'zod';
import { integrationCategorySchema, connectionStatusSchema } from '@devflow/validation';
import { organizationParamsSchema } from '../organizations/schema';

export const integrationCategoryParamsSchema = organizationParamsSchema.extend({
  category: integrationCategorySchema,
});

export const connectionResponseSchema = z.object({
  id: z.string(),
  category: integrationCategorySchema,
  provider: z.string(),
  status: connectionStatusSchema,
  externalAccount: z.unknown(),
  tokenExpiresAt: z.coerce.date().nullable(),
  lastSyncedAt: z.coerce.date().nullable(),
  lastFailureAt: z.coerce.date().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const connectionsListResponseSchema = z.object({
  connections: z.array(connectionResponseSchema),
});

export const githubInstallCallbackQuerySchema = z.object({
  installation_id: z.string().optional(),
  setup_action: z.string().optional(),
  state: z.string(),
});

export const planeConnectBodySchema = z.object({
  workspaceSlug: z.string().min(1),
  apiToken: z.string().min(1),
  webhookSecret: z.string().min(1),
});

export const slackOAuthCallbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string(),
  error: z.string().optional(),
});
