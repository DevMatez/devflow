import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { SESSION_COOKIE_NAME } from '../../../../plugins/auth';
import { createUserSession } from '../../../../modules/identity/service/session.service';
import { createUser } from '../../../../modules/identity/dal/users.dal';
import type { UserId } from '@devflow/types';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function extractCookie(setCookieHeaders: string | string[] | undefined, name: string): string {
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders ?? ''];
  const match = headers.find((h) => h.startsWith(`${name}=`));
  if (!match) throw new Error(`${name} cookie not found in Set-Cookie headers`);
  return match.split(';')[0]!;
}

describe('auth routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /auth/github/authorize', () => {
    it('redirects to GitHub and sets a state cookie', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/github/authorize' });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('https://github.com/login/oauth/authorize');
      expect(() => extractCookie(res.headers['set-cookie'], 'devflow_oauth_state')).not.toThrow();
    });
  });

  describe('GET /auth/github/callback', () => {
    it('returns 400 when GitHub reports the user denied authorization', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/github/callback?error=access_denied',
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when the state cookie is missing', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/github/callback?code=abc&state=whatever',
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when the state does not match the cookie', async () => {
      const authorize = await app.inject({ method: 'GET', url: '/api/v1/auth/github/authorize' });
      const stateCookie = extractCookie(authorize.headers['set-cookie'], 'devflow_oauth_state');

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/github/callback?code=abc&state=mismatched',
        headers: { cookie: stateCookie },
      });

      expect(res.statusCode).toBe(400);
    });

    it('logs the user in and redirects to the web app on success', async () => {
      const authorize = await app.inject({ method: 'GET', url: '/api/v1/auth/github/authorize' });
      const stateCookie = extractCookie(authorize.headers['set-cookie'], 'devflow_oauth_state');
      const state = new URL(authorize.headers.location as string).searchParams.get('state')!;

      const githubId = `route-test-${crypto.randomUUID()}`;
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce(jsonResponse({ access_token: 'gho_test' }))
          .mockResolvedValueOnce(
            jsonResponse({ id: githubId, name: 'Test User', avatar_url: null }),
          )
          .mockResolvedValueOnce(
            jsonResponse([{ email: `${githubId}@example.test`, primary: true, verified: true }]),
          ),
      );

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/github/callback?code=a-code&state=${state}`,
        headers: { cookie: stateCookie },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('http://localhost:3000/dashboard');
      expect(() => extractCookie(res.headers['set-cookie'], SESSION_COOKIE_NAME)).not.toThrow();

      await app.db.delete(schema.users).where(eq(schema.users.githubId, String(githubId)));
    });

    it('maps a GitHub upstream failure to 502', async () => {
      const authorize = await app.inject({ method: 'GET', url: '/api/v1/auth/github/authorize' });
      const stateCookie = extractCookie(authorize.headers['set-cookie'], 'devflow_oauth_state');
      const state = new URL(authorize.headers.location as string).searchParams.get('state')!;

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(jsonResponse({ error_description: 'bad_verification_code' })),
      );

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/auth/github/callback?code=bad-code&state=${state}`,
        headers: { cookie: stateCookie },
      });

      expect(res.statusCode).toBe(502);
    });
  });

  describe('GET /auth/session', () => {
    it('returns 401 without a session cookie', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
      expect(res.statusCode).toBe(401);
    });

    it('returns the current user with a valid session cookie', async () => {
      const githubId = `route-session-test-${crypto.randomUUID()}`;
      const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });

      const { token } = await createUserSession(
        app.db,
        { ttlDays: 30, refreshThresholdDays: 7 },
        { userId: user.id as UserId },
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${app.signCookie(token)}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().user.id).toBe(user.id);

      await app.db.delete(schema.users).where(eq(schema.users.id, user.id));
    });
  });

  describe('POST /auth/logout', () => {
    it('clears the session cookie and revokes the session', async () => {
      const githubId = `route-logout-test-${crypto.randomUUID()}`;
      const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });

      const { token } = await createUserSession(
        app.db,
        { ttlDays: 30, refreshThresholdDays: 7 },
        { userId: user.id as UserId },
      );
      const cookie = `${SESSION_COOKIE_NAME}=${app.signCookie(token)}`;

      const logout = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/logout',
        headers: { cookie },
      });
      expect(logout.statusCode).toBe(204);

      const session = await app.inject({
        method: 'GET',
        url: '/api/v1/auth/session',
        headers: { cookie },
      });
      expect(session.statusCode).toBe(401);

      await app.db.delete(schema.users).where(eq(schema.users.id, user.id));
    });

    it('is a no-op without a session cookie', async () => {
      const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
      expect(res.statusCode).toBe(204);
    });
  });
});
