import { describe, expect, it } from 'vitest';
import { createOAuthState, verifyOAuthState } from '../oauth-state';
import type { OrganizationId } from '@devflow/types';

const SECRET = 'test-oauth-state-secret';
const organizationId = 'org-1' as OrganizationId;

describe('createOAuthState / verifyOAuthState', () => {
  it('round-trips organizationId and provider', () => {
    const state = createOAuthState(SECRET, 60_000, { organizationId, provider: 'github' });
    const parsed = verifyOAuthState(SECRET, state);
    expect(parsed).toEqual({ organizationId, provider: 'github' });
  });

  it('produces a different state each time (random nonce)', () => {
    const a = createOAuthState(SECRET, 60_000, { organizationId, provider: 'github' });
    const b = createOAuthState(SECRET, 60_000, { organizationId, provider: 'github' });
    expect(a).not.toBe(b);
  });

  it('rejects a state signed with a different secret', () => {
    const state = createOAuthState(SECRET, 60_000, { organizationId, provider: 'github' });
    expect(verifyOAuthState('a-different-secret', state)).toBeNull();
  });

  it('rejects a tampered payload even if reusing the original signature', () => {
    const state = createOAuthState(SECRET, 60_000, { organizationId, provider: 'github' });
    const [, signature] = state.split('.');
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        organizationId: 'org-2',
        provider: 'github',
        nonce: 'x',
        expiresAt: Date.now() + 60_000,
      }),
    ).toString('base64url');

    expect(verifyOAuthState(SECRET, `${tamperedPayload}.${signature}`)).toBeNull();
  });

  it('rejects an expired state', () => {
    const state = createOAuthState(SECRET, -1, { organizationId, provider: 'github' });
    expect(verifyOAuthState(SECRET, state)).toBeNull();
  });

  it('rejects a malformed state string', () => {
    expect(verifyOAuthState(SECRET, 'not-a-valid-state')).toBeNull();
    expect(verifyOAuthState(SECRET, '')).toBeNull();
  });
});
