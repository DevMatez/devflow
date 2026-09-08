import { describe, expect, it, vi, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { createGithubSourceControlAdapter } from '../adapter';
import type { ProviderContext } from '@devflow/integrations-core';

let privateKey: string;

beforeAll(() => {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  privateKey = keys.privateKey;
});

const ctx: ProviderContext = {
  organizationId: 'org-1' as ProviderContext['organizationId'],
  connectionId: 'conn-1',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installationTokenResponse(): Response {
  return jsonResponse({
    token: 'test-installation-token',
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    permissions: {},
  });
}

/** Routes the installation-token mint automatically; other calls dispatch by "METHOD /path". */
function makeFetch(handlers: Record<string, (url: URL) => Response>): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();

    if (method === 'POST' && /^\/app\/installations\/[^/]+\/access_tokens$/.test(url.pathname)) {
      return installationTokenResponse();
    }

    const handler = handlers[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`Unhandled fetch: ${method} ${url.pathname}`);
    return handler(url);
  }) as unknown as typeof fetch;
}

function makeAdapter(handlers: Record<string, (url: URL) => Response>) {
  return createGithubSourceControlAdapter({
    appId: '12345',
    privateKey,
    installationId: '999',
    fetch: makeFetch(handlers),
  });
}

describe('createGithubSourceControlAdapter', () => {
  it('listRepositories maps the installation repositories response', async () => {
    const adapter = makeAdapter({
      'GET /installation/repositories': () =>
        jsonResponse({
          total_count: 1,
          repositories: [
            {
              id: 1,
              name: 'widgets',
              full_name: 'acme/widgets',
              default_branch: 'main',
              html_url: 'https://github.com/acme/widgets',
            },
          ],
        }),
    });

    const repos = await adapter.listRepositories(ctx);
    expect(repos).toEqual([
      {
        externalId: '1',
        name: 'widgets',
        fullName: 'acme/widgets',
        defaultBranch: 'main',
        url: 'https://github.com/acme/widgets',
      },
    ]);
  });

  it('createBranch reads the source ref sha, then creates the new ref', async () => {
    const adapter = makeAdapter({
      'GET /repos/acme/widgets/git/ref/heads%2Fmain': () =>
        jsonResponse({ object: { sha: 'abc123' } }),
      'POST /repos/acme/widgets/git/refs': () =>
        jsonResponse({ ref: 'refs/heads/feature', object: { sha: 'abc123' } }, 201),
    });

    const branch = await adapter.createBranch(ctx, {
      repo: 'acme/widgets',
      name: 'feature',
      fromRef: 'main',
    });

    expect(branch).toEqual({
      name: 'feature',
      repo: 'acme/widgets',
      sha: 'abc123',
      url: 'https://github.com/acme/widgets/tree/feature',
    });
  });

  it('createPullRequest maps the created pull request', async () => {
    const adapter = makeAdapter({
      'POST /repos/acme/widgets/pulls': () =>
        jsonResponse(
          {
            id: 100,
            number: 7,
            title: 'Add feature',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/7',
            head: { ref: 'feature' },
            base: { ref: 'main' },
            user: { id: 42 },
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
          201,
        ),
    });

    const pr = await adapter.createPullRequest(ctx, {
      repo: 'acme/widgets',
      title: 'Add feature',
      headRef: 'feature',
      baseRef: 'main',
    });

    expect(pr.externalId).toBe('100');
    expect(pr.state).toBe('open');
  });

  it('createComment maps the created comment', async () => {
    const adapter = makeAdapter({
      'POST /repos/acme/widgets/issues/7/comments': () =>
        jsonResponse(
          {
            id: 5,
            body: 'Looks good',
            user: { id: 1 },
            html_url: 'https://github.com/acme/widgets/pull/7#comment-5',
            created_at: '2026-01-01T00:00:00Z',
          },
          201,
        ),
    });

    const comment = await adapter.createComment(ctx, {
      repo: 'acme/widgets',
      targetExternalId: '7',
      body: 'Looks good',
    });

    expect(comment.externalId).toBe('5');
    expect(comment.body).toBe('Looks good');
  });

  it('upsertCheckRun creates a new check run when none exists for the name+sha', async () => {
    const adapter = makeAdapter({
      'GET /repos/acme/widgets/commits/sha123/check-runs': () =>
        jsonResponse({ total_count: 0, check_runs: [] }),
      'POST /repos/acme/widgets/check-runs': () =>
        jsonResponse(
          { id: 1, name: 'build', status: 'in_progress', conclusion: null, html_url: 'https://x' },
          201,
        ),
    });

    const checkRun = await adapter.upsertCheckRun(ctx, {
      repo: 'acme/widgets',
      headSha: 'sha123',
      name: 'build',
      status: 'in_progress',
    });

    expect(checkRun.externalId).toBe('1');
    expect(checkRun.status).toBe('in_progress');
  });

  it('upsertCheckRun updates the existing check run instead of creating a duplicate', async () => {
    const adapter = makeAdapter({
      'GET /repos/acme/widgets/commits/sha123/check-runs': () =>
        jsonResponse({
          total_count: 1,
          check_runs: [
            {
              id: 9,
              name: 'build',
              status: 'in_progress',
              conclusion: null,
              html_url: 'https://x',
            },
          ],
        }),
      'PATCH /repos/acme/widgets/check-runs/9': () =>
        jsonResponse({
          id: 9,
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://x',
        }),
    });

    const checkRun = await adapter.upsertCheckRun(ctx, {
      repo: 'acme/widgets',
      headSha: 'sha123',
      name: 'build',
      status: 'completed',
      conclusion: 'success',
    });

    expect(checkRun.externalId).toBe('9');
    expect(checkRun.conclusion).toBe('success');
  });
});
