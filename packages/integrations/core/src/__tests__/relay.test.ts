import { describe, expect, it, vi } from 'vitest';
import { relayWebhooksOnce, type WebhookEventRecord } from '../relay';
import type { WebhookHandler, NormalizedWebhookEvent } from '../webhook';

function makeRow(overrides: Partial<WebhookEventRecord> = {}): WebhookEventRecord {
  return {
    id: 'row-1',
    provider: 'github',
    eventType: 'pull_request',
    payload: { action: 'opened' },
    organizationId: 'org-1',
    connectionId: 'conn-1',
    ...overrides,
  };
}

function makeHandler(overrides: Partial<WebhookHandler> = {}): WebhookHandler {
  return {
    verify: vi.fn(),
    extractDeliveryId: vi.fn(),
    resolveConnection: vi.fn(),
    normalize: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('relayWebhooksOnce', () => {
  it('normalizes claimed rows and publishes their events', async () => {
    const row = makeRow();
    const events: NormalizedWebhookEvent[] = [
      { type: 'sourcecontrol.pull_request.opened', aggregateId: 'pr-1', payload: { number: 1 } },
    ];
    const normalize = vi.fn().mockResolvedValue(events);
    const processEvents = vi.fn().mockResolvedValue(undefined);
    const markFailed = vi.fn();

    const result = await relayWebhooksOnce({
      claimBatch: async () => [row],
      handlers: { github: makeHandler({ normalize }) },
      eventTypeHeader: () => 'x-github-event',
      processEvents,
      markFailed,
      relayId: 'relay-1',
    });

    expect(result).toEqual({ claimed: 1, processed: 1 });
    expect(normalize).toHaveBeenCalledWith({
      headers: { 'x-github-event': 'pull_request' },
      rawBody: Buffer.from(JSON.stringify(row.payload)),
    });
    expect(processEvents).toHaveBeenCalledWith(row, events);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it('records a failed attempt when no handler is registered for the provider', async () => {
    const row = makeRow({ provider: 'unknown-vendor' });
    const markFailed = vi.fn();

    const result = await relayWebhooksOnce({
      claimBatch: async () => [row],
      handlers: {},
      eventTypeHeader: () => 'x-event',
      processEvents: vi.fn(),
      markFailed,
      relayId: 'relay-1',
    });

    expect(result).toEqual({ claimed: 1, processed: 0 });
    expect(markFailed).toHaveBeenCalledWith(row.id, expect.stringContaining('unknown-vendor'));
  });

  it('records a failed attempt instead of normalizing when the connection is unresolved', async () => {
    const row = makeRow({ organizationId: null, connectionId: null });
    const normalize = vi.fn();
    const markFailed = vi.fn();

    const result = await relayWebhooksOnce({
      claimBatch: async () => [row],
      handlers: { github: makeHandler({ normalize }) },
      eventTypeHeader: () => 'x-github-event',
      processEvents: vi.fn(),
      markFailed,
      relayId: 'relay-1',
    });

    expect(result).toEqual({ claimed: 1, processed: 0 });
    expect(normalize).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(row.id, 'Webhook event has no resolved connection');
  });

  it('records a failed attempt when normalize() throws, without calling processEvents', async () => {
    const row = makeRow();
    const normalize = vi.fn().mockRejectedValue(new Error('boom'));
    const processEvents = vi.fn();
    const markFailed = vi.fn();

    const result = await relayWebhooksOnce({
      claimBatch: async () => [row],
      handlers: { github: makeHandler({ normalize }) },
      eventTypeHeader: () => 'x-github-event',
      processEvents,
      markFailed,
      relayId: 'relay-1',
    });

    expect(result).toEqual({ claimed: 1, processed: 0 });
    expect(processEvents).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith(row.id, 'boom');
  });

  it('processes an empty claim batch as a no-op', async () => {
    const result = await relayWebhooksOnce({
      claimBatch: async () => [],
      handlers: {},
      eventTypeHeader: () => 'x-event',
      processEvents: vi.fn(),
      markFailed: vi.fn(),
      relayId: 'relay-1',
    });

    expect(result).toEqual({ claimed: 0, processed: 0 });
  });
});
