import { schema, type Database, type DatabaseTransaction } from '@devflow/database';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { WorkflowState } from '@devflow/types';

export type WorkItemRow = typeof schema.workItems.$inferSelect;

export interface CreateWorkItemInput {
  organizationId: string;
  projectId: string;
  title: string;
  externalProvider: string;
  externalIssueId: string;
  externalIssueKey?: string | null;
  externalIssueUrl?: string | null;
  externalAssigneeId?: string | null;
  assigneeUserId?: string | null;
  workflowState?: WorkflowState;
}

/** One row per (organizationId, externalProvider, externalIssueId) — unique constraint enforces this (design §3.1). */
export async function createWorkItem(
  db: Database | DatabaseTransaction,
  input: CreateWorkItemInput,
): Promise<WorkItemRow> {
  const [row] = await db.insert(schema.workItems).values(input).returning();
  if (!row) throw new Error('createWorkItem: insert returned no row');
  return row;
}

/** Org-scoped lookup — a work item in another org is invisible (design §12). */
export function findWorkItemById(db: Database, organizationId: string, workItemId: string) {
  return db.query.workItems.findFirst({
    where: and(
      eq(schema.workItems.organizationId, organizationId),
      eq(schema.workItems.id, workItemId),
    ),
  });
}

export function findWorkItemByExternalIssue(
  db: Database | DatabaseTransaction,
  organizationId: string,
  externalProvider: string,
  externalIssueId: string,
) {
  return db.query.workItems.findFirst({
    where: and(
      eq(schema.workItems.organizationId, organizationId),
      eq(schema.workItems.externalProvider, externalProvider),
      eq(schema.workItems.externalIssueId, externalIssueId),
    ),
  });
}

export interface ListWorkItemsFilter {
  projectId?: string;
  workflowState?: WorkflowState;
  assigneeUserId?: string;
}

export function listWorkItems(
  db: Database,
  organizationId: string,
  filter: ListWorkItemsFilter = {},
): Promise<WorkItemRow[]> {
  const conditions = [eq(schema.workItems.organizationId, organizationId)];
  if (filter.projectId) conditions.push(eq(schema.workItems.projectId, filter.projectId));
  if (filter.workflowState)
    conditions.push(eq(schema.workItems.workflowState, filter.workflowState));
  if (filter.assigneeUserId)
    conditions.push(eq(schema.workItems.assigneeUserId, filter.assigneeUserId));

  return db.query.workItems.findMany({
    where: and(...conditions),
    orderBy: desc(schema.workItems.createdAt),
  });
}

export interface ApplyStateChangeInput {
  workflowState: WorkflowState;
  blockedFromState: WorkflowState | null;
}

/**
 * Persists a state-machine result, bumping `version` for aggregate-ordered
 * events (design §8). Returns the updated row, or `undefined` if the id isn't
 * in the org.
 */
export async function applyStateChange(
  db: Database | DatabaseTransaction,
  organizationId: string,
  workItemId: string,
  input: ApplyStateChangeInput,
): Promise<WorkItemRow | undefined> {
  const [row] = await db
    .update(schema.workItems)
    .set({
      workflowState: input.workflowState,
      blockedFromState: input.blockedFromState,
      version: sql`${schema.workItems.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(eq(schema.workItems.organizationId, organizationId), eq(schema.workItems.id, workItemId)),
    )
    .returning();
  return row;
}
