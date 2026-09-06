import { pgTable, uuid, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { Role, InvitationStatus } from '@devflow/types';
import { organizations } from './organizations';
import { users } from './users';

/** Only the token hash is stored; the partial unique index keeps one pending invite per (org, email). */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role').$type<Role>().notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    status: text('status').$type<InvitationStatus>().notNull().default('pending'),
    // ON DELETE no action (explicit): invitations must survive deletion of the inviting user, to preserve the audit trail of who invited whom.
    invitedByUserId: uuid('invited_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'no action' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('invitations_pending_org_email_idx')
      .on(table.organizationId, table.email)
      .where(sql`${table.status} = 'pending'`),
  ],
);
