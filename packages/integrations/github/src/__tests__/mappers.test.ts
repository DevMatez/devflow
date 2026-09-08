import { describe, expect, it } from 'vitest';
import { toRepository, toPullRequest, toComment, toCheckRun, splitRepo } from '../mappers';

describe('splitRepo', () => {
  it('splits "owner/repo" into parts', () => {
    expect(splitRepo('acme/widgets')).toEqual({ owner: 'acme', name: 'widgets' });
  });

  it('throws on a malformed repo string', () => {
    expect(() => splitRepo('widgets')).toThrow();
  });
});

describe('toRepository', () => {
  it('maps the vendor repo shape to the normalized model', () => {
    const repo = toRepository({
      id: 1,
      name: 'widgets',
      full_name: 'acme/widgets',
      default_branch: 'main',
      html_url: 'https://github.com/acme/widgets',
    });

    expect(repo).toEqual({
      externalId: '1',
      name: 'widgets',
      fullName: 'acme/widgets',
      defaultBranch: 'main',
      url: 'https://github.com/acme/widgets',
    });
  });
});

describe('toPullRequest', () => {
  const base = {
    id: 100,
    number: 7,
    title: 'Add feature',
    html_url: 'https://github.com/acme/widgets/pull/7',
    head: { ref: 'feature' },
    base: { ref: 'main' },
    user: { id: 42 },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  };

  it('maps an open pull request', () => {
    const pr = toPullRequest({ ...base, state: 'open' }, 'acme/widgets');
    expect(pr.state).toBe('open');
    expect(pr.externalId).toBe('100');
    expect(pr.authorExternalId).toBe('42');
  });

  it('maps a merged pull request (state=closed, merged=true)', () => {
    const pr = toPullRequest({ ...base, state: 'closed', merged: true }, 'acme/widgets');
    expect(pr.state).toBe('merged');
  });

  it('maps a closed-without-merge pull request', () => {
    const pr = toPullRequest({ ...base, state: 'closed', merged: false }, 'acme/widgets');
    expect(pr.state).toBe('closed');
  });
});

describe('toComment', () => {
  it('maps a comment, defaulting a null body to an empty string', () => {
    const comment = toComment({
      id: 5,
      body: null,
      user: { id: 9 },
      html_url: 'https://github.com/acme/widgets/pull/7#comment-5',
      created_at: '2026-01-01T00:00:00Z',
    });
    expect(comment.body).toBe('');
    expect(comment.authorExternalId).toBe('9');
  });

  it('falls back to "unknown" when the author user is null (e.g. deleted account)', () => {
    const comment = toComment({
      id: 5,
      body: 'hi',
      user: null,
      html_url: 'https://github.com/acme/widgets/pull/7#comment-5',
      created_at: '2026-01-01T00:00:00Z',
    });
    expect(comment.authorExternalId).toBe('unknown');
  });
});

describe('toCheckRun', () => {
  it('maps a known status/conclusion', () => {
    const checkRun = toCheckRun({
      id: 1,
      name: 'build',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/acme/widgets/runs/1',
    });
    expect(checkRun).toEqual({
      externalId: '1',
      name: 'build',
      status: 'completed',
      conclusion: 'success',
      url: 'https://github.com/acme/widgets/runs/1',
    });
  });

  it('falls back to "queued" for an unrecognized status', () => {
    const checkRun = toCheckRun({
      id: 1,
      name: 'build',
      status: 'some_future_status',
      conclusion: null,
      html_url: null,
    });
    expect(checkRun.status).toBe('queued');
    expect(checkRun.conclusion).toBeNull();
    expect(checkRun.url).toBe('');
  });
});
