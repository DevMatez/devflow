import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createSlackWebhookHandler } from '../webhook';
import type { RawWebhookRequest } from '@devflow/integrations-core';

const SECRET = 'test-slack-signing-secret';

function sign(secret: string, timestamp: string, body: string): string {
  const base = `v0:${timestamp}:${body}`;
  return `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
}

function makeRequest(
  payload: unknown,
  { timestamp, signature }: { timestamp?: string; signature?: string } = {},
): RawWebhookRequest {
  const body = JSON.stringify(payload);
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const sig = signature ?? sign(SECRET, ts, body);
  return {
    headers: { 'x-slack-signature': sig, 'x-slack-request-timestamp': ts },
    rawBody: Buffer.from(body),
  };
}

const basePayload = {
  type: 'event_callback',
  team_id: 'T123',
  api_app_id: 'A123',
  event_id: 'Ev123',
  event_time: 1234567890,
  event: { type: 'message', channel: 'C123', ts: '1503435956.000247', text: 'hi' },
};

function makeHandler(findConnectionByTeamId = vi.fn()) {
  return createSlackWebhookHandler({ signingSecret: SECRET, findConnectionByTeamId });
}

describe('createSlackWebhookHandler: verify', () => {
  it('resolves for a validly signed, fresh payload', async () => {
    const handler = makeHandler();
    await expect(handler.verify(makeRequest(basePayload))).resolves.toBeUndefined();
  });

  it('throws when the signature header is missing', async () => {
    const handler = makeHandler();
    const request = makeRequest(basePayload);
    delete request.headers['x-slack-signature'];
    await expect(handler.verify(request)).rejects.toThrow('Missing X-Slack-Signature header');
  });

  it('throws when the timestamp header is missing', async () => {
    const handler = makeHandler();
    const request = makeRequest(basePayload);
    delete request.headers['x-slack-request-timestamp'];
    await expect(handler.verify(request)).rejects.toThrow(
      'Missing X-Slack-Request-Timestamp header',
    );
  });

  it('rejects a stale timestamp even with a validly-computed signature (replay defense)', async () => {
    const handler = makeHandler();
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 10 * 60);
    const request = makeRequest(basePayload, { timestamp: staleTimestamp });
    await expect(handler.verify(request)).rejects.toThrow('Slack request timestamp is too old');
  });

  it('rejects a signature that does not match', async () => {
    const handler = makeHandler();
    const request = makeRequest(basePayload, { signature: 'v0=deadbeef' });
    await expect(handler.verify(request)).rejects.toThrow('Invalid Slack webhook signature');
  });
});

describe('createSlackWebhookHandler: extractDeliveryId', () => {
  it('returns event_id', () => {
    const handler = makeHandler();
    expect(handler.extractDeliveryId(makeRequest(basePayload))).toBe('Ev123');
  });

  it('throws when event_id is missing', () => {
    const handler = makeHandler();
    const payload = { ...basePayload, event_id: undefined };
    expect(() => handler.extractDeliveryId(makeRequest(payload))).toThrow(
      'Missing event_id in Slack event payload',
    );
  });
});

describe('createSlackWebhookHandler: resolveConnection', () => {
  it('looks up the connection by team_id', async () => {
    const findConnectionByTeamId = vi
      .fn()
      .mockResolvedValue({ organizationId: 'org-1', connectionId: 'conn-1' });
    const handler = makeHandler(findConnectionByTeamId);

    const resolved = await handler.resolveConnection(makeRequest(basePayload));

    expect(findConnectionByTeamId).toHaveBeenCalledWith('T123');
    expect(resolved).toEqual({ organizationId: 'org-1', connectionId: 'conn-1' });
  });

  it('returns null when team_id is missing', async () => {
    const handler = makeHandler();
    const payload = { ...basePayload, team_id: undefined };
    const resolved = await handler.resolveConnection(makeRequest(payload));
    expect(resolved).toBeNull();
  });
});

describe('createSlackWebhookHandler: normalize', () => {
  it('normalizes a message event', async () => {
    const handler = makeHandler();
    const events = await handler.normalize(makeRequest(basePayload));
    expect(events).toEqual([
      {
        type: 'chat.message.posted',
        aggregateId: '1503435956.000247',
        payload: basePayload.event,
      },
    ]);
  });

  it('returns an empty array for a non-message inner event type', async () => {
    const handler = makeHandler();
    const payload = { ...basePayload, event: { type: 'reaction_added' } };
    const events = await handler.normalize(makeRequest(payload));
    expect(events).toEqual([]);
  });

  it('returns an empty array when the event has no ts', async () => {
    const handler = makeHandler();
    const payload = { ...basePayload, event: { type: 'message', channel: 'C123' } };
    const events = await handler.normalize(makeRequest(payload));
    expect(events).toEqual([]);
  });
});
