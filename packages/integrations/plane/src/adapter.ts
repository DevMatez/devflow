import type {
  ProjectManagementPort,
  CreateIssueInput,
  UpdateIssueInput,
  CreateCommentInput,
  Issue,
  Comment,
} from '@devflow/integrations-core';
import { createPlaneClient, type PlaneClientOptions } from './client';
import { toIssue, toComment, type PlaneWorkItem, type PlaneComment } from './mappers';

export interface PlaneAdapterOptions extends PlaneClientOptions {
  workspaceSlug: string;
}

function workItemsPath(workspaceSlug: string, projectId: string): string {
  return `/api/v1/workspaces/${workspaceSlug}/projects/${projectId}/work-items/`;
}

/** One instance per resolved connection (built by the registry's createAdapter callback) — already workspace-scoped. */
export function createPlaneProjectManagementAdapter(
  options: PlaneAdapterOptions,
): ProjectManagementPort {
  const client = createPlaneClient(options);
  const { workspaceSlug } = options;

  return {
    async createIssue(_ctx, input: CreateIssueInput): Promise<Issue> {
      const item = await client.post<PlaneWorkItem>(workItemsPath(workspaceSlug, input.projectId), {
        name: input.title,
        description: input.description,
        assignee_ids: input.assigneeExternalId ? [input.assigneeExternalId] : undefined,
      });
      return toIssue(item, workspaceSlug);
    },

    async updateIssue(_ctx, input: UpdateIssueInput): Promise<Issue> {
      const item = await client.patch<PlaneWorkItem>(
        `${workItemsPath(workspaceSlug, input.projectId)}${input.externalId}/`,
        {
          name: input.title,
          description: input.description,
          state_id: input.status,
          assignee_ids:
            input.assigneeExternalId === undefined
              ? undefined
              : input.assigneeExternalId === null
                ? []
                : [input.assigneeExternalId],
        },
      );
      return toIssue(item, workspaceSlug);
    },

    async getIssue(_ctx, input: { projectId: string; externalId: string }): Promise<Issue> {
      const item = await client.get<PlaneWorkItem>(
        `${workItemsPath(workspaceSlug, input.projectId)}${input.externalId}/`,
      );
      return toIssue(item, workspaceSlug);
    },

    async createComment(_ctx, input: CreateCommentInput): Promise<Comment> {
      // `repo` is reused as the project id (design doc's shared CreateCommentInput, mirrors SourceControlPort).
      const comment = await client.post<PlaneComment>(
        `${workItemsPath(workspaceSlug, input.repo)}${input.targetExternalId}/comments/`,
        { comment_html: input.body },
      );
      return toComment(comment, workspaceSlug, input.repo);
    },
  };
}
