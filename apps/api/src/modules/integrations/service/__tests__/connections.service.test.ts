import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import { createOrganization } from '../../../organizations/service/organizations.service';
import {
  connect,
  disconnect,
  getConnection,
  listConnections,
  recordConnectionHealth,
  ConnectionNotFoundError,
} from '../connections.service';
import type { OrgContext } from '../../../access/org-context';
import type { OrganizationId, UserId } from '@devflow/types';

describe('connections service', () => {
  let app: FastifyInstance;
  const createdUserIds: UserId[] = [];
  const createdOrgIds: OrganizationId[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    for (const id of createdOrgIds.splice(0)) {
      await app.db.delete(schema.organizations).where(eq(schema.organizations.id, id));
    }
  });

  afterAll(async () => {
    for (const id of createdUserIds.splice(0)) {
      await app.db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await app.close();
  });

  async function makeOrgContext(label: string): Promise<OrgContext> {
    const githubId = `connections-test-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);

    const org = await createOrganization(app.db, {
      name: `Connections Org ${label}`,
      userId: user.id as UserId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);

    return { organizationId: org.id as OrganizationId, userId: user.id as UserId, role: 'owner' };
  }

  it('connects, lists, and reads a single connection', async () => {
    const ctx = await makeOrgContext('connect-list');

    const created = await connect(app.db, ctx, {
      category: 'source-control',
      provider: 'github',
      externalAccount: { login: 'acme-org' },
      encryptedCredentials: 'ciphertext',
      credentialsIv: 'iv',
    });
    expect(created.status).toBe('connected');
    expect(created.provider).toBe('github');

    const list = await listConnections(app.db, ctx);
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(created.id);

    const found = await getConnection(app.db, ctx, 'source-control');
    expect(found?.id).toBe(created.id);

    const missing = await getConnection(app.db, ctx, 'chat');
    expect(missing).toBeUndefined();
  });

  it('enforces one connection per (organization, category)', async () => {
    const ctx = await makeOrgContext('unique');
    await connect(app.db, ctx, {
      category: 'chat',
      provider: 'slack',
      externalAccount: { teamName: 'Acme' },
      encryptedCredentials: 'ciphertext',
      credentialsIv: 'iv',
    });

    await expect(
      connect(app.db, ctx, {
        category: 'chat',
        provider: 'slack',
        externalAccount: { teamName: 'Acme Again' },
        encryptedCredentials: 'ciphertext-2',
        credentialsIv: 'iv-2',
      }),
    ).rejects.toThrow();
  });

  it('records connection health without touching credentials', async () => {
    const ctx = await makeOrgContext('health');
    const created = await connect(app.db, ctx, {
      category: 'project-management',
      provider: 'plane',
      externalAccount: { workspaceSlug: 'acme' },
      encryptedCredentials: 'ciphertext',
      credentialsIv: 'iv',
    });

    await recordConnectionHealth(app.db, ctx.organizationId, 'project-management', {
      status: 'error',
      lastFailureAt: new Date(),
      lastError: 'token expired',
    });

    const updated = await getConnection(app.db, ctx, 'project-management');
    expect(updated?.status).toBe('error');
    expect(updated?.lastError).toBe('token expired');
    expect(updated?.encryptedCredentials).toBe(created.encryptedCredentials);
  });

  it('throws ConnectionNotFoundError recording health for a missing connection', async () => {
    const ctx = await makeOrgContext('health-missing');
    await expect(
      recordConnectionHealth(app.db, ctx.organizationId, 'calendar', { status: 'error' }),
    ).rejects.toThrow(ConnectionNotFoundError);
  });

  it('disconnects by revoking status and wiping credentials', async () => {
    const ctx = await makeOrgContext('disconnect');
    await connect(app.db, ctx, {
      category: 'calendar',
      provider: 'google',
      externalAccount: { email: '[email protected]' },
      encryptedCredentials: 'ciphertext',
      credentialsIv: 'iv',
    });

    await disconnect(app.db, ctx, 'calendar');

    const found = await getConnection(app.db, ctx, 'calendar');
    expect(found?.status).toBe('revoked');
    expect(found?.encryptedCredentials).toBe('');
    expect(found?.credentialsIv).toBe('');
  });

  it('throws ConnectionNotFoundError disconnecting a missing connection', async () => {
    const ctx = await makeOrgContext('disconnect-missing');
    await expect(disconnect(app.db, ctx, 'source-control')).rejects.toThrow(
      ConnectionNotFoundError,
    );
  });
});
