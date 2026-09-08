import { describe, expect, it, vi } from 'vitest';
import { createSlackChatAdapter } from '../adapter';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

const ctx = { organizationId: 'org-1', connectionId: 'conn-1' } as never;

describe('createSlackChatAdapter', () => {
  it('listChannels maps conversations.list into ChatChannel[]', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        channels: [
          { id: 'C1', name: 'general' },
          { id: 'C2', name: 'random' },
        ],
      }),
    );
    const adapter = createSlackChatAdapter({ botToken: 'xoxb-test', fetch: fetchImpl });

    const channels = await adapter.listChannels(ctx);

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://slack.com/api/conversations.list',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(channels).toEqual([
      { externalId: 'C1', name: 'general' },
      { externalId: 'C2', name: 'random' },
    ]);
  });

  it('postMessage maps chat.postMessage into a ChatMessage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        channel: 'C123ABC456',
        ts: '1503435956.000247',
        message: { text: "Here's a message for you", bot_id: 'B123ABC456' },
      }),
    );
    const adapter = createSlackChatAdapter({ botToken: 'xoxb-test', fetch: fetchImpl });

    const message = await adapter.postMessage(ctx, {
      channelExternalId: 'C123ABC456',
      text: "Here's a message for you",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(message).toEqual({
      externalId: '1503435956.000247',
      channelExternalId: 'C123ABC456',
      text: "Here's a message for you",
      authorExternalId: 'B123ABC456',
      postedAt: new Date(1503435956000).toISOString(),
    });
  });
});
