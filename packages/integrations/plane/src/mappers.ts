import type { Issue, Comment, NormalizedIssueEvent } from '@devflow/integrations-core';

export interface PlaneWorkItem {
  id: string;
  name: string;
  description?: string | null;
  description_html?: string | null;
  priority?: string | null;
  state_id?: string | null;
  assignee_ids?: string[];
  project_id: string;
  sequence_id?: number;
  created_at: string;
  updated_at: string;
}

export interface PlaneComment {
  id: string;
  comment_stripped?: string | null;
  comment_html?: string | null;
  actor_id?: string;
  created_by_id?: string;
  issue_id: string;
  created_at?: string;
  edited_at?: string | null;
}

/**
 * `state_id` is used as-is for `status` (a UUID, not a human-readable name) --
 * resolving the state's display name needs a separate workspace-states call,
 * deferred as an MVP simplification (design doc keeps normalized models
 * provider-agnostic, not necessarily human-readable this wave).
 */
export function toIssue(item: PlaneWorkItem, workspaceSlug: string): Issue {
  return {
    externalId: item.id,
    title: item.name,
    description: item.description ?? item.description_html ?? null,
    status: item.state_id ?? 'unknown',
    // Plane supports multiple assignees; the normalized model has one -- first wins (known simplification).
    assigneeExternalId: item.assignee_ids?.[0] ?? null,
    url: `https://app.plane.so/${workspaceSlug}/projects/${item.project_id}/issues/${item.sequence_id ?? item.id}`,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
  };
}

export function toComment(
  comment: PlaneComment,
  workspaceSlug: string,
  projectId: string,
): Comment {
  return {
    externalId: comment.id,
    body: comment.comment_stripped ?? comment.comment_html ?? '',
    authorExternalId: comment.actor_id ?? comment.created_by_id ?? 'unknown',
    url: `https://app.plane.so/${workspaceSlug}/projects/${projectId}/issues/${comment.issue_id}`,
    createdAt: comment.created_at ?? comment.edited_at ?? new Date().toISOString(),
  };
}

interface PlaneIssueWebhookData {
  id?: string;
  name?: string;
  project_id?: string | null;
  assignee_ids?: string[];
  completed_at?: string | null;
  updated_at?: string | null;
}

/** Plane v2 webhooks serialize nulls as the Python string `"None"`. */
function planeNullable(value: unknown): string | null {
  return value == null || value === 'None' || value === '' ? null : String(value);
}

/**
 * Normalizes a Plane work-item webhook `data` object into the canonical issue
 * event (design §6.2). The v2 webhook carries `completed_at` but not the state
 * group, so completion is derived from `completed_at`; cancelled can't be told
 * apart from open without a state lookup (deferred), so it never maps here.
 */
export function toNormalizedIssueEvent(data: unknown): NormalizedIssueEvent {
  const item = (data ?? {}) as PlaneIssueWebhookData;
  return {
    externalId: String(item.id ?? ''),
    key: null,
    title: item.name ?? '',
    statusClass: planeNullable(item.completed_at) ? 'completed' : 'open',
    assigneeExternalId: item.assignee_ids?.[0] ?? null,
    projectExternalId: planeNullable(item.project_id),
    url: null,
    updatedAt: planeNullable(item.updated_at),
  };
}
