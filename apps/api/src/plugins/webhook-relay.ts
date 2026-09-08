import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';
import { relayWebhooksOnce, type WebhookRelayResult } from '@devflow/integrations-core';
import { publishOutbox } from '@devflow/events';
import {
  claimWebhookEvents,
  markWebhookEventProcessed,
  markWebhookEventFailed,
} from '../modules/integrations/dal/webhook-events.dal';
import { webhookHandlers, getEventTypeHeader } from '../modules/integrations/webhook-handlers';

const RELAY_INTERVAL_MS = 2_000;

declare module 'fastify' {
  interface FastifyInstance {
    /** Runs one claim -> normalize -> publish cycle on demand (route fast-path nudge). */
    runWebhookRelayOnce(): Promise<WebhookRelayResult>;
  }
}

/**
 * Starts the webhook relay loop — the authoritative processing path (design
 * doc §4), mirroring `outboxRelayPlugin` exactly. Also decorates
 * `runWebhookRelayOnce` so the webhook route can nudge it as a best-effort
 * latency optimization right after ingesting a delivery.
 */
export const webhookRelayPlugin = fp(async (app) => {
  const relayId = `api-webhooks-${randomUUID()}`;

  async function runOnce(): Promise<WebhookRelayResult> {
    return relayWebhooksOnce({
      relayId,
      handlers: webhookHandlers,
      eventTypeHeader: getEventTypeHeader,
      claimBatch: ({ batchSize, leaseMs }) =>
        claimWebhookEvents(app.db, { relayId, batchSize, leaseMs }),
      processEvents: (row, events) =>
        markWebhookEventProcessed(app.db, row.id, async (tx) => {
          for (const event of events) {
            await publishOutbox(tx, {
              id: randomUUID(),
              type: event.type,
              // Guaranteed non-null: claimBatch only returns connection-resolved rows (§3.1).
              organizationId: row.organizationId as string,
              aggregateId: event.aggregateId,
              correlationId: randomUUID(),
              occurredAt: new Date().toISOString(),
              schemaVersion: 1,
              payload: event.payload,
            });
          }
        }),
      markFailed: (id, error) => markWebhookEventFailed(app.db, id, error),
    });
  }

  app.decorate('runWebhookRelayOnce', runOnce);

  const timer = setInterval(() => {
    runOnce().catch((error: unknown) => {
      app.log.error({ err: error }, 'webhook relay cycle failed');
    });
  }, RELAY_INTERVAL_MS);
  timer.unref();

  app.addHook('onClose', async () => {
    clearInterval(timer);
  });
});
