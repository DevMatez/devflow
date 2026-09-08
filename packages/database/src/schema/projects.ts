import { pgTable, uuid, text, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import type { WorkflowConfig } from '@devflow/types';
import { organizations } from './organizations';

/** `key` is reserved for future ticket numbering, unused in Wave 1; `workflowConfig` is validated at the app boundary. */
export const projects = pgTable(
  'projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    key: text('key'),
    workflowConfig: jsonb('workflow_config').$type<WorkflowConfig>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.organizationId, table.slug)],
);
