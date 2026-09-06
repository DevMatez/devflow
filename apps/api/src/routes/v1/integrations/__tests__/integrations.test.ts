import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../../modules/identity/dal/users.dal';
import { createUserSession } from '../../../../modules/identity/service/session.service';
import { SESSION_COOKIE_NAME } from '../../../../plugins/auth';
import { createOrganization } from '../../../../modules/organizations/service/organizations.service';
import { connect } from '../../../../modules/integrations/service/connections.service';
import type { OrganizationId, UserId } from '@devflow/types';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function extractCookie(setCookieHeaders: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders ?? ''];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  if (!match) throw new Error(`${name} cookie not found in Set-Cookie headers`);
  return match.split(';')[0]!;
}

async function makeAuthedUser(app: FastifyInstance, label: string) {
  const githubId = `route-integrations-test-${label}-${crypto.randomUUID()}`;
  const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
  const { token } = await createUserSession(
    app.db,
    { ttlDays: 30, refreshThresholdDays: 7 },
    { userId: user.id as UserId },
  );
  return { userId: user.id as UserId, cookie: `${SESSION_COOKIE_NAME}=${app.signCookie(token)}` };
}

describe('integrations routes', () => {
  let app: FastifyInstance;
  const createdUserIds: UserId[] = [];
  const createdOrgIds: OrganizationId[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    for (const id of createdOrgIds.splice(0)) {
      await app.db.delete(schema.organizations).where(eq(schema.organizations.id, id));
    }
    for (const id of createdUserIds.splice(0)) {
      await app.db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await app.close();
  });

  async function makeOrg(owner: { userId: UserId }, label: string): Promise<OrganizationId> {
    const org = await createOrganization(app.db, {
      name: `Integrations Route Org ${label}`,
      userId: owner.userId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    return org.id as OrganizationId;
  }

  it('rejects unauthenticated and non-admin access', async () => {
    const owner = await makeAuthedUser(app, 'owner');
    createdUserIds.push(owner.userId);
    const organizationId = await makeOrg(owner, 'authz');

    const outsider = await makeAuthedUser(app, 'outsider');
    createdUserIds.push(outsider.userId);

    const unauthed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/integrations`,
    });
    expect(unauthed.statusCode).toBe(401);

    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/integrations`,
      headers: { cookie: outsider.cookie },
    });
    expect(forbidden.statusCode).toBe(403);
  });

  it('lists connections without leaking credentials, then disconnects', async () => {
    const owner = await makeAuthedUser(app, 'owner-2');
    createdUserIds.push(owner.userId);
    const organizationId = await makeOrg(owner, 'lifecycle');

    await connect(
      app.db,
      { organizationId, userId: owner.userId, role: 'owner' },
      {
        category: 'source-control',
        provider: 'github',
        externalAccount: { login: 'acme-org' },
        encryptedCredentials: 'ciphertext',
        credentialsIv: 'iv',
      },
    );

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/integrations`,
      headers: { cookie: owner.cookie },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0].provider).toBe('github');
    expect(body.connections[0].encryptedCredentials).toBeUndefined();
    expect(body.connections[0].credentialsIv).toBeUndefined();

    const disconnect = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/integrations/source-control`,
      headers: { cookie: owner.cookie },
    });
    expect(disconnect.statusCode).toBe(204);

    const listAfter = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/integrations`,
      headers: { cookie: owner.cookie },
    });
    expect(listAfter.json().connections[0].status).toBe('revoked');
  });

  it('returns 404 disconnecting a category with no connection', async () => {
    const owner = await makeAuthedUser(app, 'owner-3');
    createdUserIds.push(owner.userId);
    const organizationId = await makeOrg(owner, 'missing');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/organizations/${organizationId}/integrations/chat`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  describe('GitHub connect flow', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('redirects to the GitHub App install URL and sets a state cookie', async () => {
      const owner = await makeAuthedUser(app, 'gh-install');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'gh-install');

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/integrations/github/install`,
        headers: { cookie: owner.cookie },
      });

      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.hostname).toBe('github.com');
      expect(location.pathname).toMatch(/^\/apps\/.+\/installations\/new$/);
      expect(location.searchParams.get('state')).toBeTruthy();
      expect(() =>
        extractCookie(res.headers['set-cookie'], 'devflow_integration_oauth_state'),
      ).not.toThrow();
    });

    it('rejects a non-admin starting an install', async () => {
      const owner = await makeAuthedUser(app, 'gh-install-authz-owner');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'gh-install-authz');
      const outsider = await makeAuthedUser(app, 'gh-install-authz-outsider');
      createdUserIds.push(outsider.userId);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/integrations/github/install`,
        headers: { cookie: outsider.cookie },
      });
      expect(res.statusCode).toBe(403);
    });

    it('completes the connect flow end-to-end and stores an encrypted connection', async () => {
      const owner = await makeAuthedUser(app, 'gh-callback');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'gh-callback');

      const install = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/integrations/github/install`,
        headers: { cookie: owner.cookie },
      });
      const state = new URL(install.headers.location as string).searchParams.get('state')!;
      const stateCookie = extractCookie(
        install.headers['set-cookie'],
        'devflow_integration_oauth_state',
      );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse({
            id: 555,
            account: {
              login: 'acme-org',
              avatar_url: 'https://avatars.githubusercontent.com/acme',
            },
          }),
        ),
      );

      const callback = await app.inject({
        method: 'GET',
        url: `/api/v1/integrations/github/callback?installation_id=555&setup_action=install&state=${state}`,
        headers: { cookie: `${owner.cookie}; ${stateCookie}` },
      });

      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toContain('connected=github');

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/integrations`,
        headers: { cookie: owner.cookie },
      });
      const connections = list.json().connections;
      expect(connections).toHaveLength(1);
      expect(connections[0].provider).toBe('github');
      expect(connections[0].externalAccount).toEqual({
        login: 'acme-org',
        avatarUrl: 'https://avatars.githubusercontent.com/acme',
      });
    });

    it('rejects a callback with a tampered/invalid state', async () => {
      const owner = await makeAuthedUser(app, 'gh-callback-bad-state');
      createdUserIds.push(owner.userId);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/integrations/github/callback?installation_id=555&state=not-a-real-state',
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a callback missing installation_id', async () => {
      const owner = await makeAuthedUser(app, 'gh-callback-missing-install');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'gh-callback-missing-install');

      const install = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/integrations/github/install`,
        headers: { cookie: owner.cookie },
      });
      const state = new URL(install.headers.location as string).searchParams.get('state')!;
      const stateCookie = extractCookie(
        install.headers['set-cookie'],
        'devflow_integration_oauth_state',
      );

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/integrations/github/callback?setup_action=request&state=${state}`,
        headers: { cookie: `${owner.cookie}; ${stateCookie}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a callback from a user without admin access to the target organization', async () => {
      const owner = await makeAuthedUser(app, 'gh-callback-authz-owner');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'gh-callback-authz');
      const outsider = await makeAuthedUser(app, 'gh-callback-authz-outsider');
      createdUserIds.push(outsider.userId);

      const install = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/integrations/github/install`,
        headers: { cookie: owner.cookie },
      });
      const state = new URL(install.headers.location as string).searchParams.get('state')!;
      const stateCookie = extractCookie(
        install.headers['set-cookie'],
        'devflow_integration_oauth_state',
      );

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/integrations/github/callback?installation_id=555&state=${state}`,
        headers: { cookie: `${outsider.cookie}; ${stateCookie}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('Plane connect flow', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('connects a workspace after validating the token', async () => {
      const owner = await makeAuthedUser(app, 'plane-connect');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'plane-connect');

      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(jsonResponse({ id: 'workspace-uuid-1', slug: 'acme', name: 'Acme' })),
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/integrations/plane/connect`,
        headers: { cookie: owner.cookie },
        payload: {
          workspaceSlug: 'acme',
          apiToken: 'plane_api_test-token',
          webhookSecret: 'plane_wh_test-secret',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.provider).toBe('plane');
      expect(body.externalAccount).toEqual({
        workspaceSlug: 'acme',
        workspaceId: 'workspace-uuid-1',
      });
      expect(body.encryptedCredentials).toBeUndefined();
    });

    it('rejects a non-admin connecting', async () => {
      const owner = await makeAuthedUser(app, 'plane-connect-authz-owner');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'plane-connect-authz');
      const outsider = await makeAuthedUser(app, 'plane-connect-authz-outsider');
      createdUserIds.push(outsider.userId);

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/integrations/plane/connect`,
        headers: { cookie: outsider.cookie },
        payload: {
          workspaceSlug: 'acme',
          apiToken: 'plane_api_test-token',
          webhookSecret: 'plane_wh_test-secret',
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 400 when the token fails to validate against the workspace', async () => {
      const owner = await makeAuthedUser(app, 'plane-connect-invalid-token');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'plane-connect-invalid-token');

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })),
      );

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${organizationId}/integrations/plane/connect`,
        headers: { cookie: owner.cookie },
        payload: {
          workspaceSlug: 'acme',
          apiToken: 'bad-token',
          webhookSecret: 'plane_wh_test-secret',
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('Slack connect flow', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('redirects to the Slack OAuth authorize URL and sets a state cookie', async () => {
      const owner = await makeAuthedUser(app, 'slack-authorize');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'slack-authorize');

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/integrations/slack/authorize`,
        headers: { cookie: owner.cookie },
      });

      expect(res.statusCode).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.origin + location.pathname).toBe('https://slack.com/oauth/v2/authorize');
      expect(location.searchParams.get('scope')).toBe('chat:write,channels:read,groups:read');
      expect(location.searchParams.get('state')).toBeTruthy();
      expect(() =>
        extractCookie(res.headers['set-cookie'], 'devflow_integration_oauth_state'),
      ).not.toThrow();
    });

    it('rejects a non-admin starting an authorize', async () => {
      const owner = await makeAuthedUser(app, 'slack-authorize-authz-owner');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'slack-authorize-authz');
      const outsider = await makeAuthedUser(app, 'slack-authorize-authz-outsider');
      createdUserIds.push(outsider.userId);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/integrations/slack/authorize`,
        headers: { cookie: outsider.cookie },
      });
      expect(res.statusCode).toBe(403);
    });

    it('completes the connect flow end-to-end and stores the bot token connection', async () => {
      const owner = await makeAuthedUser(app, 'slack-callback');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'slack-callback');

      const authorize = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/integrations/slack/authorize`,
        headers: { cookie: owner.cookie },
      });
      const state = new URL(authorize.headers.location as string).searchParams.get('state')!;
      const stateCookie = extractCookie(
        authorize.headers['set-cookie'],
        'devflow_integration_oauth_state',
      );

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          jsonResponse({
            ok: true,
            access_token: 'xoxb-1-2-3',
            bot_user_id: 'U0KRQLJ9H',
            team: { id: 'T9TK3CUKW', name: 'Acme' },
          }),
        ),
      );

      const callback = await app.inject({
        method: 'GET',
        url: `/api/v1/integrations/slack/callback?code=a-code&state=${state}`,
        headers: { cookie: `${owner.cookie}; ${stateCookie}` },
      });

      expect(callback.statusCode).toBe(302);
      expect(callback.headers.location).toContain('connected=slack');

      const list = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/integrations`,
        headers: { cookie: owner.cookie },
      });
      const connections = list.json().connections;
      expect(connections).toHaveLength(1);
      expect(connections[0].provider).toBe('slack');
      expect(connections[0].externalAccount).toEqual({
        teamId: 'T9TK3CUKW',
        teamName: 'Acme',
        botUserId: 'U0KRQLJ9H',
      });
    });

    it('rejects a callback with a tampered/invalid state', async () => {
      const owner = await makeAuthedUser(app, 'slack-callback-bad-state');
      createdUserIds.push(owner.userId);

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/integrations/slack/callback?code=a-code&state=not-a-real-state',
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a callback missing code', async () => {
      const owner = await makeAuthedUser(app, 'slack-callback-missing-code');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'slack-callback-missing-code');

      const authorize = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/integrations/slack/authorize`,
        headers: { cookie: owner.cookie },
      });
      const state = new URL(authorize.headers.location as string).searchParams.get('state')!;
      const stateCookie = extractCookie(
        authorize.headers['set-cookie'],
        'devflow_integration_oauth_state',
      );

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/integrations/slack/callback?error=access_denied&state=${state}`,
        headers: { cookie: `${owner.cookie}; ${stateCookie}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a callback from a user without admin access to the target organization', async () => {
      const owner = await makeAuthedUser(app, 'slack-callback-authz-owner');
      createdUserIds.push(owner.userId);
      const organizationId = await makeOrg(owner, 'slack-callback-authz');
      const outsider = await makeAuthedUser(app, 'slack-callback-authz-outsider');
      createdUserIds.push(outsider.userId);

      const authorize = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${organizationId}/integrations/slack/authorize`,
        headers: { cookie: owner.cookie },
      });
      const state = new URL(authorize.headers.location as string).searchParams.get('state')!;
      const stateCookie = extractCookie(
        authorize.headers['set-cookie'],
        'devflow_integration_oauth_state',
      );

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/integrations/slack/callback?code=a-code&state=${state}`,
        headers: { cookie: `${outsider.cookie}; ${stateCookie}` },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
