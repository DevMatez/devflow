import { decryptCredentials, encryptCredentials } from '@devflow/integrations-core';
import { fetchPlaneWorkspace, type PlaneClientOptions } from '@devflow/integrations-plane';
import type { Database } from '@devflow/database';
import type { OrgContext } from '../../access/org-context';
import {
  connectOrReconnect,
  getConnectionByWorkspaceId,
  type ConnectionRow,
} from './connections.service';

export interface PlaneCredentials {
  apiToken: string;
  webhookSecret: string;
}

export interface ConnectPlaneInput {
  workspaceSlug: string;
  apiToken: string;
  webhookSecret: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: PlaneClientOptions['fetch'];
}

/**
 * Validates the token against the workspace, then persists the connection.
 * The webhook secret travels in the connect body too (extends the design
 * doc's literal `{ workspaceSlug, apiToken }` request shape) — Plane has no
 * App-level shared secret like GitHub's; each org's webhook has its own
 * auto-generated secret that only the org admin can supply.
 */
export async function connectPlaneWorkspace(
  db: Database,
  ctx: OrgContext,
  credentialsKey: Buffer,
  input: ConnectPlaneInput,
): Promise<ConnectionRow> {
  const workspace = await fetchPlaneWorkspace(
    { apiToken: input.apiToken, fetch: input.fetch },
    input.workspaceSlug,
  );

  const credentials: PlaneCredentials = {
    apiToken: input.apiToken,
    webhookSecret: input.webhookSecret,
  };
  const encrypted = encryptCredentials(credentialsKey, JSON.stringify(credentials));

  return connectOrReconnect(db, ctx, {
    category: 'project-management',
    provider: 'plane',
    externalAccount: { workspaceSlug: workspace.slug, workspaceId: workspace.id },
    encryptedCredentials: encrypted.ciphertext,
    credentialsIv: encrypted.iv,
  });
}

/** Webhook verify() lookup — decrypts only the connection matched by workspace_id, never all connections. */
export async function getPlaneWebhookSecretForWorkspace(
  db: Database,
  credentialsKey: Buffer,
  workspaceId: string,
): Promise<string | null> {
  const connection = await getConnectionByWorkspaceId(db, workspaceId);
  if (!connection) return null;

  try {
    const decrypted = decryptCredentials(credentialsKey, {
      ciphertext: connection.encryptedCredentials,
      iv: connection.credentialsIv,
    });
    const credentials = JSON.parse(decrypted) as PlaneCredentials;
    return credentials.webhookSecret;
  } catch {
    return null;
  }
}
