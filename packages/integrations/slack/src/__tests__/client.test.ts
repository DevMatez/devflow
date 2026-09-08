import { describe, expect, it, vi } from 'vitest';
import { createSlackClient, SlackApiError } from '../client';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

describe('createSlackClient', () => {
  it('sends a Bearer token and returns the parsed response on ok:true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, channels: [] }));
    const client = createSlackClient({ botToken: 'xoxb-test', fetch: fetchImpl });

    const data = await client.call('conversations.list', { types: 'public_channel' });

    expect(data).toEqual({ ok: true, channels: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://slack.com/api/conversations.list',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer xoxb-test' }),
      }),
    );
  });

  it('throws SlackApiError with the error code on ok:false', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => jsonResponse({ ok: false, error: 'channel_not_found' }));
    const client = createSlackClient({ botToken: 'xoxb-test', fetch: fetchImpl });

    await expect(client.call('chat.postMessage', {})).rejects.toThrow(SlackApiError);
    await expect(client.call('chat.postMessage', {})).rejects.toMatchObject({
      slackError: 'channel_not_found',
    });
  });
});
