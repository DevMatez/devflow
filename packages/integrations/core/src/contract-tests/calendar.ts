import { describe, expect, it } from 'vitest';
import type { CalendarPort } from '../ports';
import type { ProviderContext } from '../ports';

export interface CalendarContractFixtures {
  createPort(): CalendarPort;
  ctx: ProviderContext;
}

/**
 * Shared contract suite every `CalendarPort` adapter runs against its own
 * fixtures (design doc §14), mirroring the other three port suites.
 */
export function runCalendarPortContractTests(
  adapterName: string,
  fixtures: CalendarContractFixtures,
): void {
  describe(`CalendarPort contract: ${adapterName}`, () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-01-08T00:00:00Z');

    it('listEvents returns normalized CalendarEvent[] shape', async () => {
      const events = await fixtures.createPort().listEvents(fixtures.ctx, { from, to });
      expect(Array.isArray(events)).toBe(true);
      for (const event of events) {
        expect(event).toMatchObject({
          externalId: expect.any(String),
          title: expect.any(String),
          start: expect.any(String),
          end: expect.any(String),
        });
      }
    });

    it('getFreeBusy returns normalized FreeBusySlot[] shape', async () => {
      const slots = await fixtures.createPort().getFreeBusy(fixtures.ctx, { from, to });
      expect(Array.isArray(slots)).toBe(true);
      for (const slot of slots) {
        expect(slot).toMatchObject({ start: expect.any(String), end: expect.any(String) });
      }
    });

    it('createEvent returns a normalized CalendarEvent', async () => {
      const event = await fixtures.createPort().createEvent(fixtures.ctx, {
        title: 'Contract test event',
        start: from.toISOString(),
        end: to.toISOString(),
      });
      expect(event).toMatchObject({
        externalId: expect.any(String),
        title: expect.any(String),
        start: expect.any(String),
        end: expect.any(String),
      });
    });
  });
}
