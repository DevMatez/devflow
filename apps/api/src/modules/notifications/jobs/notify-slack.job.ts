import { defineJob } from '@devflow/queue';
import { z } from 'zod';
import type { Database } from '@devflow/database';
import type { FastifyBaseLogger } from 'fastify';
import { notifySlack, resolveSlackChat, type ResolveChat } from '../service/notify-slack.service';

export const notifySlackJobSchema: z.ZodType<{
  organizationId: string;
  type: string;
  payload?: unknown;
}> = z.object({
  organizationId: z.string(),
  type: z.string(),
  payload: z.unknown(),
});

/** Posts a short line to Slack for the key workflow events (design §1, §5, §15.3). Best-effort: never blocks the workflow. */
export function createNotifySlackJob(
  db: Database,
  logger: FastifyBaseLogger,
  credentialsKey: Buffer,
  resolve: ResolveChat = resolveSlackChat,
) {
  return defineJob({
    name: 'notify-slack',
    version: 1,
    schema: notifySlackJobSchema,
    timeout: 10_000,
    handler: async (payload) => {
      try {
        await notifySlack(
          db,
          { organizationId: payload.organizationId, type: payload.type, payload: payload.payload },
          credentialsKey,
          resolve,
        );
      } catch (error) {
        // Best-effort: a Slack outage must never fail the workflow it's notifying about.
        logger.warn({ err: error, type: payload.type }, 'notify-slack failed, ignoring');
      }
    },
  });
}
