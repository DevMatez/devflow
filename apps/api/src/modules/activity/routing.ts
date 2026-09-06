import { jobId, type JobHandle } from '@devflow/queue';
import type { DomainEvent, EventRoute } from '@devflow/events';
import { ACTIVITY_EVENT_TYPES } from './projection';
import type { activityProjectorJobSchema } from './jobs/activity-projector.job';

/**
 * One route per surfaced DevFlow event type, all pointing at the single
 * activity projector job (design §5, §7). A custom route (not `defineRoute`)
 * because the projection needs the full event envelope — id (for the
 * idempotency key), type, and occurredAt — not just the payload.
 */
export function createActivityRoutes(
  job: JobHandle<typeof activityProjectorJobSchema>,
): EventRoute[] {
  return ACTIVITY_EVENT_TYPES.map((eventType) => ({
    eventType,
    name: `activity:${eventType}`,
    async enqueue(event: DomainEvent) {
      await job.enqueue(
        {
          organizationId: event.organizationId,
          eventId: event.id,
          type: event.type,
          aggregateId: event.aggregateId,
          correlationId: event.correlationId,
          occurredAt: event.occurredAt,
          payload: event.payload,
        },
        { jobId: jobId('activity', event.id), correlationId: event.correlationId },
      );
    },
  }));
}

/**
 * Event types intentionally not consumed in Phase 1 — acknowledged by the
 * relay without enqueuing, distinct from an unrouted defect (design §5).
 * Integration events with no Wave 3 consumer + Wave 1 domain events with no
 * Phase 1 consumer.
 */
export const IGNORED_EVENT_TYPES: readonly string[] = [
  // integration events Wave 3 never consumes
  'chat.message.posted',
  'calendar.event.updated',
  'calendar.event.cancelled',
  'sourcecontrol.check_run.updated',
  'sourcecontrol.comment.created',
  'sourcecontrol.pull_request_review.submitted',
  // Wave 1 domain events with no Phase 1 consumer
  'organization.created',
  'organization.updated',
  'member.role_changed',
  'member.removed',
  'member.invited',
  'member.joined',
];
