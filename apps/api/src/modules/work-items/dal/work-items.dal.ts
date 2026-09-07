import { schema, type Database, type DatabaseTransaction } from '@devflow/database';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { WorkflowState, WorkflowExecutionStatus, BranchRef, PrRef } from '@devflow/types';

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
  lastExternalVersion?: string | null;
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
export function findWorkItemById(
  db: Database | DatabaseTransaction,
  organizationId: string,
  workItemId: string,
) {
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

/** Sets the automation-health axis, independent of workflow_state (design §4.5). */
export async function setWorkflowExecutionStatus(
  db: Database | DatabaseTransaction,
  organizationId: string,
  workItemId: string,
  status: WorkflowExecutionStatus,
  error: string | null = null,
): Promise<void> {
  await db
    .update(schema.workItems)
    .set({ workflowExecutionStatus: status, workflowExecutionError: error, updatedAt: new Date() })
    .where(
      and(eq(schema.workItems.organizationId, organizationId), eq(schema.workItems.id, workItemId)),
    );
}

export async function setBranchRef(
  db: Database | DatabaseTransaction,
  organizationId: string,
  workItemId: string,
  branchRef: BranchRef,
): Promise<void> {
  await db
    .update(schema.workItems)
    .set({ branchRef, updatedAt: new Date() })
    .where(
      and(eq(schema.workItems.organizationId, organizationId), eq(schema.workItems.id, workItemId)),
    );
}

export async function setPrRef(
  db: Database | DatabaseTransaction,
  organizationId: string,
  workItemId: string,
  prRef: PrRef,
): Promise<void> {
  await db
    .update(schema.workItems)
    .set({ prRef, updatedAt: new Date() })
    .where(
      and(eq(schema.workItems.organizationId, organizationId), eq(schema.workItems.id, workItemId)),
    );
}

/**
 * Locks the matched work item row (`FOR UPDATE`) so concurrent reconcile jobs
 * for the same item serialize rather than interleave (design §6.4). Must run
 * inside a transaction.
 */
export async function lockWorkItemByExternalIssue(
  tx: DatabaseTransaction,
  organizationId: string,
  externalProvider: string,
  externalIssueId: string,
): Promise<WorkItemRow | undefined> {
  const rows = await tx
    .select()
    .from(schema.workItems)
    .where(
      and(
        eq(schema.workItems.organizationId, organizationId),
        eq(schema.workItems.externalProvider, externalProvider),
        eq(schema.workItems.externalIssueId, externalIssueId),
      ),
    )
    .for('update')
    .limit(1);
  return rows[0];
}

export interface MirrorPatch {
  title?: string;
  externalIssueKey?: string | null;
  externalAssigneeId?: string | null;
  assigneeUserId?: string | null;
  lastExternalVersion?: string | null;
}

/** Updates cached mirror columns + reconcile cursor (design §6.2, §6.4). Never touches workflow_state. */
export async function updateWorkItemMirror(
  db: Database | DatabaseTransaction,
  organizationId: string,
  workItemId: string,
  patch: MirrorPatch,
): Promise<void> {
  await db
    .update(schema.workItems)
    .set({
      ...patch,
      lastReconciledAt: new Date(),
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(schema.workItems.organizationId, organizationId), eq(schema.workItems.id, workItemId)),
    );
}

/**
 * Locks the work item matching a PR event (`FOR UPDATE`, design §6.1, §6.4):
 * primary match is the `pr_ref` pointer (repo + number); fallback is the head
 * branch (`branch_ref`) for the first `opened` before `pr_ref` is set. Must
 * run inside a transaction.
 */
export async function lockWorkItemForPrEvent(
  tx: DatabaseTransaction,
  organizationId: string,
  repo: string,
  number: number,
  headBranch: string,
): Promise<WorkItemRow | undefined> {
  const byPrRef = await tx
    .select()
    .from(schema.workItems)
    .where(
      and(
        eq(schema.workItems.organizationId, organizationId),
        sql`${schema.workItems.prRef}->>'repo' = ${repo}`,
        sql`${schema.workItems.prRef}->>'number' = ${String(number)}`,
      ),
    )
    .for('update')
    .limit(1);
  if (byPrRef[0]) return byPrRef[0];

  const byBranch = await tx
    .select()
    .from(schema.workItems)
    .where(
      and(
        eq(schema.workItems.organizationId, organizationId),
        sql`${schema.workItems.branchRef}->>'repo' = ${repo}`,
        sql`${schema.workItems.branchRef}->>'name' = ${headBranch}`,
        sql`${schema.workItems.prRef} is null`,
      ),
    )
    .for('update')
    .limit(1);
  return byBranch[0];
}
