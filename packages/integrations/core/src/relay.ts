import type { WebhookHandler, RawWebhookRequest, NormalizedWebhookEvent } from './webhook';

/** Row shape the composition root reads back from `webhook_events` for the relay to process. */
export interface WebhookEventRecord {
  id: string;
  provider: string;
  eventType: string;
  payload: unknown;
  organizationId: string | null;
  connectionId: string | null;
}

export interface WebhookRelayOptions {
  /**
   * Claims a batch of due rows (unprocessed, lease expired, and connection
   * already resolved) via `FOR UPDATE SKIP LOCKED` — injected so this
   * package never touches the database directly (mirrors `registry.ts`).
   */
  claimBatch(params: {
    relayId: string;
    batchSize: number;
    leaseMs: number;
  }): Promise<WebhookEventRecord[]>;
  /** One handler per provider; never a vendor SDK type crosses this boundary. */
  handlers: Record<string, WebhookHandler>;
  /** The header name `event_type` was originally extracted from, so `normalize()` sees the same shape live or replayed. */
  eventTypeHeader(provider: string): string;
  /** Publishes the normalized events and marks the row processed, atomically. */
  processEvents(row: WebhookEventRecord, events: NormalizedWebhookEvent[]): Promise<void>;
  /** Records a failed attempt; the row remains claimable once its lease expires. */
  markFailed(id: string, error: string): Promise<void>;
  /** Identifies this relay instance for claimed_by / lease diagnostics. */
  relayId: string;
  batchSize?: number;
  leaseMs?: number;
}

export interface WebhookRelayResult {
  claimed: number;
  processed: number;
}

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_LEASE_MS = 60_000;

function toRawRequest(row: WebhookEventRecord, headerName: string): RawWebhookRequest {
  return {
    headers: { [headerName]: row.eventType },
    rawBody: Buffer.from(JSON.stringify(row.payload)),
  };
}

/**
 * Runs a single claim -> normalize -> publish cycle. The authoritative
 * processing path (design doc §4) — a route's fast-path enqueue is only a
 * latency optimization, never a substitute for this. Intended to be called
 * in a loop/interval from a worker process, mirroring `relayOutboxOnce`.
 */
export async function relayWebhooksOnce(options: WebhookRelayOptions): Promise<WebhookRelayResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  const claimed = await options.claimBatch({ relayId: options.relayId, batchSize, leaseMs });

  let processed = 0;

  for (const row of claimed) {
    const handler = options.handlers[row.provider];
    if (!handler) {
      await options.markFailed(
        row.id,
        `No webhook handler registered for provider "${row.provider}"`,
      );
      continue;
    }

    // Security invariant (§3.1): never normalize without a resolved connection.
    // claimBatch is expected to filter these out already; this is defense in depth.
    if (!row.organizationId || !row.connectionId) {
      await options.markFailed(row.id, 'Webhook event has no resolved connection');
      continue;
    }

    try {
      const rawRequest = toRawRequest(row, options.eventTypeHeader(row.provider));
      const events = await handler.normalize(rawRequest);
      await options.processEvents(row, events);
      processed += 1;
    } catch (error) {
      await options.markFailed(row.id, error instanceof Error ? error.message : String(error));
    }
  }

  return { claimed: claimed.length, processed };
}
