import fp from 'fastify-plugin';
import cookie from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserId } from '@devflow/types';
import { env } from '../config/env';
import { verifySessionToken } from '../modules/identity/service/session.service';
import { findUserById } from '../modules/identity/dal/users.dal';

export interface AuthenticatedUser {
  id: UserId;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
}

export const SESSION_COOKIE_NAME = 'devflow_session';
const OAUTH_STATE_COOKIE_NAME = 'devflow_oauth_state';
const OAUTH_STATE_COOKIE_PATH = '/api/v1/auth/github';

function baseCookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    signed: true,
  };
}

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.cookie(SESSION_COOKIE_NAME, token, {
    ...baseCookieOptions(),
    maxAge: env.SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
}

/** Short-TTL CSRF value for the GitHub authorize → callback round trip (design doc §8). */
export function setOAuthStateCookie(reply: FastifyReply, state: string): void {
  reply.cookie(OAUTH_STATE_COOKIE_NAME, state, {
    ...baseCookieOptions(),
    path: OAUTH_STATE_COOKIE_PATH,
    maxAge: env.OAUTH_STATE_TTL_MINUTES * 60,
  });
}

/** Reads and clears the state cookie in one step — it is single-use (design doc §8). */
export function consumeOAuthStateCookie(
  request: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const raw = request.cookies[OAUTH_STATE_COOKIE_NAME];
  reply.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: OAUTH_STATE_COOKIE_PATH });

  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

const INTEGRATION_OAUTH_STATE_COOKIE_NAME = 'devflow_integration_oauth_state';
const INTEGRATION_OAUTH_STATE_COOKIE_PATH = '/api/v1/organizations';

/**
 * Additional (not sole) layer for integration connect flows — the state
 * value itself is self-contained/signed (design doc §12); this cookie only
 * adds single-use enforcement.
 */
export function setIntegrationOAuthStateCookie(reply: FastifyReply, state: string): void {
  reply.cookie(INTEGRATION_OAUTH_STATE_COOKIE_NAME, state, {
    ...baseCookieOptions(),
    path: INTEGRATION_OAUTH_STATE_COOKIE_PATH,
    maxAge: env.OAUTH_STATE_TTL_MINUTES * 60,
  });
}

export function consumeIntegrationOAuthStateCookie(
  request: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const raw = request.cookies[INTEGRATION_OAUTH_STATE_COOKIE_NAME];
  reply.clearCookie(INTEGRATION_OAUTH_STATE_COOKIE_NAME, {
    path: INTEGRATION_OAUTH_STATE_COOKIE_PATH,
  });

  if (!raw) return null;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid ? unsigned.value : null;
}

/**
 * Resolves the session cookie into `request.user` on every request (nullable
 * — most routes are public). Pure authN: no org concept here, see the
 * `access` module for `OrgContext`/`requireOrgRole` (design doc §7).
 */
export const authPlugin = fp(async (app) => {
  await app.register(cookie, { secret: env.SESSION_COOKIE_SECRET });

  app.addHook('onRequest', async (request) => {
    request.user = null;

    const token = request.cookies[SESSION_COOKIE_NAME];
    if (!token) return;

    const unsigned = request.unsignCookie(token);
    if (!unsigned.valid || !unsigned.value) return;

    const session = await verifySessionToken(
      app.db,
      { ttlDays: env.SESSION_TTL_DAYS, refreshThresholdDays: env.SESSION_REFRESH_THRESHOLD_DAYS },
      unsigned.value,
    );
    if (!session) return;

    const user = await findUserById(app.db, session.userId as UserId);
    if (!user) return;

    request.user = {
      id: user.id as UserId,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
    };
  });
});

/** Route-level gate for the rare protected route that isn't org-scoped (e.g. `/auth/session`). */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.unauthorized();
  }
}
