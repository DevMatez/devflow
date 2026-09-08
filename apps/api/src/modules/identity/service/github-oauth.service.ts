import { randomBytes } from 'node:crypto';
import type { Database } from '@devflow/database';
import type { UserId } from '@devflow/types';
import { findUserByGithubId, createUser, touchLastLogin, type UserRow } from '../dal/users.dal';

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export interface GithubProfile {
  githubId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

export class GithubOAuthError extends Error {}

export class NoVerifiedPrimaryEmailError extends GithubOAuthError {
  constructor() {
    super('GitHub account has no verified primary email');
  }
}

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_BASE_URL = 'https://api.github.com';

export function generateOAuthState(): string {
  return randomBytes(32).toString('hex');
}

export function buildAuthorizeUrl(config: GithubOAuthConfig, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.callbackUrl);
  url.searchParams.set('state', state);
  return url.toString();
}

interface GithubAccessTokenResponse {
  access_token?: string;
  error_description?: string;
}

export async function exchangeCodeForAccessToken(
  config: GithubOAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
    }),
  });

  const data = (await response.json()) as GithubAccessTokenResponse;
  if (!data.access_token) {
    throw new GithubOAuthError(data.error_description ?? 'GitHub did not return an access token');
  }

  return data.access_token;
}

interface GithubUserResponse {
  id: number;
  name: string | null;
  avatar_url: string | null;
}

interface GithubEmailResponse {
  email: string;
  primary: boolean;
  verified: boolean;
}

/** Resolves the verified primary email — never an arbitrary /user/emails entry (design doc §3.1). */
export async function fetchGithubProfile(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubProfile> {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${accessToken}`,
  };

  const [userResponse, emailsResponse] = await Promise.all([
    fetchImpl(`${API_BASE_URL}/user`, { headers }),
    fetchImpl(`${API_BASE_URL}/user/emails`, { headers }),
  ]);

  const user = (await userResponse.json()) as GithubUserResponse;
  const emails = (await emailsResponse.json()) as GithubEmailResponse[];

  const primaryEmail = emails.find((entry) => entry.primary && entry.verified);
  if (!primaryEmail) throw new NoVerifiedPrimaryEmailError();

  return {
    githubId: String(user.id),
    email: primaryEmail.email,
    name: user.name,
    avatarUrl: user.avatar_url,
  };
}

/** Existing users aren't re-synced from GitHub on login (Wave 1 scope). */
export async function findOrCreateUser(db: Database, profile: GithubProfile): Promise<UserRow> {
  const existing = await findUserByGithubId(db, profile.githubId);
  if (existing) {
    return touchLastLogin(db, existing.id as UserId);
  }

  try {
    const created = await createUser(db, {
      githubId: profile.githubId,
      email: profile.email,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
    return await touchLastLogin(db, created.id as UserId);
  } catch (error) {
    // Concurrent first-login race on the unique github_id constraint.
    const raced = await findUserByGithubId(db, profile.githubId);
    if (!raced) throw error;
    return touchLastLogin(db, raced.id as UserId);
  }
}
