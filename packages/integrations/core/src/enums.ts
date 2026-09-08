export const PULL_REQUEST_STATES = ['open', 'closed', 'merged'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

export const CHECK_RUN_STATUSES = ['queued', 'in_progress', 'completed'] as const;
export type CheckRunStatus = (typeof CHECK_RUN_STATUSES)[number];

export const CHECK_RUN_CONCLUSIONS = [
  'success',
  'failure',
  'neutral',
  'cancelled',
  'skipped',
] as const;
export type CheckRunConclusion = (typeof CHECK_RUN_CONCLUSIONS)[number] | null;

// ConnectionStatus lives in @devflow/types (packages/database's schema needs it too;
// database must never depend on this package).
export type { ConnectionStatus } from '@devflow/types';
