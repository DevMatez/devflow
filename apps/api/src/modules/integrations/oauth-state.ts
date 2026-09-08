import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { OrganizationId } from '@devflow/types';

export interface OAuthStateInput {
  organizationId: OrganizationId;
  provider: string;
}

interface OAuthStatePayload extends OAuthStateInput {
  nonce: string;
  expiresAt: number;
}

function sign(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Self-contained signed OAuth-style state (design doc §12) — carries the
 * org/provider/nonce/expiry, verifiable on its own even if the round-trip
 * cookie doesn't survive the redirect. Used by every provider connect flow
 * that redirects off-site (GitHub install, Slack/Calendar OAuth).
 */
export function createOAuthState(secret: string, ttlMs: number, input: OAuthStateInput): string {
  const payload: OAuthStatePayload = {
    ...input,
    nonce: randomBytes(16).toString('hex'),
    expiresAt: Date.now() + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${sign(secret, encoded)}`;
}

/** Verifies the signature and expiry; returns null on any failure (never throws). */
export function verifyOAuthState(secret: string, state: string): OAuthStateInput | null {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return null;

  const expected = sign(secret, encoded);
  const actual = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actual.length !== expectedBuf.length || !timingSafeEqual(actual, expectedBuf)) return null;

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof payload.expiresAt !== 'number' || payload.expiresAt < Date.now()) return null;
  return { organizationId: payload.organizationId, provider: payload.provider };
}
