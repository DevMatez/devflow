import { encryptCredentials } from '@devflow/integrations-core';
import { createGithubAppClient } from '@devflow/integrations-github';
import type { Database } from '@devflow/database';
import type { OrgContext } from '../../access/org-context';
import { connectOrReconnect, type ConnectionRow } from './connections.service';

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
}

export function decodeGithubAppPrivateKey(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}

/**
 * Verifies the installation via the App's JWT (design doc §5), then persists
 * the connection with encrypted credentials. Never touches plaintext outside
 * this call — `encryptCredentials` runs before anything reaches the DB.
 */
export async function completeGithubInstall(
  db: Database,
  ctx: OrgContext,
  config: GithubAppConfig,
  credentialsKey: Buffer,
  installationId: string,
): Promise<ConnectionRow> {
  const client = createGithubAppClient({ appId: config.appId, privateKey: config.privateKey });
  const installation = await client.getInstallation(installationId);

  const encrypted = encryptCredentials(
    credentialsKey,
    JSON.stringify({ installationId: installation.installationId }),
  );

  return connectOrReconnect(db, ctx, {
    category: 'source-control',
    provider: 'github',
    externalAccount: {
      login: installation.accountLogin,
      avatarUrl: installation.accountAvatarUrl,
    },
    encryptedCredentials: encrypted.ciphertext,
    credentialsIv: encrypted.iv,
  });
}
