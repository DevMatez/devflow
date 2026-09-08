import { z } from 'zod';

export const pingSystemBodySchema = z.object({
  organizationId: z.string().uuid().describe('Tenant to attribute the event to (Wave 1 stub).'),
  message: z.string().min(1).max(500).describe('Arbitrary message carried through the pipeline.'),
});

export const pingSystemResponseSchema = z.object({
  eventId: z.string().describe('Outbox event id — also the queue jobId suffix.'),
  correlationId: z
    .string()
    .describe('Correlation id threading this request through to the worker log.'),
});
