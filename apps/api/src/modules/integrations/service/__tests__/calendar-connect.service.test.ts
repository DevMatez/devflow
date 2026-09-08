import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import { createOrganization } from '../../../organizations/service/organizations.service';
import { getConnection } from '../connections.service';
import {
  completeGoogleCalendarInstall,
  getGoogleCalendarChannelToken,
  getGoogleCalendarSyncContext,
  updateGoogleCalendarSyncToken,
} from '../calendar-connect.service';
import type { OrgContext } from '../../../access/org-context';
import type { OrganizationId, UserId } from '@devflow/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const googleConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://example.test/api/v1/integrations/calendar/callback',
  scopes:
    'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events email',
};

const webhookUrl = 'https://example.test/api/v1/webhooks/calendar';

function makeInstallFetch() {
  return vi
    .fn()
    .mockImplementationOnce(async () =>
      jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1' }),
    )
    .mockImplementationOnce(async () => jsonResponse({ email: '[email protected]' }))
    .mockImplementationOnce(async () =>
      jsonResponse({ id: 'channel-1', resourceId: 'resource-1', expiration: '1426325213000' }),
    );
}

describe('calendar-connect service', () => {
  let app: FastifyInstance;
  const credentialsKey = randomBytes(32);
  const createdUserIds: UserId[] = [];
  const createdOrgIds: OrganizationId[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    for (const id of createdOrgIds.splice(0)) {
      await app.db.delete(schema.organizations).where(eq(schema.organizations.id, id));
    }
  });

  afterAll(async () => {
    for (const id of createdUserIds.splice(0)) {
      await app.db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await app.close();
  });

  async function makeOrgContext(label: string): Promise<OrgContext> {
    const githubId = `calendar-connect-test-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);

    const org = await createOrganization(app.db, {
      name: `Calendar Connect Org ${label}`,
      userId: user.id as UserId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);

    return { organizationId: org.id as OrganizationId, userId: user.id as UserId, role: 'owner' };
  }

  it('exchanges the code, registers a watch channel, and stores the connection', async () => {
    const ctx = await makeOrgContext('connect');
    const fetchImpl = makeInstallFetch();

    const row = await completeGoogleCalendarInstall(
      app.db,
      ctx,
      googleConfig,
      credentialsKey,
      'a-code',
      webhookUrl,
      fetchImpl,
    );

    expect(row.provider).toBe('google');
    expect(row.externalAccount).toMatchObject({
      email: '[email protected]',
      calendarId: 'primary',
      channelId: 'channel-1',
      resourceId: 'resource-1',
      channelExpiration: 1426325213000,
      syncToken: null,
    });
    expect(row.encryptedCredentials).not.toBe('rt-1');

    const found = await getConnection(app.db, ctx, 'calendar');
    expect(found?.id).toBe(row.id);
  });

  it('resolves the channel token for a connected channel, and null otherwise', async () => {
    const ctx = await makeOrgContext('channel-token');
    const fetchImpl = makeInstallFetch();
    await completeGoogleCalendarInstall(
      app.db,
      ctx,
      googleConfig,
      credentialsKey,
      'a-code',
      webhookUrl,
      fetchImpl,
    );

    const token = await getGoogleCalendarChannelToken(app.db, credentialsKey, 'channel-1');
    expect(token).toEqual(expect.any(String));

    const missing = await getGoogleCalendarChannelToken(app.db, credentialsKey, 'no-such-channel');
    expect(missing).toBeNull();
  });

  it('builds a sync context with a freshly minted access token', async () => {
    const ctx = await makeOrgContext('sync-context');
    const installFetch = makeInstallFetch();
    await completeGoogleCalendarInstall(
      app.db,
      ctx,
      googleConfig,
      credentialsKey,
      'a-code',
      webhookUrl,
      installFetch,
    );

    const refreshFetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ access_token: 'at-2', expires_in: 3600 }));
    const context = await getGoogleCalendarSyncContext(
      app.db,
      credentialsKey,
      { clientId: googleConfig.clientId, clientSecret: googleConfig.clientSecret },
      'channel-1',
      refreshFetch,
    );

    expect(context).toEqual({ calendarId: 'primary', syncToken: null, accessToken: 'at-2' });
  });

  it('returns null from getSyncContext for an unknown channel', async () => {
    const context = await getGoogleCalendarSyncContext(
      app.db,
      credentialsKey,
      { clientId: googleConfig.clientId, clientSecret: googleConfig.clientSecret },
      'no-such-channel',
      vi.fn(),
    );
    expect(context).toBeNull();
  });

  it('persists a new sync token, resolving the org from the channel id', async () => {
    const ctx = await makeOrgContext('update-sync-token');
    const fetchImpl = makeInstallFetch();
    await completeGoogleCalendarInstall(
      app.db,
      ctx,
      googleConfig,
      credentialsKey,
      'a-code',
      webhookUrl,
      fetchImpl,
    );

    await updateGoogleCalendarSyncToken(app.db, 'channel-1', 'sync-token-1');

    const found = await getConnection(app.db, ctx, 'calendar');
    expect((found?.externalAccount as { syncToken: string }).syncToken).toBe('sync-token-1');
  });
});
