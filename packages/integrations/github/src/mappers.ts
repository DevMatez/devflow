import type { Repository, PullRequest, Comment, CheckRun } from '@devflow/integrations-core';

export interface GithubUser {
  id: number | string;
}

export interface GithubRepo {
  id: number | string;
  name: string;
  full_name: string;
  default_branch: string;
  html_url: string;
}

export interface GithubPullRequest {
  id: number | string;
  number: number;
  title: string;
  state: string;
  merged?: boolean;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
  user: GithubUser;
  created_at: string;
  updated_at: string;
}

export interface GithubComment {
  id: number | string;
  body?: string | null;
  user: GithubUser | null;
  html_url: string;
  created_at: string;
}

export interface GithubCheckRun {
  id: number | string;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
}

export function toRepository(repo: GithubRepo): Repository {
  return {
    externalId: String(repo.id),
    name: repo.name,
    fullName: repo.full_name,
    defaultBranch: repo.default_branch,
    url: repo.html_url,
  };
}

export function toPullRequest(pr: GithubPullRequest, repoFullName: string): PullRequest {
  return {
    externalId: String(pr.id),
    repo: repoFullName,
    number: pr.number,
    title: pr.title,
    state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    url: pr.html_url,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    authorExternalId: String(pr.user.id),
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
  };
}

export function toComment(comment: GithubComment): Comment {
  return {
    externalId: String(comment.id),
    body: comment.body ?? '',
    authorExternalId: comment.user ? String(comment.user.id) : 'unknown',
    url: comment.html_url,
    createdAt: comment.created_at,
  };
}

const CHECK_RUN_STATUSES = new Set(['queued', 'in_progress', 'completed']);
const CHECK_RUN_CONCLUSIONS = new Set(['success', 'failure', 'neutral', 'cancelled', 'skipped']);

export function toCheckRun(checkRun: GithubCheckRun): CheckRun {
  return {
    externalId: String(checkRun.id),
    name: checkRun.name,
    status: (CHECK_RUN_STATUSES.has(checkRun.status)
      ? checkRun.status
      : 'queued') as CheckRun['status'],
    conclusion: (checkRun.conclusion && CHECK_RUN_CONCLUSIONS.has(checkRun.conclusion)
      ? checkRun.conclusion
      : null) as CheckRun['conclusion'],
    url: checkRun.html_url ?? '',
  };
}

export function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/');
  if (!owner || !name) throw new Error(`Expected "owner/repo", got "${repo}"`);
  return { owner, name };
}
