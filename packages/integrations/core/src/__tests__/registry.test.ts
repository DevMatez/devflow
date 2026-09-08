import { describe, expect, it, vi } from 'vitest';
import type { OrganizationId } from '@devflow/types';
import {
  ConnectionErrorStateError,
  ConnectionNotFoundError,
  ConnectionRevokedError,
  CredentialDecryptionError,
  createProviderRegistry,
  type ConnectionRecord,
} from '../registry';

const organizationId = 'org-1' as OrganizationId;

function makeConnection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: 'conn-1',
    organizationId,
    category: 'source-control',
    provider: 'github',
    status: 'connected',
    encryptedCredentials: 'ciphertext',
    credentialsIv: 'iv',
    ...overrides,
  };
}

describe('provider registry', () => {
  it('resolves an adapter for a connected connection', async () => {
    const connection = makeConnection();
    const adapter = { name: 'fake-adapter' };
    const createAdapter = vi.fn().mockReturnValue(adapter);

    const registry = createProviderRegistry({
      getConnection: async () => connection,
      decrypt: () => ({ token: 'decrypted' }),
      createAdapter,
    });

    const resolved = await registry.resolve('source-control', organizationId);

    expect(resolved).toBe(adapter);
    expect(createAdapter).toHaveBeenCalledWith(connection, { token: 'decrypted' });
  });

  it('throws ConnectionNotFoundError when no connection exists', async () => {
    const registry = createProviderRegistry({
      getConnection: async () => null,
      decrypt: () => ({}),
      createAdapter: () => ({}),
    });

    await expect(registry.resolve('source-control', organizationId)).rejects.toThrow(
      ConnectionNotFoundError,
    );
  });

  it('throws ConnectionRevokedError for a revoked connection', async () => {
    const registry = createProviderRegistry({
      getConnection: async () => makeConnection({ status: 'revoked' }),
      decrypt: () => ({}),
      createAdapter: () => ({}),
    });

    await expect(registry.resolve('source-control', organizationId)).rejects.toThrow(
      ConnectionRevokedError,
    );
  });

  it('throws ConnectionErrorStateError for a connection in error state', async () => {
    const registry = createProviderRegistry({
      getConnection: async () => makeConnection({ status: 'error' }),
      decrypt: () => ({}),
      createAdapter: () => ({}),
    });

    await expect(registry.resolve('source-control', organizationId)).rejects.toThrow(
      ConnectionErrorStateError,
    );
  });

  it('throws CredentialDecryptionError when decryption fails, without exposing the underlying cause', async () => {
    const registry = createProviderRegistry({
      getConnection: async () => makeConnection(),
      decrypt: () => {
        throw new Error('bad auth tag');
      },
      createAdapter: () => ({}),
    });

    await expect(registry.resolve('source-control', organizationId)).rejects.toThrow(
      CredentialDecryptionError,
    );
  });
});
