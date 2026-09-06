import { randomUUID } from 'node:crypto';
import { createGoogleCalendarClient, type GoogleCalendarClientOptions } from './client';

export interface RegisterWatchInput {
  calendarId: string;
  /** Our webhook receiving URL (design doc §8's "channel-watch webhook"). */
  address: string;
  /** Echoed back in X-Goog-Channel-Token on every notification — the verifiable secret (design doc §8). */
  channelToken: string;
}

export interface WatchChannel {
  channelId: string;
  resourceId: string;
  /** Unix ms timestamp, or null if Google didn't return one. */
  expiration: number | null;
}

interface WatchResponse {
  id: string;
  resourceId: string;
  expiration?: string;
}

/** Calls `events.watch` to register a push-notification channel for a calendar (design doc §8). */
export async function registerCalendarWatch(
  options: GoogleCalendarClientOptions,
  input: RegisterWatchInput,
): Promise<WatchChannel> {
  const client = createGoogleCalendarClient(options);
  const channelId = randomUUID();

  const data = await client.post<WatchResponse>(
    `/calendars/${encodeURIComponent(input.calendarId)}/events/watch`,
    {
      id: channelId,
      type: 'web_hook',
      address: input.address,
      token: input.channelToken,
    },
  );

  return {
    channelId: data.id,
    resourceId: data.resourceId,
    expiration: data.expiration ? Number(data.expiration) : null,
  };
}
