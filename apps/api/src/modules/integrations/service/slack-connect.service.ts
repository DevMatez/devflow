import { encryptCredentials } from '@devflow/integrations-core';
import { exchangeSlackCode, type SlackOAuthConfig } from '@devflow/integrations-slack';
import type { Database } from '@devflow/database';
import type { OrgContext } from '../../access/org-context';
import { connectOrReconnect, type ConnectionRow } from './connections.service';

export interface SlackCredentials {
  botAccessToken: string;
}

/**
 * Exchanges the temporary code for a bot token, then persists the
 * connection. Unlike GitHub's App/Plane's per-connection secret, Slack's
 * signing secret is app-wide (env var) — only the bot token is per-connection.
 */
export async function completeSlackInstall(
  db: Database,
  ctx: OrgContext,
  config: SlackOAuthConfig,
  credentialsKey: Buffer,
  code: string,
  fetchImpl?: typeof globalThis.fetch,
): Promise<ConnectionRow> {
  const result = await exchangeSlackCode(config, code, fetchImpl);

  const credentials: SlackCredentials = { botAccessToken: result.botAccessToken };
  const encrypted = encryptCredentials(credentialsKey, JSON.stringify(credentials));

  return connectOrReconnect(db, ctx, {
    category: 'chat',
    provider: 'slack',
    externalAccount: {
      teamId: result.teamId,
      teamName: result.teamName,
      botUserId: result.botUserId,
    },
    encryptedCredentials: encrypted.ciphertext,
    credentialsIv: encrypted.iv,
  });
}
