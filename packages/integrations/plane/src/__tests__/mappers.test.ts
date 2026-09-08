import { describe, expect, it } from 'vitest';
import { toIssue, toComment } from '../mappers';

describe('toIssue', () => {
  it('maps a work item, falling back state_id to "unknown" and taking the first assignee', () => {
    const issue = toIssue(
      {
        id: 'item-1',
        name: 'Fix bug',
        description: 'Details here',
        state_id: 'state-123',
        assignee_ids: ['user-1', 'user-2'],
        project_id: 'project-1',
        sequence_id: 42,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
      },
      'acme',
    );

    expect(issue).toEqual({
      externalId: 'item-1',
      title: 'Fix bug',
      description: 'Details here',
      status: 'state-123',
      assigneeExternalId: 'user-1',
      url: 'https://app.plane.so/acme/projects/project-1/issues/42',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
    });
  });

  it('falls back to "unknown" status and null assignee/description when absent', () => {
    const issue = toIssue(
      {
        id: 'item-2',
        name: 'No state',
        project_id: 'project-1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      'acme',
    );

    expect(issue.status).toBe('unknown');
    expect(issue.assigneeExternalId).toBeNull();
    expect(issue.description).toBeNull();
  });

  it('falls back the URL to the raw id when sequence_id is absent', () => {
    const issue = toIssue(
      {
        id: 'item-3',
        name: 'No sequence',
        project_id: 'project-1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
      'acme',
    );
    expect(issue.url).toBe('https://app.plane.so/acme/projects/project-1/issues/item-3');
  });
});

describe('toComment', () => {
  it('maps a comment, preferring comment_stripped over comment_html', () => {
    const comment = toComment(
      {
        id: 'comment-1',
        comment_stripped: 'Plain text',
        comment_html: '<p>Plain text</p>',
        actor_id: 'user-1',
        issue_id: 'item-1',
        created_at: '2026-01-01T00:00:00Z',
      },
      'acme',
      'project-1',
    );

    expect(comment).toEqual({
      externalId: 'comment-1',
      body: 'Plain text',
      authorExternalId: 'user-1',
      url: 'https://app.plane.so/acme/projects/project-1/issues/item-1',
      createdAt: '2026-01-01T00:00:00Z',
    });
  });

  it('falls back created_by_id and comment_html when actor_id/comment_stripped are absent', () => {
    const comment = toComment(
      {
        id: 'comment-2',
        comment_html: '<p>Fallback</p>',
        created_by_id: 'user-2',
        issue_id: 'item-1',
      },
      'acme',
      'project-1',
    );

    expect(comment.body).toBe('<p>Fallback</p>');
    expect(comment.authorExternalId).toBe('user-2');
    expect(comment.createdAt).toBeTruthy();
  });
});
