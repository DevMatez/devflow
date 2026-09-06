import { schema, type Database, type DatabaseTransaction } from '@devflow/database';
import { and, eq, sql } from 'drizzle-orm';
import type { IntegrationCategory, ConnectionStatus } from '@devflow/types';

export type ConnectionRow = typeof schema.integrationConnections.$inferSelect;

export interface CreateConnectionInput {
  organizationId: string;
  category: IntegrationCategory;
  provider: string;
  externalAccount: unknown;
  encryptedCredentials: string;
  credentialsIv: string;
  tokenExpiresAt?: Date;
}

/** One row per (organizationId, category) — unique constraint enforces this at the DB level. */
export async function createConnection(
  db: Database | DatabaseTransaction,
  input: CreateConnectionInput,
): Promise<ConnectionRow> {
  const [row] = await db.insert(schema.integrationConnections).values(input).returning();
  if (!row) throw new Error('createConnection: insert returned no row');
  return row;
}

export function listConnectionsForOrganization(
  db: Database,
  organizationId: string,
): Promise<ConnectionRow[]> {
  return db.query.integrationConnections.findMany({
    where: eq(schema.integrationConnections.organizationId, organizationId),
  });
}

export function findConnection(
  db: Database,
  organizationId: string,
  category: IntegrationCategory,
) {
  return db.query.integrationConnections.findFirst({
    where: and(
      eq(schema.integrationConnections.organizationId, organizationId),
      eq(schema.integrationConnections.category, category),
    ),
  });
}

/** Webhook resolveConnection() lookup (design doc §3.1) — installation id lives in the plaintext external_account jsonb. */
export function findConnectionByInstallationId(db: Database, installationId: string) {
  return db.query.integrationConnections.findFirst({
    where: and(
      eq(schema.integrationConnections.category, 'source-control'),
      eq(schema.integrationConnections.provider, 'github'),
      sql`${schema.integrationConnections.externalAccount}->>'installationId' = ${installationId}`,
    ),
  });
}

/** Same purpose as `findConnectionByInstallationId`, keyed by Plane's workspace_id instead. */
export function findConnectionByWorkspaceId(db: Database, workspaceId: string) {
  return db.query.integrationConnections.findFirst({
    where: and(
      eq(schema.integrationConnections.category, 'project-management'),
      eq(schema.integrationConnections.provider, 'plane'),
      sql`${schema.integrationConnections.externalAccount}->>'workspaceId' = ${workspaceId}`,
    ),
  });
}

/** Same purpose as `findConnectionByInstallationId`, keyed by Slack's team_id instead. */
export function findConnectionByTeamId(db: Database, teamId: string) {
  return db.query.integrationConnections.findFirst({
    where: and(
      eq(schema.integrationConnections.category, 'chat'),
      eq(schema.integrationConnections.provider, 'slack'),
      sql`${schema.integrationConnections.externalAccount}->>'teamId' = ${teamId}`,
    ),
  });
}

export interface UpdateConnectionHealthInput {
  status?: ConnectionStatus;
  lastSyncedAt?: Date;
  lastFailureAt?: Date;
  lastError?: string | null;
}

/** Health-only fields (design doc §3.6) — never credentials/externalAccount. */
export async function updateConnectionHealth(
  db: Database | DatabaseTransaction,
  organizationId: string,
  category: IntegrationCategory,
  input: UpdateConnectionHealthInput,
): Promise<ConnectionRow | undefined> {
  const [row] = await db
    .update(schema.integrationConnections)
    .set({ ...input, updatedAt: new Date() })
    .where(
      and(
        eq(schema.integrationConnections.organizationId, organizationId),
        eq(schema.integrationConnections.category, category),
      ),
    )
    .returning();
  return row;
}

/** Disconnect: mark revoked and wipe credentials (row/audit history is kept, secrets are not). */
export async function revokeConnection(
  db: Database | DatabaseTransaction,
  organizationId: string,
  category: IntegrationCategory,
): Promise<ConnectionRow | undefined> {
  const [row] = await db
    .update(schema.integrationConnections)
    .set({
      status: 'revoked',
      encryptedCredentials: '',
      credentialsIv: '',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.integrationConnections.organizationId, organizationId),
        eq(schema.integrationConnections.category, category),
      ),
    )
    .returning();
  return row;
}

export interface UpdateConnectionCredentialsInput {
  provider: string;
  externalAccount: unknown;
  encryptedCredentials: string;
  credentialsIv: string;
  tokenExpiresAt?: Date;
}

/** Reconnect path: refreshes credentials/externalAccount and clears any prior error state. */
export async function updateConnectionCredentials(
  db: Database | DatabaseTransaction,
  organizationId: string,
  category: IntegrationCategory,
  input: UpdateConnectionCredentialsInput,
): Promise<ConnectionRow | undefined> {
  const [row] = await db
    .update(schema.integrationConnections)
    .set({
      ...input,
      status: 'connected',
      lastError: null,
      lastFailureAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.integrationConnections.organizationId, organizationId),
        eq(schema.integrationConnections.category, category),
      ),
    )
    .returning();
  return row;
}
