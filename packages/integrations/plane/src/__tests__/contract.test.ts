import { runProjectManagementPortContractTests } from '@devflow/integrations-core/contract-tests';
import type { ProviderContext } from '@devflow/integrations-core';
import { createPlaneProjectManagementAdapter } from '../adapter';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const workItemFixture = {
  id: 'item-1',
  name: 'Contract test issue',
  project_id: 'project-1',
  sequence_id: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const key = `${method} ${url.pathname}`;

    const routes: Record<string, () => Response> = {
      'POST /api/v1/workspaces/acme/projects/project-1/work-items/': () =>
        jsonResponse(workItemFixture, 201),
      'GET /api/v1/workspaces/acme/projects/project-1/work-items/item-1/': () =>
        jsonResponse(workItemFixture),
      'PATCH /api/v1/workspaces/acme/projects/project-1/work-items/item-1/': () =>
        jsonResponse({ ...workItemFixture, name: 'Updated title' }),
      'POST /api/v1/workspaces/acme/projects/project-1/work-items/item-1/comments/': () =>
        jsonResponse(
          {
            id: 'comment-1',
            comment_stripped: 'contract test comment',
            actor_id: 'user-1',
            issue_id: 'item-1',
            created_at: '2026-01-01T00:00:00Z',
          },
          201,
        ),
    };

    const handler = routes[key];
    if (!handler) throw new Error(`Unhandled fetch in contract test: ${key}`);
    return handler();
  }) as unknown as typeof fetch;
}

runProjectManagementPortContractTests('plane', {
  createPort: () =>
    createPlaneProjectManagementAdapter({
      apiToken: 'test-token',
      workspaceSlug: 'acme',
      fetch: fakeFetch(),
    }),
  ctx: { organizationId: 'org-1' as ProviderContext['organizationId'], connectionId: 'conn-1' },
  projectId: 'project-1',
  issueExternalId: 'item-1',
});
