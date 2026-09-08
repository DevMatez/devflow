import type { IntegrationCategory, OrganizationId } from '@devflow/types';
import type { ConnectionStatus } from './enums';

export class ConnectionNotFoundError extends Error {
  constructor(category: IntegrationCategory) {
    super(`No connection found for category "${category}"`);
  }
}

export class ConnectionRevokedError extends Error {
  constructor(category: IntegrationCategory) {
    super(`Connection for category "${category}" has been revoked`);
  }
}

export class ConnectionErrorStateError extends Error {
  constructor(category: IntegrationCategory) {
    super(`Connection for category "${category}" is in an error state`);
  }
}

export class CredentialDecryptionError extends Error {
  constructor() {
    super('Failed to decrypt connection credentials');
  }
}

export interface ConnectionRecord {
  id: string;
  organizationId: OrganizationId;
  category: IntegrationCategory;
  provider: string;
  status: ConnectionStatus;
  encryptedCredentials: string;
  credentialsIv: string;
}

export interface ProviderRegistryOptions<TCredentials> {
  /** Injected by the composition root — this package never talks to a database directly. */
  getConnection(
    category: IntegrationCategory,
    organizationId: OrganizationId,
  ): Promise<ConnectionRecord | null>;
  /** Throws (never returns garbage) on a tampered/corrupted ciphertext or wrong key. */
  decrypt(connection: ConnectionRecord): TCredentials;
  /** Constructs the adapter instance for a resolved connection + its decrypted credentials. */
  createAdapter(connection: ConnectionRecord, credentials: TCredentials): unknown;
}

export interface ProviderRegistry {
  /**
   * Resolution chain: organization + category → active connection row →
   * decrypted credentials → constructed adapter instance. See the explicit
   * outcome table in the Wave 2 design doc §3.4 for every failure mode.
   */
  resolve<T>(category: IntegrationCategory, organizationId: OrganizationId): Promise<T>;
}

export function createProviderRegistry<TCredentials>(
  options: ProviderRegistryOptions<TCredentials>,
): ProviderRegistry {
  return {
    async resolve<T>(category: IntegrationCategory, organizationId: OrganizationId): Promise<T> {
      const connection = await options.getConnection(category, organizationId);
      if (!connection) throw new ConnectionNotFoundError(category);
      if (connection.status === 'revoked') throw new ConnectionRevokedError(category);
      if (connection.status === 'error') throw new ConnectionErrorStateError(category);

      let credentials: TCredentials;
      try {
        credentials = options.decrypt(connection);
      } catch {
        throw new CredentialDecryptionError();
      }

      return options.createAdapter(connection, credentials) as T;
    },
  };
}
