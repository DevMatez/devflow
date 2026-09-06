import { type FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { timingSafeEqual } from 'node:crypto';
import type { UserId } from '@devflow/types';
import { env } from '../../../config/env';
import {
  setOAuthStateCookie,
  consumeOAuthStateCookie,
  setSessionCookie,
  clearSessionCookie,
  requireAuth,
  SESSION_COOKIE_NAME,
} from '../../../plugins/auth';
import {
  buildAuthorizeUrl,
  generateOAuthState,
  exchangeCodeForAccessToken,
  fetchGithubProfile,
  findOrCreateUser,
  GithubOAuthError,
  NoVerifiedPrimaryEmailError,
  type GithubOAuthConfig,
} from '../../../modules/identity/service/github-oauth.service';
import {
  createUserSession,
  revokeSessionToken,
  type SessionConfig,
} from '../../../modules/identity/service/session.service';
import { githubCallbackQuerySchema, authSessionResponseSchema } from './schema';

// Tighter than the app-wide default (design doc §8) — brute-force/enumeration protection.
const AUTH_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

function statesMatch(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
}

function githubConfig(): GithubOAuthConfig {
  return {
    clientId: env.GITHUB_OAUTH_CLIENT_ID,
    clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET,
    callbackUrl: env.GITHUB_OAUTH_CALLBACK_URL,
  };
}

function sessionConfig(): SessionConfig {
  return {
    ttlDays: env.SESSION_TTL_DAYS,
    refreshThresholdDays: env.SESSION_REFRESH_THRESHOLD_DAYS,
  };
}

export async function authRouter(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/auth/github/authorize',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: {
        tags: ['Auth'],
        summary: 'Start GitHub login',
        description:
          'Sets a short-lived CSRF state cookie and redirects to GitHub to authorize the ' +
          'login-only GitHub App (see apps/api/docs/wave-1-identity-tenancy.md §3.1).',
      },
    },
    async (_request, reply) => {
      const state = generateOAuthState();
      setOAuthStateCookie(reply, state);
      return reply.redirect(buildAuthorizeUrl(githubConfig(), state), 302);
    },
  );

  typed.get(
    '/auth/github/callback',
    {
      config: { rateLimit: AUTH_RATE_LIMIT },
      schema: {
        tags: ['Auth'],
        summary: 'Complete GitHub login',
        description:
          'Verifies the CSRF state, exchanges the code for an access token, resolves the ' +
          'verified primary email, finds-or-creates the user, opens a session, and redirects ' +
          'to the web app.',
        querystring: githubCallbackQuerySchema,
      },
    },
    async (request, reply) => {
      const { code, state, error } = request.query;

      if (error || !code) {
        return reply.badRequest('GitHub authorization was not completed');
      }

      const expectedState = consumeOAuthStateCookie(request, reply);
      if (!expectedState || !statesMatch(expectedState, state)) {
        return reply.badRequest('Invalid or expired OAuth state');
      }

      try {
        const accessToken = await exchangeCodeForAccessToken(githubConfig(), code);
        const profile = await fetchGithubProfile(accessToken);
        const user = await findOrCreateUser(app.db, profile);

        const userAgentHeader = request.headers['user-agent'];
        const { token } = await createUserSession(app.db, sessionConfig(), {
          userId: user.id as UserId,
          ip: request.ip,
          userAgent: Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader,
        });

        setSessionCookie(reply, token);
        return reply.redirect(`${env.WEB_APP_URL}/dashboard`, 302);
      } catch (thrown) {
        if (thrown instanceof NoVerifiedPrimaryEmailError) return reply.forbidden(thrown.message);
        if (thrown instanceof GithubOAuthError) return reply.badGateway(thrown.message);
        throw thrown;
      }
    },
  );

  typed.get(
    '/auth/session',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Auth'],
        summary: 'Get the current session user',
        description: 'Returns the authenticated user, resolved from the session cookie.',
        response: { 200: authSessionResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.user) return reply.unauthorized();
      return { user: request.user };
    },
  );

  typed.post(
    '/auth/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'End the current session',
        description: 'Revokes the session (if any) and clears the session cookie. Idempotent.',
      },
    },
    async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (token) {
        const unsigned = request.unsignCookie(token);
        if (unsigned.valid && unsigned.value) {
          await revokeSessionToken(app.db, unsigned.value);
        }
      }

      clearSessionCookie(reply);
      return reply.code(204).send();
    },
  );
}
