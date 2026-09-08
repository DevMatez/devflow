const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Space-separated (design doc §8: calendar.readonly + calendar.events; `email` added here for display only). */
  scopes: string;
}

export function buildGoogleAuthorizeUrl(config: GoogleOAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('state', state);
  // offline + consent: the connection must keep working without the user present (design doc §8) -- needs a refresh token.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export interface GoogleOAuthAccessResult {
  accessToken: string;
  refreshToken: string;
  email: string | null;
}

interface GoogleTokenResponse {
  error?: string;
  access_token?: string;
  refresh_token?: string;
}

interface GoogleUserInfoResponse {
  email?: string;
}

export class GoogleOAuthError extends Error {}

/** Exchanges the temporary authorization code for tokens, then fetches the account email for display (design doc §8). */
export async function exchangeGoogleCode(
  config: GoogleOAuthConfig,
  code: string,
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<GoogleOAuthAccessResult> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });

  if (!res.ok) {
    // Google's token errors are normally JSON, but a gateway/proxy failure could return HTML/empty.
    const message = await res
      .json()
      .then((body: unknown) => (body as GoogleTokenResponse).error)
      .catch(() => undefined);
    throw new GoogleOAuthError(message ?? `Google token exchange failed with status ${res.status}`);
  }

  const data = (await res.json()) as GoogleTokenResponse;
  if (!data.access_token || !data.refresh_token) {
    throw new GoogleOAuthError(
      'Google did not return an access/refresh token (was access_type=offline + consent honored?)',
    );
  }

  const userInfoRes = await fetchImpl(USERINFO_URL, {
    headers: { Authorization: `Bearer ${data.access_token}` },
  });
  const userInfo = userInfoRes.ok ? ((await userInfoRes.json()) as GoogleUserInfoResponse) : {};

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    email: userInfo.email ?? null,
  };
}
