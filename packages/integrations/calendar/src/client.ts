const BASE_URL = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleCalendarClientOptions {
  accessToken: string;
  /** When provided, a 401 triggers exactly one refresh + retry (design doc §8 — transparent to the port caller). */
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  /** Injected for tests (matches the codebase's fetchImpl DI convention); defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Called with the newly minted access token after a successful refresh, so the caller can persist it. */
  onTokenRefreshed?: (accessToken: string) => void;
}

export class GoogleCalendarApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface TokenRefreshResponse {
  access_token: string;
  expires_in: number;
}

async function refreshAccessToken(
  options: Required<
    Pick<GoogleCalendarClientOptions, 'refreshToken' | 'clientId' | 'clientSecret'>
  >,
  doFetch: typeof globalThis.fetch,
): Promise<string> {
  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      refresh_token: options.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok)
    throw new GoogleCalendarApiError(res.status, 'Failed to refresh Google access token');
  const data = (await res.json()) as TokenRefreshResponse;
  return data.access_token;
}

/** Thin fetch wrapper over the Calendar API v3 — refreshes the access token once on a 401, then retries. */
export function createGoogleCalendarClient(options: GoogleCalendarClientOptions) {
  const doFetch = options.fetch ?? fetch;
  let accessToken = options.accessToken;

  async function request<T>(
    method: string,
    url: string,
    body?: unknown,
    retried = false,
  ): Promise<T> {
    const res = await doFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (
      res.status === 401 &&
      !retried &&
      options.refreshToken &&
      options.clientId &&
      options.clientSecret
    ) {
      accessToken = await refreshAccessToken(
        {
          refreshToken: options.refreshToken,
          clientId: options.clientId,
          clientSecret: options.clientSecret,
        },
        doFetch,
      );
      options.onTokenRefreshed?.(accessToken);
      return request<T>(method, url, body, true);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GoogleCalendarApiError(
        res.status,
        `Google Calendar API ${method} ${url} failed (${res.status}): ${text}`,
      );
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  return {
    get: <T>(path: string) => request<T>('GET', `${BASE_URL}${path}`),
    post: <T>(path: string, body: unknown) => request<T>('POST', `${BASE_URL}${path}`, body),
  };
}

export type GoogleCalendarClient = ReturnType<typeof createGoogleCalendarClient>;
