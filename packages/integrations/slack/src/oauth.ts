const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
const ACCESS_URL = 'https://slack.com/api/oauth.v2.access';

export interface SlackOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Bot scopes, comma-separated (design doc §7: chat:write, channels:read, groups:read). */
  scopes: string;
}

export function buildSlackAuthorizeUrl(config: SlackOAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', config.scopes);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export interface SlackOAuthAccessResult {
  botAccessToken: string;
  botUserId: string;
  teamId: string;
  teamName: string;
}

interface SlackOAuthAccessResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  bot_user_id?: string;
  team?: { id: string; name: string };
}

export class SlackOAuthError extends Error {}

/** Exchanges the temporary authorization code for a bot token (design doc §7). */
export async function exchangeSlackCode(
  config: SlackOAuthConfig,
  code: string,
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<SlackOAuthAccessResult> {
  const res = await fetchImpl(ACCESS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }).toString(),
  });

  const data = (await res.json()) as SlackOAuthAccessResponse;
  if (!data.ok || !data.access_token || !data.bot_user_id || !data.team) {
    throw new SlackOAuthError(data.error ?? 'Slack did not return a bot token');
  }

  return {
    botAccessToken: data.access_token,
    botUserId: data.bot_user_id,
    teamId: data.team.id,
    teamName: data.team.name,
  };
}
