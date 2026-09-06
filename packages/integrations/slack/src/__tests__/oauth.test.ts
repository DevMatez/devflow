import { describe, expect, it, vi } from 'vitest';
import { buildSlackAuthorizeUrl, exchangeSlackCode, SlackOAuthError } from '../oauth';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

const config = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://example.test/callback',
  scopes: 'chat:write,channels:read,groups:read',
};

describe('buildSlackAuthorizeUrl', () => {
  it('builds the authorize URL with client_id, scope, redirect_uri, and state', () => {
    const url = new URL(buildSlackAuthorizeUrl(config, 'the-state'));
    expect(url.origin + url.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('scope')).toBe(config.scopes);
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('state')).toBe('the-state');
  });
});

describe('exchangeSlackCode', () => {
  it('resolves the bot token, bot user id, and team info on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        access_token: 'xoxb-1-2-3',
        bot_user_id: 'U0KRQLJ9H',
        team: { id: 'T9TK3CUKW', name: 'Acme' },
      }),
    );

    const result = await exchangeSlackCode(config, 'a-code', fetchImpl);

    expect(result).toEqual({
      botAccessToken: 'xoxb-1-2-3',
      botUserId: 'U0KRQLJ9H',
      teamId: 'T9TK3CUKW',
      teamName: 'Acme',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://slack.com/api/oauth.v2.access',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws SlackOAuthError when Slack returns ok:false', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: 'invalid_code' }));
    await expect(exchangeSlackCode(config, 'bad-code', fetchImpl)).rejects.toThrow(SlackOAuthError);
  });

  it('throws SlackOAuthError when required fields are missing despite ok:true', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    await expect(exchangeSlackCode(config, 'a-code', fetchImpl)).rejects.toThrow(SlackOAuthError);
  });
});
