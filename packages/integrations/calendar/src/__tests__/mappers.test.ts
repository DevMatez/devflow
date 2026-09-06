import { describe, expect, it } from 'vitest';
import { toCalendarEvent, toFreeBusySlot } from '../mappers';

describe('toCalendarEvent', () => {
  it('maps a timed event', () => {
    const event = toCalendarEvent({
      id: 'evt1',
      summary: 'Standup',
      status: 'confirmed',
      htmlLink: 'https://calendar.google.com/event?eid=evt1',
      start: { dateTime: '2026-01-01T10:00:00Z' },
      end: { dateTime: '2026-01-01T10:30:00Z' },
    });
    expect(event).toEqual({
      externalId: 'evt1',
      title: 'Standup',
      start: '2026-01-01T10:00:00Z',
      end: '2026-01-01T10:30:00Z',
      url: 'https://calendar.google.com/event?eid=evt1',
    });
  });

  it('falls back to the all-day `date` field when dateTime is absent', () => {
    const event = toCalendarEvent({
      id: 'evt2',
      start: { date: '2026-01-01' },
      end: { date: '2026-01-02' },
    });
    expect(event.start).toBe('2026-01-01');
    expect(event.end).toBe('2026-01-02');
    expect(event.title).toBe('');
    expect(event.url).toBeNull();
  });
});

describe('toFreeBusySlot', () => {
  it('maps start/end as-is', () => {
    expect(toFreeBusySlot({ start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' })).toEqual({
      start: '2026-01-01T10:00:00Z',
      end: '2026-01-01T11:00:00Z',
    });
  });
});
