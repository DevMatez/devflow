import { beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { runSourceControlPortContractTests } from '@devflow/integrations-core/contract-tests';
import type { ProviderContext } from '@devflow/integrations-core';
import { createGithubSourceControlAdapter } from '../adapter';

let privateKey: string;

beforeAll(() => {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  privateKey = keys.privateKey;
});

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

const pullRequestFixture = {
  id: 100,
  number: 7,
  title: 'Contract test PR',
  state: 'open',
  html_url: 'https://github.com/acme/widgets/pull/7',
  head: { ref: 'contract-test-branch' },
  base: { ref: 'main' },
  user: { id: 42 },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function textResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

function acceptHeader(init: RequestInit | undefined): string {
  const headers = init?.headers;
  if (!headers) return '';
  if (headers instanceof Headers) return headers.get('accept') ?? '';
  const entry = Object.entries(headers as Record<string, string>).find(
    ([name]) => name.toLowerCase() === 'accept',
  );
  return entry?.[1] ?? '';
}

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const key = `${method} ${url.pathname}`;

    if (method === 'POST' && /^\/app\/installations\/[^/]+\/access_tokens$/.test(url.pathname)) {
      return installationTokenResponse();
    }

    // getDiff hits the same "GET pulls/:number" endpoint as getPullRequest, distinguished
    // only by the Accept header (application/vnd.github.v3.diff vs the default JSON media type).
    if (key === 'GET /repos/acme/widgets/pulls/7' && acceptHeader(init).includes('diff')) {
      return textResponse('diff --git a/file b/file\n+contract test diff\n');
    }

    const routes: Record<string, () => Response> = {
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
      'GET /repos/acme/widgets/git/ref/heads%2Fmain': () =>
        jsonResponse({ object: { sha: 'sha123' } }),
      'GET /repos/acme/widgets/git/ref/heads%2Fcontract-test-branch': () =>
        jsonResponse({ message: 'Not Found' }, 404),
      'POST /repos/acme/widgets/git/refs': () =>
        jsonResponse({ ref: 'refs/heads/contract-test-branch', object: { sha: 'sha123' } }, 201),
      'GET /repos/acme/widgets/pulls': () => jsonResponse([]),
      'POST /repos/acme/widgets/pulls': () => jsonResponse(pullRequestFixture, 201),
      'GET /repos/acme/widgets/pulls/7': () => jsonResponse(pullRequestFixture),
      'POST /repos/acme/widgets/issues/7/comments': () =>
        jsonResponse(
          {
            id: 5,
            body: 'contract test comment',
            user: { id: 1 },
            html_url: 'https://github.com/acme/widgets/pull/7#comment-5',
            created_at: '2026-01-01T00:00:00Z',
          },
          201,
        ),
      'GET /repos/acme/widgets/commits/sha123/check-runs': () =>
        jsonResponse({ total_count: 0, check_runs: [] }),
      'POST /repos/acme/widgets/check-runs': () =>
        jsonResponse(
          {
            id: 1,
            name: 'contract-test-check',
            status: 'in_progress',
            conclusion: null,
            html_url: 'https://github.com/acme/widgets/runs/1',
          },
          201,
        ),
    };

    const handler = routes[key];
    if (!handler) throw new Error(`Unhandled fetch in contract test: ${key}`);
    return handler();
  }) as unknown as typeof fetch;
}

runSourceControlPortContractTests('github', {
  createPort: () =>
    createGithubSourceControlAdapter({
      appId: '12345',
      privateKey,
      installationId: '999',
      fetch: fakeFetch(),
    }),
  ctx: { organizationId: 'org-1' as ProviderContext['organizationId'], connectionId: 'conn-1' },
  repo: 'acme/widgets',
  fromRef: 'main',
  branchName: 'contract-test-branch',
  prNumber: 7,
  headSha: 'sha123',
});
