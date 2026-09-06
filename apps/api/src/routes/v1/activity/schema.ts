import { z } from 'zod';

export const orgActivityParamsSchema = z.object({ organizationId: z.string().uuid() });

export const workItemActivityParamsSchema = z.object({
  organizationId: z.string().uuid(),
  workItemId: z.string().uuid(),
});

export const activityQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const activityResponseSchema = z.object({
  id: z.string(),
  workItemId: z.string().nullable(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  action: z.string(),
  summary: z.string(),
  metadata: z.unknown(),
  correlationId: z.string(),
  occurredAt: z.coerce.date(),
});

export const activityListResponseSchema = z.object({
  activity: z.array(activityResponseSchema),
});
