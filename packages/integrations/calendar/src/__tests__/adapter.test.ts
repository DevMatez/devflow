import { describe, expect, it, vi } from 'vitest';
import { createGoogleCalendarAdapter } from '../adapter';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

const ctx = { organizationId: 'org-1', connectionId: 'conn-1' } as never;

describe('createGoogleCalendarAdapter', () => {
  it('listEvents maps events.list into CalendarEvent[]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'evt-1',
            summary: 'Standup',
            start: { dateTime: '2026-01-01T10:00:00Z' },
            end: { dateTime: '2026-01-01T10:30:00Z' },
          },
        ],
      }),
    );
    const adapter = createGoogleCalendarAdapter({
      accessToken: 'token',
      calendarId: 'primary',
      fetch: fetchImpl,
    });

    const events = await adapter.listEvents(ctx, {
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-01-08T00:00:00Z'),
    });

    expect(events).toEqual([
      {
        externalId: 'evt-1',
        title: 'Standup',
        start: '2026-01-01T10:00:00Z',
        end: '2026-01-01T10:30:00Z',
        url: null,
      },
    ]);
    const [url] = fetchImpl.mock.calls[0]!;
    expect(url).toContain('/calendars/primary/events?');
    expect(url).toContain('singleEvents=true');
  });

  it('getFreeBusy maps freeBusy.query into FreeBusySlot[]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        calendars: {
          primary: { busy: [{ start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' }] },
        },
      }),
    );
    const adapter = createGoogleCalendarAdapter({
      accessToken: 'token',
      calendarId: 'primary',
      fetch: fetchImpl,
    });

    const slots = await adapter.getFreeBusy(ctx, {
      from: new Date('2026-01-01T00:00:00Z'),
      to: new Date('2026-01-08T00:00:00Z'),
    });

    expect(slots).toEqual([{ start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/freeBusy',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('createEvent maps events.insert into a CalendarEvent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'evt-2',
        summary: 'New event',
        htmlLink: 'https://calendar.google.com/event?eid=evt-2',
        start: { dateTime: '2026-01-01T10:00:00Z' },
        end: { dateTime: '2026-01-01T10:30:00Z' },
      }),
    );
    const adapter = createGoogleCalendarAdapter({
      accessToken: 'token',
      calendarId: 'primary',
      fetch: fetchImpl,
    });

    const event = await adapter.createEvent(ctx, {
      title: 'New event',
      start: '2026-01-01T10:00:00Z',
      end: '2026-01-01T10:30:00Z',
    });

    expect(event.externalId).toBe('evt-2');
    expect(event.url).toBe('https://calendar.google.com/event?eid=evt-2');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
