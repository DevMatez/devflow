import { pgTable, uuid, text, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
import type { IntegrationCategory, ConnectionStatus } from '@devflow/types';
import { organizations } from './organizations';

/**
 * One connection per (org, category) in MVP (Wave 2 design doc §3.4).
 * Credentials are encrypted at rest (`@devflow/integrations-core`'s
 * crypto.ts); `external_account` is plaintext display info only
 * (installation id, workspace name, …), never a secret.
 */
export const integrationConnections = pgTable(
  'integration_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    category: text('category').$type<IntegrationCategory>().notNull(),
    provider: text('provider').notNull(),
    status: text('status').$type<ConnectionStatus>().notNull().default('connected'),
    externalAccount: jsonb('external_account').notNull(),
    encryptedCredentials: text('encrypted_credentials').notNull(),
    credentialsIv: text('credentials_iv').notNull(),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.organizationId, table.category)],
);
