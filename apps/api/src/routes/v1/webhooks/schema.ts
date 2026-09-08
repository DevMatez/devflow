import { z } from 'zod';

export const webhookProviderParamsSchema = z.object({
  provider: z.enum(['github', 'plane', 'slack', 'calendar']).describe('Provider path segment.'),
});
