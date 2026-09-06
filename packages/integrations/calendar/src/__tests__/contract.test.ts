import { runCalendarPortContractTests } from '@devflow/integrations-core/contract-tests';
import type { ProviderContext } from '@devflow/integrations-core';
import { createGoogleCalendarAdapter } from '../adapter';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();

    if (method === 'GET' && url.pathname === '/calendar/v3/calendars/primary/events') {
      return jsonResponse({
        items: [
          {
            id: 'evt-1',
            summary: 'Contract test event',
            start: { dateTime: '2026-01-01T10:00:00Z' },
            end: { dateTime: '2026-01-01T10:30:00Z' },
          },
        ],
      });
    }
    if (method === 'POST' && url.pathname === '/calendar/v3/freeBusy') {
      return jsonResponse({ calendars: { primary: { busy: [] } } });
    }
    if (method === 'POST' && url.pathname === '/calendar/v3/calendars/primary/events') {
      return jsonResponse({
        id: 'evt-2',
        summary: 'Contract test event',
        start: { dateTime: '2026-01-01T00:00:00Z' },
        end: { dateTime: '2026-01-08T00:00:00Z' },
      });
    }
    throw new Error(`Unhandled fetch in contract test: ${method} ${url.pathname}`);
  }) as unknown as typeof fetch;
}

runCalendarPortContractTests('google-calendar', {
  createPort: () =>
    createGoogleCalendarAdapter({
      accessToken: 'token',
      calendarId: 'primary',
      fetch: fakeFetch(),
    }),
  ctx: { organizationId: 'org-1' as ProviderContext['organizationId'], connectionId: 'conn-1' },
});
