import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { encryptCredentials, parseCredentialsKey } from '@devflow/integrations-core';
import { workflowConfigSchema } from '@devflow/validation';
import { buildApp } from '../../../../app';
import { env } from '../../../../config/env';
import { createUser } from '../../../../modules/identity/dal/users.dal';
import { createUserSession } from '../../../../modules/identity/service/session.service';
import { SESSION_COOKIE_NAME } from '../../../../plugins/auth';
import { createOrganization } from '../../../../modules/organizations/service/organizations.service';
import { addMember } from '../../../../modules/organizations/dal/members.dal';
import { createWorkItem } from '../../../../modules/work-items/dal/work-items.dal';
import type { OrganizationId, UserId } from '@devflow/types';

async function makeAuthedUser(app: FastifyInstance, label: string) {
  const githubId = `work-items-route-${label}-${crypto.randomUUID()}`;
  const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
  const { token } = await createUserSession(
    app.db,
    { ttlDays: 30, refreshThresholdDays: 7 },
    { userId: user.id as UserId },
  );
  return { userId: user.id as UserId, cookie: `${SESSION_COOKIE_NAME}=${app.signCookie(token)}` };
}

describe('work-items routes', () => {
  let app: FastifyInstance;
  const createdUserIds: UserId[] = [];
  const createdOrgIds: OrganizationId[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    for (const id of createdOrgIds.splice(0)) {
      await app.db.delete(schema.organizations).where(eq(schema.organizations.id, id));
    }
    for (const id of createdUserIds.splice(0)) {
      await app.db.delete(schema.users).where(eq(schema.users.id, id));
    }
    await app.close();
  });

  async function makeOrgWithProject(owner: { userId: UserId }, label: string) {
    const org = await createOrganization(app.db, {
      name: `Work Items Route Org ${label}`,
      userId: owner.userId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);

    const [project] = await app.db
      .insert(schema.projects)
      .values({
        organizationId: org.id,
        name: `Project ${label}`,
        slug: `project-${label}-${crypto.randomUUID()}`,
        workflowConfig: workflowConfigSchema.parse({}),
      })
      .returning();
    if (!project) throw new Error('failed to insert project fixture');

    return { organizationId: org.id as OrganizationId, projectId: project.id };
  }

  /** Inserts a Plane project-management connection so the default resolver can build a live adapter. */
  async function connectPlane(organizationId: OrganizationId) {
    const encrypted = encryptCredentials(
      parseCredentialsKey(env.INTEGRATION_CREDENTIALS_KEY),
      JSON.stringify({ apiToken: 'plane-token', webhookSecret: 'secret' }),
    );
    await app.db.insert(schema.integrationConnections).values({
      organizationId,
      category: 'project-management',
      provider: 'plane',
      externalAccount: { workspaceSlug: 'acme', workspaceId: 'ws-1' },
      encryptedCredentials: encrypted.ciphertext,
      credentialsIv: encrypted.iv,
    });
  }

  it('creates and binds a work item via the PM provider', async () => {
    const owner = await makeAuthedUser(app, 'create');
    createdUserIds.push(owner.userId);
    const { organizationId, projectId } = await makeOrgWithProject(owner, 'create');
    await connectPlane(organizationId);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 'plane-issue-1',
            name: 'Add login',
            project_id: 'pp1',
            sequence_id: 42,
            created_at: '2026-01-01T00:00:00.000Z',
            updated_at: '2026-01-01T00:00:00.000Z',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/projects/${projectId}/work-items`,
      headers: { cookie: owner.cookie },
      payload: { title: 'Add login', externalProjectId: 'pp1' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.externalIssueId).toBe('plane-issue-1');
    expect(body.workflowState).toBe('backlog');
  });

  it('returns 409 integration_required when no PM connection exists', async () => {
    const owner = await makeAuthedUser(app, 'no-pm');
    createdUserIds.push(owner.userId);
    const { organizationId, projectId } = await makeOrgWithProject(owner, 'no-pm');

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/projects/${projectId}/work-items`,
      headers: { cookie: owner.cookie },
      payload: { title: 'X', externalProjectId: 'pp1' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('rejects a non-member creating a work item', async () => {
    const owner = await makeAuthedUser(app, 'authz-owner');
    createdUserIds.push(owner.userId);
    const { organizationId, projectId } = await makeOrgWithProject(owner, 'authz');
    const outsider = await makeAuthedUser(app, 'authz-outsider');
    createdUserIds.push(outsider.userId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/projects/${projectId}/work-items`,
      headers: { cookie: outsider.cookie },
      payload: { title: 'X', externalProjectId: 'pp1' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a viewer creating a work item but allows the list', async () => {
    const owner = await makeAuthedUser(app, 'viewer-owner');
    createdUserIds.push(owner.userId);
    const { organizationId, projectId } = await makeOrgWithProject(owner, 'viewer');
    const viewer = await makeAuthedUser(app, 'viewer');
    createdUserIds.push(viewer.userId);
    await app.db.transaction((tx) =>
      addMember(tx, {
        organizationId,
        userId: viewer.userId,
        role: 'viewer',
      }),
    );

    const create = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/projects/${projectId}/work-items`,
      headers: { cookie: viewer.cookie },
      payload: { title: 'X', externalProjectId: 'pp1' },
    });
    expect(create.statusCode).toBe(403);

    const list = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/projects/${projectId}/work-items`,
      headers: { cookie: viewer.cookie },
    });
    expect(list.statusCode).toBe(200);
  });

  it('lists, filters, and fetches a work item; hides other orgs', async () => {
    const owner = await makeAuthedUser(app, 'list');
    createdUserIds.push(owner.userId);
    const { organizationId, projectId } = await makeOrgWithProject(owner, 'list');
    const other = await makeOrgWithProject(owner, 'list-other');

    const backlog = await createWorkItem(app.db, {
      organizationId,
      projectId,
      title: 'Backlog',
      externalProvider: 'plane',
      externalIssueId: 'issue-b',
    });
    await createWorkItem(app.db, {
      organizationId,
      projectId,
      title: 'Active',
      externalProvider: 'plane',
      externalIssueId: 'issue-a',
      workflowState: 'in_progress',
    });

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/projects/${projectId}/work-items?workflowState=in_progress`,
      headers: { cookie: owner.cookie },
    });
    expect(filtered.json().workItems).toHaveLength(1);
    expect(filtered.json().workItems[0].workflowState).toBe('in_progress');

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/work-items/${backlog.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().id).toBe(backlog.id);

    const crossOrg = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${other.organizationId}/work-items/${backlog.id}`,
      headers: { cookie: owner.cookie },
    });
    expect(crossOrg.statusCode).toBe(404);
  });

  it('applies a transition and rejects an illegal one', async () => {
    const owner = await makeAuthedUser(app, 'transition');
    createdUserIds.push(owner.userId);
    const { organizationId, projectId } = await makeOrgWithProject(owner, 'transition');
    const item = await createWorkItem(app.db, {
      organizationId,
      projectId,
      title: 'Move',
      externalProvider: 'plane',
      externalIssueId: 'issue-move',
      workflowState: 'todo',
    });

    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/work-items/${item.id}/transition`,
      headers: { cookie: owner.cookie },
      payload: { action: 'advance', to: 'in_progress' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().workflowState).toBe('in_progress');

    const illegal = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/work-items/${item.id}/transition`,
      headers: { cookie: owner.cookie },
      payload: { action: 'advance', to: 'backlog' },
    });
    expect(illegal.statusCode).toBe(409);

    const badBody = await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${organizationId}/work-items/${item.id}/transition`,
      headers: { cookie: owner.cookie },
      payload: { action: 'advance' },
    });
    expect(badBody.statusCode).toBe(400);
  });
});
