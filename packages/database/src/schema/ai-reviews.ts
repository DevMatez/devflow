import { pgTable, uuid, text, integer, jsonb, timestamp, unique, index } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { workItems } from './work-items';

export type AiReviewStatus = 'pending' | 'completed' | 'failed';
export type AiReviewPolicyConclusion = 'success' | 'failure';

/**
 * One AI review of one PR commit (Wave 4 design §2, §6). DevFlow-owned and
 * authoritative — the GitHub check is a projection of this row. A new push
 * creates a new row; the unique key makes a redelivered trigger reuse the
 * existing row instead of re-billing the model.
 */
export const aiReviews = pgTable(
  'ai_reviews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    workItemId: uuid('work_item_id')
      .notNull()
      .references(() => workItems.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(),
    prNumber: integer('pr_number').notNull(),
    headSha: text('head_sha').notNull(),
    status: text('status').$type<AiReviewStatus>().notNull().default('pending'),
    policyConclusion: text('policy_conclusion').$type<AiReviewPolicyConclusion>(),
    summary: text('summary'),
    /** `CodeReviewResult['findings']`, stored as-is. */
    findings: jsonb('findings'),
    rulesVersion: text('rules_version'),
    promptVersion: text('prompt_version').notNull(),
    model: text('model'),
    provider: text('provider'),
    checkRunExternalId: text('check_run_external_id'),
    /** Cached pointer to the summary PR comment, so a retried projection never double-posts. */
    commentExternalId: text('comment_external_id'),
    error: text('error'),
    /** Which job holds the review (lease) — two triggers for one commit must not both call the model. */
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique().on(table.organizationId, table.repo, table.prNumber, table.headSha),
    index('ai_reviews_org_item_created_idx').on(
      table.organizationId,
      table.workItemId,
      table.createdAt,
    ),
  ],
);
