import type {
  CalendarPort,
  CreateCalendarEventInput,
  CalendarEvent,
  FreeBusySlot,
} from '@devflow/integrations-core';
import { createGoogleCalendarClient, type GoogleCalendarClientOptions } from './client';
import {
  toCalendarEvent,
  toFreeBusySlot,
  type GoogleEvent,
  type GoogleFreeBusySlot,
} from './mappers';

export interface GoogleCalendarAdapterOptions extends GoogleCalendarClientOptions {
  calendarId: string;
}

interface EventsListResponse {
  items: GoogleEvent[];
}

interface FreeBusyResponse {
  calendars: Record<string, { busy: GoogleFreeBusySlot[] }>;
}

/** One instance per resolved connection (built by the registry's createAdapter callback). */
export function createGoogleCalendarAdapter(options: GoogleCalendarAdapterOptions): CalendarPort {
  const client = createGoogleCalendarClient(options);
  const { calendarId } = options;

  return {
    async listEvents(_ctx, input: { from: Date; to: Date }): Promise<CalendarEvent[]> {
      const params = new URLSearchParams({
        timeMin: input.from.toISOString(),
        timeMax: input.to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
      });
      const data = await client.get<EventsListResponse>(
        `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
      );
      return (data.items ?? []).map(toCalendarEvent);
    },

    async getFreeBusy(_ctx, input: { from: Date; to: Date }): Promise<FreeBusySlot[]> {
      const data = await client.post<FreeBusyResponse>('/freeBusy', {
        timeMin: input.from.toISOString(),
        timeMax: input.to.toISOString(),
        items: [{ id: calendarId }],
      });
      const busy = data.calendars[calendarId]?.busy ?? [];
      return busy.map(toFreeBusySlot);
    },

    async createEvent(_ctx, input: CreateCalendarEventInput): Promise<CalendarEvent> {
      const event = await client.post<GoogleEvent>(
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          summary: input.title,
          description: input.description,
          start: { dateTime: input.start },
          end: { dateTime: input.end },
        },
      );
      return toCalendarEvent(event);
    },
  };
}
