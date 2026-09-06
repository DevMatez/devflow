import { describe, expect, it, vi } from 'vitest';
import { registerCalendarWatch } from '../watch';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

describe('registerCalendarWatch', () => {
  it('calls events.watch and maps the response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'channel-1',
        resourceId: 'resource-1',
        expiration: '1426325213000',
      }),
    );

    const result = await registerCalendarWatch(
      { accessToken: 'token-1', fetch: fetchImpl },
      {
        calendarId: 'primary',
        address: 'https://api.example.test/webhooks/calendar',
        channelToken: 'channel-secret',
      },
    );

    expect(result).toEqual({
      channelId: 'channel-1',
      resourceId: 'resource-1',
      expiration: 1426325213000,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events/watch',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"type":"web_hook"'),
      }),
    );
  });

  it('returns a null expiration when Google omits it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 'channel-1', resourceId: 'resource-1' }));

    const result = await registerCalendarWatch(
      { accessToken: 'token-1', fetch: fetchImpl },
      {
        calendarId: 'primary',
        address: 'https://api.example.test/webhooks/calendar',
        channelToken: 'channel-secret',
      },
    );

    expect(result.expiration).toBeNull();
  });
});
