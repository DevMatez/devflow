import { pgTable, uuid, text, jsonb, integer, timestamp, unique, index } from 'drizzle-orm/pg-core';
import type { WorkflowState, WorkflowExecutionStatus, BranchRef, PrRef } from '@devflow/types';
import { organizations } from './organizations';
import { projects } from './projects';
import { users } from './users';

/**
 * Core Wave 3 aggregate (design §3.1, §9). DevFlow owns `workflow_state` and
 * the cross-system relationships; the mirror columns (`title`,
 * `external_*`, `assignee_*`) are cached copies of PM/GitHub-owned data,
 * never the source of truth. `version` backs aggregate-ordered domain events.
 */
export const workItems = pgTable(
  'work_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    externalProvider: text('external_provider').notNull(),
    externalIssueId: text('external_issue_id').notNull(),
    externalIssueKey: text('external_issue_key'),
    externalIssueUrl: text('external_issue_url'),
    workflowState: text('workflow_state').$type<WorkflowState>().notNull().default('backlog'),
    blockedFromState: text('blocked_from_state').$type<WorkflowState>(),
    workflowExecutionStatus: text('workflow_execution_status')
      .$type<WorkflowExecutionStatus>()
      .notNull()
      .default('not_started'),
    workflowExecutionError: text('workflow_execution_error'),
    assigneeUserId: uuid('assignee_user_id').references(() => users.id, { onDelete: 'set null' }),
    externalAssigneeId: text('external_assignee_id'),
    branchRef: jsonb('branch_ref').$type<BranchRef>(),
    prRef: jsonb('pr_ref').$type<PrRef>(),
    lastExternalVersion: text('last_external_version'),
    version: integer('version').notNull().default(0),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.organizationId, table.externalProvider, table.externalIssueId),
    index('work_items_org_project_idx').on(table.organizationId, table.projectId),
    index('work_items_org_state_idx').on(table.organizationId, table.workflowState),
  ],
);
