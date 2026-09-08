import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import { createOrganization } from '../../../organizations/service/organizations.service';
import { getConnection } from '../connections.service';
import { completeSlackInstall } from '../slack-connect.service';
import type { OrgContext } from '../../../access/org-context';
import type { OrganizationId, UserId } from '@devflow/types';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

const slackConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'https://example.test/api/v1/integrations/slack/callback',
  scopes: 'chat:write,channels:read,groups:read',
};

describe('slack-connect service', () => {
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
    const githubId = `slack-connect-test-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);

    const org = await createOrganization(app.db, {
      name: `Slack Connect Org ${label}`,
      userId: user.id as UserId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);

    return { organizationId: org.id as OrganizationId, userId: user.id as UserId, role: 'owner' };
  }

  it('exchanges the code for a bot token and stores the connection', async () => {
    const ctx = await makeOrgContext('connect');
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        access_token: 'xoxb-1-2-3',
        bot_user_id: 'U0KRQLJ9H',
        team: { id: 'T9TK3CUKW', name: 'Acme' },
      }),
    );

    const row = await completeSlackInstall(
      app.db,
      ctx,
      slackConfig,
      credentialsKey,
      'a-code',
      fetchImpl,
    );

    expect(row.provider).toBe('slack');
    expect(row.externalAccount).toEqual({
      teamId: 'T9TK3CUKW',
      teamName: 'Acme',
      botUserId: 'U0KRQLJ9H',
    });
    expect(row.encryptedCredentials).not.toBe('xoxb-1-2-3');

    const found = await getConnection(app.db, ctx, 'chat');
    expect(found?.id).toBe(row.id);
  });

  it('reconnects (refreshes credentials) instead of erroring on a second install for the same org', async () => {
    const ctx = await makeOrgContext('reconnect');
    const fetchImpl = vi.fn().mockImplementation(async () =>
      jsonResponse({
        ok: true,
        access_token: 'xoxb-first',
        bot_user_id: 'U1',
        team: { id: 'T1', name: 'Acme' },
      }),
    );

    await completeSlackInstall(app.db, ctx, slackConfig, credentialsKey, 'code-1', fetchImpl);
    const second = await completeSlackInstall(
      app.db,
      ctx,
      slackConfig,
      credentialsKey,
      'code-2',
      fetchImpl,
    );

    expect(second.status).toBe('connected');
    const found = await getConnection(app.db, ctx, 'chat');
    expect(found?.id).toBe(second.id);
  });
});
