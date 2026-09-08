import type { CalendarEvent, FreeBusySlot } from '@devflow/integrations-core';

export interface GoogleEventDateTime {
  dateTime?: string;
  date?: string;
}

export interface GoogleEvent {
  id: string;
  summary?: string;
  status?: string;
  htmlLink?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
}

export interface GoogleFreeBusySlot {
  start: string;
  end: string;
}

/** All-day events carry `date` instead of `dateTime` — fall back so callers always get a usable timestamp string. */
function eventTime(dt: GoogleEventDateTime | undefined): string {
  return dt?.dateTime ?? dt?.date ?? '';
}

export function toCalendarEvent(event: GoogleEvent): CalendarEvent {
  return {
    externalId: event.id,
    title: event.summary ?? '',
    start: eventTime(event.start),
    end: eventTime(event.end),
    url: event.htmlLink ?? null,
  };
}

export function toFreeBusySlot(slot: GoogleFreeBusySlot): FreeBusySlot {
  return { start: slot.start, end: slot.end };
}
