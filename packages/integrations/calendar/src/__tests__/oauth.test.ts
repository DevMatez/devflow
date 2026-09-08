import { describe, expect, it, vi } from 'vitest';
import { buildGoogleAuthorizeUrl, exchangeGoogleCode, GoogleOAuthError } from '../oauth';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const config = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://example.test/api/v1/integrations/calendar/callback',
  scopes:
    'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events email',
};

describe('buildGoogleAuthorizeUrl', () => {
  it('builds the authorize URL with offline access and forced consent', () => {
    const url = new URL(buildGoogleAuthorizeUrl(config, 'the-state'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('scope')).toBe(config.scopes);
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });
});

describe('exchangeGoogleCode', () => {
  it('resolves the access token, refresh token, and email on success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1' }))
      .mockResolvedValueOnce(jsonResponse({ email: '[email protected]' }));

    const result = await exchangeGoogleCode(config, 'a-code', fetchImpl);

    expect(result).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      email: '[email protected]',
    });
  });

  it('resolves with a null email when the userinfo call fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1' }))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

    const result = await exchangeGoogleCode(config, 'a-code', fetchImpl);
    expect(result.email).toBeNull();
  });

  it('throws GoogleOAuthError when no refresh_token is returned', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ access_token: 'at-1' }));
    await expect(exchangeGoogleCode(config, 'a-code', fetchImpl)).rejects.toThrow(GoogleOAuthError);
  });

  it('throws GoogleOAuthError on a non-ok token response', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));
    await expect(exchangeGoogleCode(config, 'bad-code', fetchImpl)).rejects.toThrow(
      GoogleOAuthError,
    );
  });
});
