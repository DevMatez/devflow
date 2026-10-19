import type { Database } from '@devflow/database';
import { publishOutbox } from '@devflow/events';
import { normalizeSlug, workflowConfigSchema } from '@devflow/validation';
import type { WorkflowConfig } from '@devflow/types';
import type { OrgContext } from '../../access/org-context';
import {
  createProject as createProjectRow,
  findProjectById,
  listProjects as listProjectRows,
  updateProject as updateProjectRow,
  type ProjectRow,
} from '../dal/projects.dal';
import { ProjectCreated, ProjectWorkflowConfigUpdated } from '../events';

export class ProjectNotFoundError extends Error {
  constructor() {
    super('Project not found in this organization');
  }
}

export class ProjectSlugTakenError extends Error {
  constructor(slug: string) {
    super(`A project with slug "${slug}" already exists in this organization`);
  }
}

/** Postgres unique_violation, whether or not the driver error is wrapped. */
function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** A partial config change; `notificationChannelId: null` clears the channel. */
export interface WorkflowConfigPatch {
  branchNamingPattern?: string;
  prTitleTemplate?: string;
  reviewPolicy?: { requiredApprovals?: number; requireAiReview?: boolean };
  notificationChannelId?: string | null;
}

export interface CreateProjectInput {
  name: string;
  slug?: string;
  key?: string;
  workflowConfig?: WorkflowConfigPatch;
}

export interface UpdateProjectInput {
  name?: string;
  slug?: string;
  key?: string | null;
  workflowConfig?: WorkflowConfigPatch;
}

/** Merges a patch onto a base config and re-validates (defaults fill anything unset). */
export function mergeWorkflowConfig(
  base: Partial<WorkflowConfig>,
  patch: WorkflowConfigPatch = {},
): WorkflowConfig {
  const { notificationChannelId, reviewPolicy, ...rest } = patch;
  const merged: Record<string, unknown> = {
    ...base,
    ...rest,
    reviewPolicy: { ...base.reviewPolicy, ...reviewPolicy },
  };
  if (notificationChannelId === null) delete merged.notificationChannelId;
  else if (notificationChannelId !== undefined)
    merged.notificationChannelId = notificationChannelId;
  return workflowConfigSchema.parse(merged);
}

/**
 * Admin+ creates a project (Wave 1 design §5). Slug is validated if supplied,
 * derived from the name otherwise. Row + `project.created` are one transaction.
 */
export async function createProject(
  db: Database,
  ctx: OrgContext,
  input: CreateProjectInput,
  correlationId: string,
): Promise<ProjectRow> {
  const slug = input.slug ?? normalizeSlug(input.name);
  const workflowConfig = mergeWorkflowConfig({}, input.workflowConfig);

  try {
    return await db.transaction(async (tx) => {
      const project = await createProjectRow(tx, {
        organizationId: ctx.organizationId,
        name: input.name,
        slug,
        key: input.key ?? null,
        workflowConfig,
      });
      await publishOutbox(
        tx,
        ProjectCreated.create({
          organizationId: ctx.organizationId,
          aggregateId: project.id,
          correlationId,
          payload: { projectId: project.id, name: project.name, slug: project.slug },
        }),
      );
      return project;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProjectSlugTakenError(slug);
    throw error;
  }
}

export function listProjects(db: Database, ctx: OrgContext): Promise<ProjectRow[]> {
  return listProjectRows(db, ctx.organizationId);
}

export async function getProject(
  db: Database,
  ctx: OrgContext,
  projectId: string,
): Promise<ProjectRow> {
  const project = await findProjectById(db, ctx.organizationId, projectId);
  if (!project) throw new ProjectNotFoundError();
  return project;
}

/** Admin+ edits name/slug/key and/or merges a workflow-config patch. */
export async function updateProject(
  db: Database,
  ctx: OrgContext,
  projectId: string,
  input: UpdateProjectInput,
  correlationId: string,
): Promise<ProjectRow> {
  try {
    return await db.transaction(async (tx) => {
      const existing = await findProjectById(tx, ctx.organizationId, projectId);
      if (!existing) throw new ProjectNotFoundError();

      const workflowConfig = input.workflowConfig
        ? mergeWorkflowConfig(existing.workflowConfig, input.workflowConfig)
        : undefined;

      const updated = await updateProjectRow(tx, ctx.organizationId, projectId, {
        name: input.name,
        slug: input.slug,
        key: input.key,
        workflowConfig,
      });
      if (!updated) throw new ProjectNotFoundError();

      if (workflowConfig) {
        await publishOutbox(
          tx,
          ProjectWorkflowConfigUpdated.create({
            organizationId: ctx.organizationId,
            aggregateId: projectId,
            correlationId,
            payload: { projectId, workflowConfig },
          }),
        );
      }
      return updated;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ProjectSlugTakenError(input.slug ?? '');
    throw error;
  }
}
