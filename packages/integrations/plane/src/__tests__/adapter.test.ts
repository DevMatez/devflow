import { describe, expect, it, vi } from 'vitest';
import { createPlaneProjectManagementAdapter } from '../adapter';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const ctx = { organizationId: 'org-1', connectionId: 'conn-1' } as never;

describe('createPlaneProjectManagementAdapter', () => {
  it('createIssue posts to the project work-items endpoint and maps the response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          id: 'item-1',
          name: 'New issue',
          project_id: 'project-1',
          sequence_id: 1,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        201,
      ),
    );
    const adapter = createPlaneProjectManagementAdapter({
      apiToken: 'test-token',
      workspaceSlug: 'acme',
      fetch: fetchImpl,
    });

    const issue = await adapter.createIssue(ctx, { projectId: 'project-1', title: 'New issue' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.plane.so/api/v1/workspaces/acme/projects/project-1/work-items/',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(issue.externalId).toBe('item-1');
    expect(issue.title).toBe('New issue');
  });

  it('getIssue fetches the specific work item', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'item-1',
        name: 'Existing issue',
        project_id: 'project-1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }),
    );
    const adapter = createPlaneProjectManagementAdapter({
      apiToken: 'test-token',
      workspaceSlug: 'acme',
      fetch: fetchImpl,
    });

    const issue = await adapter.getIssue(ctx, { projectId: 'project-1', externalId: 'item-1' });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.plane.so/api/v1/workspaces/acme/projects/project-1/work-items/item-1/',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(issue.title).toBe('Existing issue');
  });

  it('updateIssue patches the work item, mapping status to state_id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        id: 'item-1',
        name: 'Renamed',
        state_id: 'state-2',
        project_id: 'project-1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      }),
    );
    const adapter = createPlaneProjectManagementAdapter({
      apiToken: 'test-token',
      workspaceSlug: 'acme',
      fetch: fetchImpl,
    });

    const issue = await adapter.updateIssue(ctx, {
      projectId: 'project-1',
      externalId: 'item-1',
      title: 'Renamed',
      status: 'state-2',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.plane.so/api/v1/workspaces/acme/projects/project-1/work-items/item-1/',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.stringContaining('"state_id":"state-2"'),
      }),
    );
    expect(issue.status).toBe('state-2');
  });

  it('createComment posts to the work item comments endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          id: 'comment-1',
          comment_stripped: 'Looks good',
          actor_id: 'user-1',
          issue_id: 'item-1',
          created_at: '2026-01-01T00:00:00Z',
        },
        201,
      ),
    );
    const adapter = createPlaneProjectManagementAdapter({
      apiToken: 'test-token',
      workspaceSlug: 'acme',
      fetch: fetchImpl,
    });

    const comment = await adapter.createComment(ctx, {
      repo: 'project-1',
      targetExternalId: 'item-1',
      body: 'Looks good',
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.plane.so/api/v1/workspaces/acme/projects/project-1/work-items/item-1/comments/',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(comment.externalId).toBe('comment-1');
    expect(comment.body).toBe('Looks good');
  });
});
