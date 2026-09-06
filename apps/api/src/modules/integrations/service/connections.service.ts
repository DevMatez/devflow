import type { Database, DatabaseTransaction } from '@devflow/database';
import type { IntegrationCategory, ConnectionStatus } from '@devflow/types';
import type { OrgContext } from '../../access/org-context';
import {
  createConnection as createConnectionRow,
  listConnectionsForOrganization as listConnectionsRows,
  findConnection,
  findConnectionByInstallationId as findConnectionByInstallationIdRow,
  findConnectionByWorkspaceId as findConnectionByWorkspaceIdRow,
  findConnectionByTeamId as findConnectionByTeamIdRow,
  updateConnectionHealth as updateConnectionHealthRow,
  updateConnectionCredentials as updateConnectionCredentialsRow,
  revokeConnection as revokeConnectionRow,
  type ConnectionRow,
  type CreateConnectionInput,
} from '../dal/connections.dal';

export type { ConnectionRow } from '../dal/connections.dal';

export class ConnectionNotFoundError extends Error {
  constructor() {
    super('No integration connection for this category');
  }
}

/** Org-scoped connections list (design doc §10, `GET /organizations/:id/integrations`). */
export function listConnections(db: Database, ctx: OrgContext): Promise<ConnectionRow[]> {
  return listConnectionsRows(db, ctx.organizationId);
}

export function getConnection(
  db: Database,
  ctx: OrgContext,
  category: IntegrationCategory,
): Promise<ConnectionRow | undefined> {
  return findConnection(db, ctx.organizationId, category);
}

/** Used only by webhook resolveConnection() implementations (design doc §3.1) — never by route handlers. */
export function getConnectionByInstallationId(
  db: Database,
  installationId: string,
): Promise<ConnectionRow | undefined> {
  return findConnectionByInstallationIdRow(db, installationId);
}

/** Same purpose as `getConnectionByInstallationId`, keyed by Plane's workspace_id instead. */
export function getConnectionByWorkspaceId(
  db: Database,
  workspaceId: string,
): Promise<ConnectionRow | undefined> {
  return findConnectionByWorkspaceIdRow(db, workspaceId);
}

/** Same purpose as `getConnectionByInstallationId`, keyed by Slack's team_id instead. */
export function getConnectionByTeamId(
  db: Database,
  teamId: string,
): Promise<ConnectionRow | undefined> {
  return findConnectionByTeamIdRow(db, teamId);
}

export interface ConnectInput {
  category: IntegrationCategory;
  provider: string;
  externalAccount: unknown;
  encryptedCredentials: string;
  credentialsIv: string;
  tokenExpiresAt?: Date;
}

/**
 * Persists a new connection row. Called by each adapter's connect flow
 * (GitHub install callback, Slack/Calendar OAuth callback, Plane token
 * submit) once credentials have already been encrypted — this function
 * never touches plaintext secrets or vendor SDKs (design doc §3.4/§11).
 */
export function connect(
  db: Database | DatabaseTransaction,
  ctx: OrgContext,
  input: ConnectInput,
): Promise<ConnectionRow> {
  const row: CreateConnectionInput = {
    organizationId: ctx.organizationId,
    category: input.category,
    provider: input.provider,
    externalAccount: input.externalAccount,
    encryptedCredentials: input.encryptedCredentials,
    credentialsIv: input.credentialsIv,
    tokenExpiresAt: input.tokenExpiresAt,
  };
  return createConnectionRow(db, row);
}

/** Disconnect (design doc §10, `DELETE /organizations/:id/integrations/:category`). */
export async function disconnect(
  db: Database,
  ctx: OrgContext,
  category: IntegrationCategory,
): Promise<void> {
  const row = await revokeConnectionRow(db, ctx.organizationId, category);
  if (!row) throw new ConnectionNotFoundError();
}

/**
 * Connects if no row exists yet for (org, category), otherwise refreshes the
 * existing row's credentials/externalAccount and clears any prior error
 * state — lets a user re-run an adapter's connect flow (e.g. reinstalling a
 * GitHub App) without first having to disconnect.
 */
export async function connectOrReconnect(
  db: Database,
  ctx: OrgContext,
  input: ConnectInput,
): Promise<ConnectionRow> {
  const existing = await findConnection(db, ctx.organizationId, input.category);
  if (!existing) return connect(db, ctx, input);

  const row = await updateConnectionCredentialsRow(db, ctx.organizationId, input.category, {
    provider: input.provider,
    externalAccount: input.externalAccount,
    encryptedCredentials: input.encryptedCredentials,
    credentialsIv: input.credentialsIv,
    tokenExpiresAt: input.tokenExpiresAt,
  });
  if (!row) throw new ConnectionNotFoundError();
  return row;
}

export interface RecordHealthInput {
  status?: ConnectionStatus;
  lastSyncedAt?: Date;
  lastFailureAt?: Date;
  lastError?: string | null;
}

/**
 * Sole writer of connection health fields (design doc §3.6) — called by the
 * service methods that invoke an adapter port, and by the webhook relay for
 * inbound failures. Adapters themselves never write `integration_connections`.
 */
export async function recordConnectionHealth(
  db: Database | DatabaseTransaction,
  organizationId: string,
  category: IntegrationCategory,
  input: RecordHealthInput,
): Promise<void> {
  const row = await updateConnectionHealthRow(db, organizationId, category, input);
  if (!row) throw new ConnectionNotFoundError();
}
