import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import {
  buildAuthorizeUrl,
  exchangeCodeForAccessToken,
  fetchGithubProfile,
  findOrCreateUser,
  generateOAuthState,
  GithubOAuthError,
  NoVerifiedPrimaryEmailError,
  type GithubOAuthConfig,
} from '../github-oauth.service';

const config: GithubOAuthConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  callbackUrl: 'http://localhost:4000/api/v1/auth/github/callback',
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

describe('generateOAuthState / buildAuthorizeUrl', () => {
  it('generates a non-trivial random state', () => {
    expect(generateOAuthState()).not.toBe(generateOAuthState());
  });

  it('builds an authorize URL with client_id, redirect_uri, and state', () => {
    const url = new URL(buildAuthorizeUrl(config, 'the-state'));

    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(config.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(config.callbackUrl);
    expect(url.searchParams.get('state')).toBe('the-state');
  });
});

describe('exchangeCodeForAccessToken', () => {
  it('resolves the access token on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'gho_abc123' }));

    const token = await exchangeCodeForAccessToken(config, 'a-code', fetchImpl);

    expect(token).toBe('gho_abc123');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws GithubOAuthError when GitHub does not return a token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error_description: 'bad_verification_code' }));

    await expect(exchangeCodeForAccessToken(config, 'bad-code', fetchImpl)).rejects.toThrow(
      GithubOAuthError,
    );
  });
});

describe('fetchGithubProfile', () => {
  it('resolves the verified primary email, ignoring other entries', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 42, name: 'Ada', avatar_url: 'https://x/a.png' }))
      .mockResolvedValueOnce(
        jsonResponse([
          { email: 'unverified@example.test', primary: false, verified: false },
          { email: 'secondary@example.test', primary: false, verified: true },
          { email: 'primary@example.test', primary: true, verified: true },
        ]),
      );

    const profile = await fetchGithubProfile('token', fetchImpl);

    expect(profile).toEqual({
      githubId: '42',
      email: 'primary@example.test',
      name: 'Ada',
      avatarUrl: 'https://x/a.png',
    });
  });

  it('throws NoVerifiedPrimaryEmailError when no email is both primary and verified', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: 1, name: null, avatar_url: null }))
      .mockResolvedValueOnce(
        jsonResponse([{ email: 'unverified@example.test', primary: true, verified: false }]),
      );

    await expect(fetchGithubProfile('token', fetchImpl)).rejects.toThrow(
      NoVerifiedPrimaryEmailError,
    );
  });
});

describe('findOrCreateUser', () => {
  let app: FastifyInstance;
  const githubId = `oauth-svc-test-${crypto.randomUUID()}`;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.db.delete(schema.users).where(eq(schema.users.githubId, githubId));
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a new user on first login', async () => {
    const user = await findOrCreateUser(app.db, {
      githubId,
      email: `${githubId}@example.test`,
      name: 'Grace Hopper',
      avatarUrl: null,
    });

    expect(user.githubId).toBe(githubId);
    expect(user.lastLoginAt).not.toBeNull();
  });

  it('returns the existing user and touches lastLoginAt on a later login', async () => {
    const first = await findOrCreateUser(app.db, {
      githubId,
      email: `${githubId}@example.test`,
      name: 'Grace Hopper',
      avatarUrl: null,
    });

    const second = await findOrCreateUser(app.db, {
      githubId,
      email: `${githubId}@example.test`,
      name: 'Grace Hopper',
      avatarUrl: null,
    });

    expect(second.id).toBe(first.id);
  });
});
