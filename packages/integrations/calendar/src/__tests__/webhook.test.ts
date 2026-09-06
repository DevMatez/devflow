import { describe, expect, it, vi } from 'vitest';
import { createGoogleCalendarWebhookHandler } from '../webhook';
import type { RawWebhookRequest } from '@devflow/integrations-core';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeRequest(headers: Record<string, string> = {}): RawWebhookRequest {
  return { headers, rawBody: Buffer.alloc(0) };
}

function makeHandler(
  overrides: {
    getChannelToken?: (channelId: string) => Promise<string | null>;
    findConnectionByChannelId?: (channelId: string) => Promise<unknown>;
    getSyncContext?: (channelId: string) => Promise<unknown>;
    updateSyncToken?: (channelId: string, syncToken: string | null) => Promise<void>;
    fetch?: typeof fetch;
  } = {},
) {
  return createGoogleCalendarWebhookHandler({
    getChannelToken: overrides.getChannelToken ?? (async () => 'channel-secret'),
    findConnectionByChannelId: (overrides.findConnectionByChannelId ?? vi.fn()) as never,
    getSyncContext: (overrides.getSyncContext ?? vi.fn()) as never,
    updateSyncToken: overrides.updateSyncToken ?? vi.fn(),
    fetch: overrides.fetch,
  });
}

describe('createGoogleCalendarWebhookHandler: verify', () => {
  it('resolves when the channel token matches', async () => {
    const handler = makeHandler();
    await expect(
      handler.verify(
        makeRequest({ 'x-goog-channel-id': 'channel-1', 'x-goog-channel-token': 'channel-secret' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('throws when the channel id header is missing', async () => {
    const handler = makeHandler();
    await expect(handler.verify(makeRequest())).rejects.toThrow('Missing X-Goog-Channel-ID header');
  });

  it('throws when the channel is unknown', async () => {
    const handler = makeHandler({ getChannelToken: async () => null });
    await expect(
      handler.verify(
        makeRequest({ 'x-goog-channel-id': 'channel-1', 'x-goog-channel-token': 'x' }),
      ),
    ).rejects.toThrow('Unknown notification channel');
  });

  it('throws when the token does not match', async () => {
    const handler = makeHandler();
    await expect(
      handler.verify(
        makeRequest({ 'x-goog-channel-id': 'channel-1', 'x-goog-channel-token': 'wrong' }),
      ),
    ).rejects.toThrow('Invalid X-Goog-Channel-Token');
  });
});

describe('createGoogleCalendarWebhookHandler: extractDeliveryId', () => {
  it('returns the channelId:messageNumber composite key', () => {
    const handler = makeHandler();
    const id = handler.extractDeliveryId(
      makeRequest({ 'x-goog-channel-id': 'channel-1', 'x-goog-message-number': '5' }),
    );
    expect(id).toBe('channel-1:5');
  });

  it('throws when either header is missing', () => {
    const handler = makeHandler();
    expect(() =>
      handler.extractDeliveryId(makeRequest({ 'x-goog-channel-id': 'channel-1' })),
    ).toThrow();
  });
});

describe('createGoogleCalendarWebhookHandler: resolveConnection', () => {
  it('looks up the connection by channel id', async () => {
    const findConnectionByChannelId = vi
      .fn()
      .mockResolvedValue({ organizationId: 'org-1', connectionId: 'conn-1' });
    const handler = makeHandler({ findConnectionByChannelId });

    const resolved = await handler.resolveConnection(
      makeRequest({ 'x-goog-channel-id': 'channel-1' }),
    );

    expect(findConnectionByChannelId).toHaveBeenCalledWith('channel-1');
    expect(resolved).toEqual({ organizationId: 'org-1', connectionId: 'conn-1' });
  });

  it('returns null when the channel id header is missing', async () => {
    const handler = makeHandler();
    expect(await handler.resolveConnection(makeRequest())).toBeNull();
  });
});

describe('createGoogleCalendarWebhookHandler: normalize', () => {
  it('returns [] when no sync context is found for the channel', async () => {
    const handler = makeHandler({ getSyncContext: async () => null });
    const events = await handler.normalize(makeRequest({ 'x-goog-channel-id': 'channel-1' }));
    expect(events).toEqual([]);
  });

  it('returns [] when the channel id header is missing', async () => {
    const handler = makeHandler();
    expect(await handler.normalize(makeRequest())).toEqual([]);
  });

  it('runs an incremental sync, maps events, and persists the new sync token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'evt-1',
            summary: 'Standup',
            status: 'confirmed',
            start: { dateTime: '2026-01-01T10:00:00Z' },
            end: { dateTime: '2026-01-01T10:30:00Z' },
          },
          { id: 'evt-2', summary: 'Cancelled meeting', status: 'cancelled' },
        ],
        nextSyncToken: 'sync-token-2',
      }),
    );
    const updateSyncToken = vi.fn();
    const handler = makeHandler({
      getSyncContext: async () => ({
        calendarId: 'primary',
        syncToken: 'sync-token-1',
        accessToken: 'token',
      }),
      updateSyncToken,
      fetch: fetchImpl,
    });

    const events = await handler.normalize(makeRequest({ 'x-goog-channel-id': 'channel-1' }));

    expect(events).toEqual([
      {
        type: 'calendar.event.updated',
        aggregateId: 'evt-1',
        payload: {
          externalId: 'evt-1',
          title: 'Standup',
          start: '2026-01-01T10:00:00Z',
          end: '2026-01-01T10:30:00Z',
          url: null,
        },
      },
      {
        type: 'calendar.event.cancelled',
        aggregateId: 'evt-2',
        payload: { externalId: 'evt-2', title: 'Cancelled meeting', start: '', end: '', url: null },
      },
    ]);
    expect(updateSyncToken).toHaveBeenCalledWith('channel-1', 'sync-token-2');
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining('syncToken=sync-token-1'),
      expect.anything(),
    );
  });

  it('clears the sync token and returns [] on a 410 (expired token)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('gone', { status: 410 }));
    const updateSyncToken = vi.fn();
    const handler = makeHandler({
      getSyncContext: async () => ({
        calendarId: 'primary',
        syncToken: 'stale-token',
        accessToken: 'token',
      }),
      updateSyncToken,
      fetch: fetchImpl,
    });

    const events = await handler.normalize(makeRequest({ 'x-goog-channel-id': 'channel-1' }));
    expect(events).toEqual([]);
    expect(updateSyncToken).toHaveBeenCalledWith('channel-1', null);
  });
});
