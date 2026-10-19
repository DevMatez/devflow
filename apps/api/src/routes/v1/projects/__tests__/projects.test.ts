import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { and, eq } from 'drizzle-orm';
import type { OrganizationId, UserId } from '@devflow/types';
import { buildApp } from '../../../../app';
import { createUser } from '../../../../modules/identity/dal/users.dal';
import { createUserSession } from '../../../../modules/identity/service/session.service';
import { SESSION_COOKIE_NAME } from '../../../../plugins/auth';
import { createOrganization } from '../../../../modules/organizations/service/organizations.service';
import { addMember } from '../../../../modules/organizations/dal/members.dal';

describe('projects routes', () => {
  let app: FastifyInstance;
  const createdUserIds: UserId[] = [];
  const createdOrgIds: OrganizationId[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
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

  async function user(label: string) {
    const githubId = `projects-route-${label}-${crypto.randomUUID()}`;
    const u = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(u.id as UserId);
    const { token } = await createUserSession(
      app.db,
      { ttlDays: 30, refreshThresholdDays: 7 },
      { userId: u.id as UserId },
    );
    return { id: u.id as UserId, cookie: `${SESSION_COOKIE_NAME}=${app.signCookie(token)}` };
  }

  async function org(owner: { id: UserId }, label: string) {
    const o = await createOrganization(app.db, {
      name: `Projects Org ${label}`,
      userId: owner.id,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(o.id as OrganizationId);
    return o.id as OrganizationId;
  }

  const base = (orgId: string) => `/api/v1/organizations/${orgId}/projects`;

  it('admin creates a project with a derived slug and default workflow config, emitting project.created', async () => {
    const owner = await user('create');
    const orgId = await org(owner, 'create');

    const res = await app.inject({
      method: 'POST',
      url: base(orgId),
      headers: { cookie: owner.cookie },
      payload: { name: 'Acme Engineering', key: 'ENG' },
    });

    expect(res.statusCode).toBe(201);
    const project = res.json();
    expect(project).toMatchObject({
      name: 'Acme Engineering',
      slug: 'acme-engineering',
      key: 'ENG',
      workflowConfig: {
        version: 1,
        branchNamingPattern: '{type}/{ticketKey}-{slug}',
        reviewPolicy: { requiredApprovals: 1, requireAiReview: true },
      },
    });
    const events = await app.db.query.outboxEvents.findMany({
      where: and(
        eq(schema.outboxEvents.aggregateId, project.id),
        eq(schema.outboxEvents.type, 'project.created'),
      ),
    });
    expect(events).toHaveLength(1);
  });

  it('rejects a non-canonical slug (400) and a duplicate slug (409)', async () => {
    const owner = await user('slug');
    const orgId = await org(owner, 'slug');
    const create = (payload: object) =>
      app.inject({ method: 'POST', url: base(orgId), headers: { cookie: owner.cookie }, payload });

    expect((await create({ name: 'X', slug: 'Not Canonical' })).statusCode).toBe(400);
    expect((await create({ name: 'Web', slug: 'web' })).statusCode).toBe(201);
    expect((await create({ name: 'Web again', slug: 'web' })).statusCode).toBe(409);
  });

  it('lists and gets projects for any member; only admin+ may create or edit', async () => {
    const owner = await user('rbac-owner');
    const dev = await user('rbac-dev');
    const orgId = await org(owner, 'rbac');
    await app.db.transaction((tx) =>
      addMember(tx, { organizationId: orgId, userId: dev.id, role: 'developer' }),
    );

    const created = await app.inject({
      method: 'POST',
      url: base(orgId),
      headers: { cookie: owner.cookie },
      payload: { name: 'Mobile' },
    });
    const projectId = created.json().id;

    const list = await app.inject({
      method: 'GET',
      url: base(orgId),
      headers: { cookie: dev.cookie },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().projects.map((p: { id: string }) => p.id)).toEqual([projectId]);

    const get = await app.inject({
      method: 'GET',
      url: `${base(orgId)}/${projectId}`,
      headers: { cookie: dev.cookie },
    });
    expect(get.statusCode).toBe(200);

    const devCreate = await app.inject({
      method: 'POST',
      url: base(orgId),
      headers: { cookie: dev.cookie },
      payload: { name: 'Nope' },
    });
    expect(devCreate.statusCode).toBe(403);

    const devPatch = await app.inject({
      method: 'PATCH',
      url: `${base(orgId)}/${projectId}`,
      headers: { cookie: dev.cookie },
      payload: { name: 'Nope' },
    });
    expect(devPatch.statusCode).toBe(403);
  });

  it('PATCH merges a partial workflow config, can clear the Slack channel, and emits the update event', async () => {
    const owner = await user('patch');
    const orgId = await org(owner, 'patch');
    const created = await app.inject({
      method: 'POST',
      url: base(orgId),
      headers: { cookie: owner.cookie },
      payload: { name: 'API', workflowConfig: { notificationChannelId: 'C123' } },
    });
    const projectId = created.json().id;
    const url = `${base(orgId)}/${projectId}`;

    const patched = await app.inject({
      method: 'PATCH',
      url,
      headers: { cookie: owner.cookie },
      payload: { name: 'Public API', workflowConfig: { reviewPolicy: { requiredApprovals: 2 } } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      name: 'Public API',
      slug: 'api',
      workflowConfig: {
        notificationChannelId: 'C123',
        reviewPolicy: { requiredApprovals: 2, requireAiReview: true },
      },
    });

    const cleared = await app.inject({
      method: 'PATCH',
      url,
      headers: { cookie: owner.cookie },
      payload: { workflowConfig: { notificationChannelId: null } },
    });
    expect(cleared.json().workflowConfig.notificationChannelId).toBeUndefined();

    const events = await app.db.query.outboxEvents.findMany({
      where: and(
        eq(schema.outboxEvents.aggregateId, projectId),
        eq(schema.outboxEvents.type, 'project.workflow_config_updated'),
      ),
    });
    expect(events).toHaveLength(2);
  });

  it('a project in another org is not found', async () => {
    const a = await user('iso-a');
    const b = await user('iso-b');
    const orgA = await org(a, 'iso-a');
    const orgB = await org(b, 'iso-b');
    const created = await app.inject({
      method: 'POST',
      url: base(orgA),
      headers: { cookie: a.cookie },
      payload: { name: 'Secret' },
    });

    const res = await app.inject({
      method: 'GET',
      url: `${base(orgB)}/${created.json().id}`,
      headers: { cookie: b.cookie },
    });
    expect(res.statusCode).toBe(404);
  });
});
