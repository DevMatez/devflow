import { describe, expect, it, vi } from 'vitest';
import { createGoogleCalendarClient, GoogleCalendarApiError } from '../client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createGoogleCalendarClient', () => {
  it('sends a Bearer token and returns parsed JSON on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    const client = createGoogleCalendarClient({ accessToken: 'token-1', fetch: fetchImpl });

    const data = await client.get('/calendars/primary/events');

    expect(data).toEqual({ items: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-1' }),
      }),
    );
  });

  it('refreshes the access token once on a 401 and retries, notifying onTokenRefreshed', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => new Response('unauthorized', { status: 401 }))
      .mockImplementationOnce(async () =>
        jsonResponse({ access_token: 'token-2', expires_in: 3600 }),
      )
      .mockImplementationOnce(async () => jsonResponse({ items: [] }));
    const onTokenRefreshed = vi.fn();

    const client = createGoogleCalendarClient({
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      fetch: fetchImpl,
      onTokenRefreshed,
    });

    const data = await client.get('/calendars/primary/events');

    expect(data).toEqual({ items: [] });
    expect(onTokenRefreshed).toHaveBeenCalledWith('token-2');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token-2' }),
      }),
    );
  });

  it('throws on a 401 without retrying when no refresh credentials are provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const client = createGoogleCalendarClient({ accessToken: 'token-1', fetch: fetchImpl });

    await expect(client.get('/calendars/primary/events')).rejects.toThrow(GoogleCalendarApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws GoogleCalendarApiError with the status on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('gone', { status: 410 }));
    const client = createGoogleCalendarClient({ accessToken: 'token-1', fetch: fetchImpl });

    await expect(client.get('/calendars/primary/events')).rejects.toMatchObject({ status: 410 });
  });

  it('returns undefined for a 204 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createGoogleCalendarClient({ accessToken: 'token-1', fetch: fetchImpl });

    expect(await client.post('/calendars/primary/events', {})).toBeUndefined();
  });
});
