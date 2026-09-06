import type {
  WebhookHandler,
  RawWebhookRequest,
  ResolvedConnection,
  NormalizedWebhookEvent,
} from '@devflow/integrations-core';
import { createGoogleCalendarClient, GoogleCalendarApiError } from './client';
import { toCalendarEvent, type GoogleEvent } from './mappers';

export interface GoogleCalendarSyncContext {
  calendarId: string;
  syncToken: string | null;
  accessToken: string;
}

export interface GoogleCalendarWebhookHandlerOptions {
  findConnectionByChannelId(channelId: string): Promise<ResolvedConnection | null>;
  /** The channel token registered at watch-setup time — the verifiable secret (design doc §8), no per-payload signature exists. */
  getChannelToken(channelId: string): Promise<string | null>;
  /** Everything normalize() needs to run an incremental sync for this channel's calendar. */
  getSyncContext(channelId: string): Promise<GoogleCalendarSyncContext | null>;
  /** Persists the new (or cleared, on a 410) sync token. */
  updateSyncToken(channelId: string, syncToken: string | null): Promise<void>;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
}

function header(request: RawWebhookRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function runIncrementalSync(
  options: GoogleCalendarWebhookHandlerOptions,
  channelId: string,
  context: GoogleCalendarSyncContext,
): Promise<NormalizedWebhookEvent[]> {
  const client = createGoogleCalendarClient({
    accessToken: context.accessToken,
    fetch: options.fetch,
  });
  const params = new URLSearchParams({ singleEvents: 'true' });
  if (context.syncToken) params.set('syncToken', context.syncToken);

  let data: { items?: GoogleEvent[]; nextSyncToken?: string };
  try {
    data = await client.get(
      `/calendars/${encodeURIComponent(context.calendarId)}/events?${params.toString()}`,
    );
  } catch (error) {
    // 410 Gone: the sync token expired. Clear it and let the next cycle do a full resync (simple, safe default).
    if (error instanceof GoogleCalendarApiError && error.status === 410) {
      await options.updateSyncToken(channelId, null);
      return [];
    }
    throw error;
  }

  if (data.nextSyncToken) await options.updateSyncToken(channelId, data.nextSyncToken);

  return (data.items ?? []).map((item) => ({
    // Google's incremental sync doesn't distinguish created vs. updated, only cancelled vs. not (known MVP simplification).
    type: item.status === 'cancelled' ? 'calendar.event.cancelled' : 'calendar.event.updated',
    aggregateId: item.id,
    payload: toCalendarEvent(item),
  }));
}

/** Implements `WebhookHandler` for Calendar (design doc §8) — every method maps meaningfully, per the doc's mapping table. */
export function createGoogleCalendarWebhookHandler(
  options: GoogleCalendarWebhookHandlerOptions,
): WebhookHandler {
  return {
    async verify(request: RawWebhookRequest): Promise<void> {
      const channelId = header(request, 'x-goog-channel-id');
      const token = header(request, 'x-goog-channel-token');
      if (!channelId) throw new Error('Missing X-Goog-Channel-ID header');

      const expected = await options.getChannelToken(channelId);
      if (!expected) throw new Error('Unknown notification channel');
      if (token !== expected) throw new Error('Invalid X-Goog-Channel-Token');
    },

    extractDeliveryId(request: RawWebhookRequest): string {
      const channelId = header(request, 'x-goog-channel-id');
      const messageNumber = header(request, 'x-goog-message-number');
      if (!channelId || !messageNumber) {
        throw new Error('Missing X-Goog-Channel-ID/X-Goog-Message-Number header');
      }
      return `${channelId}:${messageNumber}`;
    },

    async resolveConnection(request: RawWebhookRequest): Promise<ResolvedConnection | null> {
      const channelId = header(request, 'x-goog-channel-id');
      if (!channelId) return null;
      return options.findConnectionByChannelId(channelId);
    },

    async normalize(request: RawWebhookRequest): Promise<NormalizedWebhookEvent[]> {
      // The channel id is the only thing that survives relay replay (it's stored as the generic
      // "event type" column, since Calendar has no vendor event-type concept of its own — design
      // doc §8: normalize() ignores the ping's body and calls back in using the stored sync token).
      const channelId = header(request, 'x-goog-channel-id');
      if (!channelId) return [];

      const context = await options.getSyncContext(channelId);
      if (!context) return [];

      return runIncrementalSync(options, channelId, context);
    },
  };
}
