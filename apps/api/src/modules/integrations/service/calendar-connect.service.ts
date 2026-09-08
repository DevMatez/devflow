import { randomBytes } from 'node:crypto';
import { decryptCredentials, encryptCredentials } from '@devflow/integrations-core';
import {
  exchangeGoogleCode,
  registerCalendarWatch,
  type GoogleOAuthConfig,
} from '@devflow/integrations-calendar';
import type { Database } from '@devflow/database';
import type { OrgContext } from '../../access/org-context';
import {
  connectOrReconnect,
  getConnectionByChannelId,
  updateConnectionExternalAccount,
  type ConnectionRow,
} from './connections.service';

const CALENDAR_ID = 'primary';

export interface GoogleCalendarCredentials {
  refreshToken: string;
  channelToken: string;
}

/**
 * Exchanges the code for tokens, registers a push-notification channel
 * (design doc §8's "channel-watch webhook"), then persists the connection.
 * The refresh token and channel token are the only secrets — everything
 * else (channel id, sync token, expiry) is mutable operational state kept
 * in the plaintext external_account jsonb.
 */
export async function completeGoogleCalendarInstall(
  db: Database,
  ctx: OrgContext,
  config: GoogleOAuthConfig,
  credentialsKey: Buffer,
  code: string,
  webhookUrl: string,
  fetchImpl?: typeof globalThis.fetch,
): Promise<ConnectionRow> {
  const result = await exchangeGoogleCode(config, code, fetchImpl);
  const channelToken = randomBytes(32).toString('hex');

  const watch = await registerCalendarWatch(
    { accessToken: result.accessToken, fetch: fetchImpl },
    { calendarId: CALENDAR_ID, address: webhookUrl, channelToken },
  );

  const credentials: GoogleCalendarCredentials = {
    refreshToken: result.refreshToken,
    channelToken,
  };
  const encrypted = encryptCredentials(credentialsKey, JSON.stringify(credentials));

  return connectOrReconnect(db, ctx, {
    category: 'calendar',
    provider: 'google',
    externalAccount: {
      email: result.email,
      calendarId: CALENDAR_ID,
      channelId: watch.channelId,
      resourceId: watch.resourceId,
      channelExpiration: watch.expiration,
      syncToken: null,
    },
    encryptedCredentials: encrypted.ciphertext,
    credentialsIv: encrypted.iv,
  });
}

interface CalendarExternalAccount {
  calendarId: string;
  syncToken: string | null;
}

function decryptCalendarCredentials(
  credentialsKey: Buffer,
  connection: ConnectionRow,
): GoogleCalendarCredentials {
  const decrypted = decryptCredentials(credentialsKey, {
    ciphertext: connection.encryptedCredentials,
    iv: connection.credentialsIv,
  });
  return JSON.parse(decrypted) as GoogleCalendarCredentials;
}

/** Webhook verify() lookup — decrypts only the connection matched by channel id. */
export async function getGoogleCalendarChannelToken(
  db: Database,
  credentialsKey: Buffer,
  channelId: string,
): Promise<string | null> {
  const connection = await getConnectionByChannelId(db, channelId);
  if (!connection) return null;
  try {
    return decryptCalendarCredentials(credentialsKey, connection).channelToken;
  } catch {
    return null;
  }
}

export interface GoogleCalendarSyncContextConfig {
  clientId: string;
  clientSecret: string;
}

/** Webhook normalize() lookup — decrypts the refresh token and mints a fresh access token for this sync. */
export async function getGoogleCalendarSyncContext(
  db: Database,
  credentialsKey: Buffer,
  config: GoogleCalendarSyncContextConfig,
  channelId: string,
  fetchImpl: typeof globalThis.fetch = fetch,
): Promise<{ calendarId: string; syncToken: string | null; accessToken: string } | null> {
  const connection = await getConnectionByChannelId(db, channelId);
  if (!connection) return null;

  const credentials = decryptCalendarCredentials(credentialsKey, connection);
  const externalAccount = connection.externalAccount as CalendarExternalAccount;

  const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: credentials.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!tokenRes.ok) return null;
  const { access_token: accessToken } = (await tokenRes.json()) as { access_token: string };

  return {
    calendarId: externalAccount.calendarId,
    syncToken: externalAccount.syncToken,
    accessToken,
  };
}

/** Persists the new (or cleared) sync token by resolving the connection's org from the channel id. */
export async function updateGoogleCalendarSyncToken(
  db: Database,
  channelId: string,
  syncToken: string | null,
): Promise<void> {
  const connection = await getConnectionByChannelId(db, channelId);
  if (!connection) return;
  await updateConnectionExternalAccount(db, connection.organizationId, 'calendar', { syncToken });
}
