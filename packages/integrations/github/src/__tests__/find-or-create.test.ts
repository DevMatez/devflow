import { beforeAll, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { ProviderContext } from '@devflow/integrations-core';
import { createGithubSourceControlAdapter } from '../adapter';

let privateKey: string;
beforeAll(() => {
  privateKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  }).privateKey;
});

const ctx: ProviderContext = {
  organizationId: 'org-1' as ProviderContext['organizationId'],
  connectionId: 'conn-1',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function installToken(): Response {
  return json({
    token: 't',
    expires_at: new Date(Date.now() + 3.6e6).toISOString(),
    permissions: {},
  });
}

const prFixture = {
  id: 100,
  number: 7,
  title: 'PR',
  state: 'open',
  html_url: 'https://github.com/acme/widgets/pull/7',
  head: { ref: 'feature/x' },
  base: { ref: 'main' },
  user: { id: 42 },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function port(fetchImpl: typeof fetch) {
  return createGithubSourceControlAdapter({
    appId: '1',
    privateKey,
    installationId: '9',
    fetch: fetchImpl,
  });
}

function router(handlers: Record<string, (init?: RequestInit) => Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (method === 'POST' && /\/app\/installations\/[^/]+\/access_tokens$/.test(url.pathname)) {
      return installToken();
    }
    const key = `${method} ${url.pathname}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`Unhandled: ${key}`);
    return handler(init);
  }) as unknown as typeof fetch;
}

describe('github find-or-create idempotency', () => {
  it('findOrCreateBranch returns the existing branch without creating', async () => {
    const createRef = vi.fn(() => json({}, 201));
    const p = port(
      router({
        'GET /repos/acme/widgets/git/ref/heads%2Ffeature%2Fx': () =>
          json({ object: { sha: 'existing-sha' } }),
        'POST /repos/acme/widgets/git/refs': createRef,
      }),
    );

    const branch = await p.findOrCreateBranch(ctx, {
      repo: 'acme/widgets',
      name: 'feature/x',
      fromRef: 'main',
    });
    expect(branch.sha).toBe('existing-sha');
    expect(createRef).not.toHaveBeenCalled();
  });

  it('findOrCreateBranch refetches on a 422 create race', async () => {
    let branchExists = false;
    const p = port(
      router({
        'GET /repos/acme/widgets/git/ref/heads%2Ffeature%2Fx': () =>
          branchExists
            ? json({ object: { sha: 'raced-sha' } })
            : json({ message: 'Not Found' }, 404),
        'GET /repos/acme/widgets/git/ref/heads%2Fmain': () => json({ object: { sha: 'base-sha' } }),
        'POST /repos/acme/widgets/git/refs': () => {
          branchExists = true; // another worker won the race
          return json({ message: 'Reference already exists' }, 422);
        },
      }),
    );

    const branch = await p.findOrCreateBranch(ctx, {
      repo: 'acme/widgets',
      name: 'feature/x',
      fromRef: 'main',
    });
    expect(branch.sha).toBe('raced-sha');
  });

  it('findOrCreatePullRequest returns the existing open PR without creating', async () => {
    const create = vi.fn(() => json(prFixture, 201));
    const p = port(
      router({
        'GET /repos/acme/widgets/pulls': () => json([prFixture]),
        'POST /repos/acme/widgets/pulls': create,
      }),
    );

    const pr = await p.findOrCreatePullRequest(ctx, {
      repo: 'acme/widgets',
      title: 'PR',
      headRef: 'feature/x',
      baseRef: 'main',
    });
    expect(pr.number).toBe(7);
    expect(create).not.toHaveBeenCalled();
  });

  it('findOrCreatePullRequest refetches on a 422 create race', async () => {
    let prExists = false;
    const p = port(
      router({
        'GET /repos/acme/widgets/pulls': () => (prExists ? json([prFixture]) : json([])),
        'POST /repos/acme/widgets/pulls': () => {
          prExists = true;
          return json({ message: 'A pull request already exists for acme:feature/x' }, 422);
        },
      }),
    );

    const pr = await p.findOrCreatePullRequest(ctx, {
      repo: 'acme/widgets',
      title: 'PR',
      headRef: 'feature/x',
      baseRef: 'main',
    });
    expect(pr.number).toBe(7);
  });
});
