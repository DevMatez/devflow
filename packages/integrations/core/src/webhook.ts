import type { OrganizationId } from '@devflow/types';

export interface RawWebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
}

export interface ResolvedConnection {
  organizationId: OrganizationId;
  connectionId: string;
}

/** Crosses into the outbox as-is — `type` matches a category event name (e.g. `sourcecontrol.pull_request.opened`). */
export interface NormalizedWebhookEvent {
  type: string;
  aggregateId: string;
  payload: unknown;
}

/**
 * Implemented per adapter, never by application code. See the Wave 2 design
 * doc §3.1 for the security invariant: a webhook must resolve to exactly one
 * connection before any provider data is processed.
 */
export interface WebhookHandler {
  /** Verifies the signature/secret; throws on failure. Never trusts payload before this. */
  verify(request: RawWebhookRequest): Promise<void>;
  /** Provider-native idempotency key — GitHub X-GitHub-Delivery, Plane event_id, etc. */
  extractDeliveryId(request: RawWebhookRequest): string;
  /** Resolves the specific connection (not just the org) — installation id, team id, calendar channel id, etc. */
  resolveConnection(request: RawWebhookRequest): Promise<ResolvedConnection | null>;
  /** Verified + connection-resolved payload → zero or more canonical domain events. */
  normalize(request: RawWebhookRequest): Promise<NormalizedWebhookEvent[]>;
}
