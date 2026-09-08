import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok').describe('Service health status.'),
  uptime: z.number().describe('Process uptime in seconds.'),
  timestamp: z.string().describe('Current server time (ISO 8601).'),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
