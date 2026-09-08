import { defineRoute, type EventRoute } from '@devflow/events';
import type { JobHandle } from '@devflow/queue';
import { SystemPinged } from './events';
import type { systemPingJobSchema } from './jobs/system-ping.job';

/** Maps `system.pinged` events onto the `system-ping` queue job. */
export function createSystemPingRoute(
  job: JobHandle<typeof systemPingJobSchema>,
): EventRoute<{ message: string }> {
  return defineRoute({
    name: 'system-ping',
    event: SystemPinged,
    job,
    toJobPayload: (payload) => ({ message: payload.message }),
  });
}
