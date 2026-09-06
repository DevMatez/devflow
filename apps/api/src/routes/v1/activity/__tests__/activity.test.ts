import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { workflowConfigSchema } from '@devflow/validation';
import { buildApp } from '../../../../app';
import { createUser } from '../../../../modules/identity/dal/users.dal';
import { createUserSession } from '../../../../modules/identity/service/session.service';
import { SESSION_COOKIE_NAME } from '../../../../plugins/auth';
import { createOrganization } from '../../../../modules/organizations/service/organizations.service';
import { createWorkItem } from '../../../../modules/work-items/dal/work-items.dal';
import { insertActivity } from '../../../../modules/activity/dal/activity.dal';
import type { OrganizationId, UserId } from '@devflow/types';

async function makeAuthedUser(app: FastifyInstance, label: string) {
  const githubId = `activity-route-${label}-${crypto.randomUUID()}`;
  const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
  const { token } = await createUserSession(
    app.db,
    { ttlDays: 30, refreshThresholdDays: 7 },
    { userId: user.id as UserId },
  );
  return { userId: user.id as UserId, cookie: `${SESSION_COOKIE_NAME}=${app.signCookie(token)}` };
}

describe('activity routes', () => {
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

  async function seed(owner: { userId: UserId }, label: string) {
    const org = await createOrganization(app.db, {
      name: `Activity Route Org ${label}`,
      userId: owner.userId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    const [project] = await app.db
      .insert(schema.projects)
      .values({
        organizationId: org.id,
        name: `P ${label}`,
        slug: `p-${label}-${crypto.randomUUID()}`,
        workflowConfig: workflowConfigSchema.parse({}),
      })
      .returning();
    const item = await createWorkItem(app.db, {
      organizationId: org.id,
      projectId: project!.id,
      title: 'WI',
      externalProvider: 'plane',
      externalIssueId: `issue-${crypto.randomUUID()}`,
    });
    await insertActivity(app.db, {
      organizationId: org.id,
      workItemId: item.id,
      actorType: 'user',
      action: 'workitem.created',
      summary: 'Work item created',
      correlationId: crypto.randomUUID(),
      sourceEventId: crypto.randomUUID(),
      occurredAt: new Date(),
    });
    return { organizationId: org.id as OrganizationId, workItemId: item.id };
  }

  it('returns the org feed and the per-work-item feed', async () => {
    const owner = await makeAuthedUser(app, 'feed');
    createdUserIds.push(owner.userId);
    const { organizationId, workItemId } = await seed(owner, 'feed');

    const orgFeed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/activity`,
      headers: { cookie: owner.cookie },
    });
    expect(orgFeed.statusCode).toBe(200);
    expect(orgFeed.json().activity).toHaveLength(1);
    expect(orgFeed.json().activity[0].summary).toBe('Work item created');

    const itemFeed = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/work-items/${workItemId}/activity`,
      headers: { cookie: owner.cookie },
    });
    expect(itemFeed.statusCode).toBe(200);
    expect(itemFeed.json().activity).toHaveLength(1);
  });

  it('rejects a non-member', async () => {
    const owner = await makeAuthedUser(app, 'authz-owner');
    createdUserIds.push(owner.userId);
    const { organizationId } = await seed(owner, 'authz');
    const outsider = await makeAuthedUser(app, 'authz-outsider');
    createdUserIds.push(outsider.userId);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${organizationId}/activity`,
      headers: { cookie: outsider.cookie },
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not leak another org feed', async () => {
    const owner = await makeAuthedUser(app, 'iso');
    createdUserIds.push(owner.userId);
    const a = await seed(owner, 'iso-a');
    const b = await seed(owner, 'iso-b');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/organizations/${b.organizationId}/activity`,
      headers: { cookie: owner.cookie },
    });
    expect(res.statusCode).toBe(200);
    // b's feed is only b's single row, never a's.
    expect(res.json().activity).toHaveLength(1);
    void a;
  });
});
