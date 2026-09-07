import { defineRoute, type EventRoute } from '@devflow/events';
import type { JobHandle } from '@devflow/queue';
import type { notifySlackJobSchema } from './jobs/notify-slack.job';

const NOTIFIED_EVENT_TYPES = [
  'devworkflow.work_started',
  'devworkflow.pull_request_opened',
  'workitem.state_changed',
] as const;

/**
 * Fans the key workflow events (design §1, §15.3) into the notify-slack job.
 * These event types already have other consumers (activity, dev-workflow
 * chaining) — the relay's fan-out (design §5) lets this route coexist.
 */
export function createNotificationRoutes(
  notifySlackJob: JobHandle<typeof notifySlackJobSchema>,
): EventRoute[] {
  return NOTIFIED_EVENT_TYPES.map((type) =>
    defineRoute({
      name: `notify:${type}`,
      event: { type },
      job: notifySlackJob,
      toJobPayload: (payload: unknown) => ({ type, payload }),
    }),
  );
}
