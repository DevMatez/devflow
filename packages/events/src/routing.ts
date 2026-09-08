import { jobId, type JobHandle } from '@devflow/queue';
import { z } from 'zod';
import type { DomainEvent } from './event';

export interface EventRoute<Payload = unknown> {
  eventType: string;
  name: string;
  enqueue(event: DomainEvent<string, Payload>): Promise<void>;
}

export interface DefineRouteInput<EventPayload, JobPayload extends { organizationId: string }> {
  /** Route name — used to namespace the deterministic job id (`jobId(name, event.id)`). */
  name: string;
  event: { type: string };
  job: JobHandle<z.ZodType<JobPayload>>;
  /** Maps the event payload to the job payload (minus organizationId, added automatically). */
  toJobPayload: (payload: EventPayload) => Omit<JobPayload, 'organizationId'>;
}

/**
 * Maps an event definition to a `@devflow/queue` job. Lives in the
 * events/worker layer — `@devflow/queue` itself stays domain-agnostic.
 */
export function defineRoute<EventPayload, JobPayload extends { organizationId: string }>(
  input: DefineRouteInput<EventPayload, JobPayload>,
): EventRoute<EventPayload> {
  return {
    eventType: input.event.type,
    name: input.name,
    async enqueue(event) {
      const jobPayload = {
        ...input.toJobPayload(event.payload),
        organizationId: event.organizationId,
      } as JobPayload;

      await input.job.enqueue(jobPayload, {
        jobId: jobId(input.name, event.id),
        correlationId: event.correlationId,
      });
    },
  };
}
