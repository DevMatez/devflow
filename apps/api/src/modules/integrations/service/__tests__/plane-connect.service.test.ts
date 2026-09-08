import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import { createOrganization } from '../../../organizations/service/organizations.service';
import { getConnection } from '../connections.service';
import { connectPlaneWorkspace, getPlaneWebhookSecretForWorkspace } from '../plane-connect.service';
import type { OrgContext } from '../../../access/org-context';
import type { OrganizationId, UserId } from '@devflow/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('plane-connect service', () => {
  let app: FastifyInstance;
  const credentialsKey = randomBytes(32);
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
    const githubId = `plane-connect-test-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);

    const org = await createOrganization(app.db, {
      name: `Plane Connect Org ${label}`,
      userId: user.id as UserId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);

    return { organizationId: org.id as OrganizationId, userId: user.id as UserId, role: 'owner' };
  }

  it('validates the token against the workspace and stores the connection', async () => {
    const ctx = await makeOrgContext('connect');
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 'workspace-uuid-1', slug: 'acme', name: 'Acme' }));

    const row = await connectPlaneWorkspace(app.db, ctx, credentialsKey, {
      workspaceSlug: 'acme',
      apiToken: 'plane_api_test-token',
      webhookSecret: 'plane_wh_test-secret',
      fetch: fetchImpl,
    });

    expect(row.provider).toBe('plane');
    expect(row.externalAccount).toEqual({ workspaceSlug: 'acme', workspaceId: 'workspace-uuid-1' });
    expect(row.encryptedCredentials).not.toBe('plane_api_test-token');

    const found = await getConnection(app.db, ctx, 'project-management');
    expect(found?.id).toBe(row.id);
  });

  it('resolves the webhook secret for a connected workspace, and null otherwise', async () => {
    const ctx = await makeOrgContext('secret-lookup');
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ id: 'workspace-uuid-2', slug: 'acme2', name: 'Acme 2' }));

    await connectPlaneWorkspace(app.db, ctx, credentialsKey, {
      workspaceSlug: 'acme2',
      apiToken: 'plane_api_test-token-2',
      webhookSecret: 'plane_wh_test-secret-2',
      fetch: fetchImpl,
    });

    const secret = await getPlaneWebhookSecretForWorkspace(
      app.db,
      credentialsKey,
      'workspace-uuid-2',
    );
    expect(secret).toBe('plane_wh_test-secret-2');

    const missing = await getPlaneWebhookSecretForWorkspace(
      app.db,
      credentialsKey,
      'no-such-workspace',
    );
    expect(missing).toBeNull();
  });

  it('reconnects (refreshes credentials) instead of erroring on a second connect for the same org', async () => {
    const ctx = await makeOrgContext('reconnect');
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () =>
        jsonResponse({ id: 'workspace-uuid-3', slug: 'acme3', name: 'Acme 3' }),
      );

    await connectPlaneWorkspace(app.db, ctx, credentialsKey, {
      workspaceSlug: 'acme3',
      apiToken: 'plane_api_first',
      webhookSecret: 'plane_wh_first',
      fetch: fetchImpl,
    });

    await connectPlaneWorkspace(app.db, ctx, credentialsKey, {
      workspaceSlug: 'acme3',
      apiToken: 'plane_api_second',
      webhookSecret: 'plane_wh_second',
      fetch: fetchImpl,
    });

    const secret = await getPlaneWebhookSecretForWorkspace(
      app.db,
      credentialsKey,
      'workspace-uuid-3',
    );
    expect(secret).toBe('plane_wh_second');
  });
});
