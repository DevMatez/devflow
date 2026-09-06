/**
 * Canonical enum values for the domain. These `as const` arrays are the single
 * source of truth; `@devflow/validation` builds Zod schemas from them and the
 * union types below are derived from the same arrays.
 */

export const ROLES = ['owner', 'admin', 'developer', 'reviewer', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const INVITATION_STATUSES = ['pending', 'accepted', 'revoked', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const CONNECTION_STATUSES = ['connected', 'error', 'revoked'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** Work-item domain lifecycle (Wave 3 design §3.2). BLOCKED carries `blockedFromState`. */
export const WORKFLOW_STATES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
  'done',
  'cancelled',
] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** Branch/PR automation health, orthogonal to WorkflowState (Wave 3 design §4.5). */
export const WORKFLOW_EXECUTION_STATUSES = [
  'not_started',
  'running',
  'completed',
  'failed',
] as const;
export type WorkflowExecutionStatus = (typeof WORKFLOW_EXECUTION_STATUSES)[number];

/** Cached branch-pointer lifecycle on a work item (Wave 3 design §9, §4.3). */
export const BRANCH_REF_STATUSES = ['pending', 'active'] as const;
export type BranchRefStatus = (typeof BRANCH_REF_STATUSES)[number];

/** Cached PR-pointer state on a work item (Wave 3 design §9). */
export const PR_REF_STATES = ['open', 'closed', 'merged'] as const;
export type PrRefState = (typeof PR_REF_STATES)[number];

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const INTEGRATION_CATEGORIES = [
  'source-control',
  'project-management',
  'chat',
  'calendar',
] as const;
export type IntegrationCategory = (typeof INTEGRATION_CATEGORIES)[number];
