import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { workflowConfigSchema } from '@devflow/validation';
import { buildApp } from '../../../app';
import { createUser } from '../../identity/dal/users.dal';
import { createOrganization } from '../../organizations/service/organizations.service';
import { createWorkItem } from '../../work-items/dal/work-items.dal';
import { insertActivity, listActivity } from '../dal/activity.dal';
import type { OrganizationId, UserId } from '@devflow/types';

describe('activity DAL', () => {
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

  async function makeWorkItem(label: string) {
    const githubId = `activity-dal-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);
    const org = await createOrganization(app.db, {
      name: `Activity Org ${label}`,
      userId: user.id as UserId,
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
    return { organizationId: org.id, workItemId: item.id };
  }

  it('is idempotent on source_event_id (ON CONFLICT DO NOTHING)', async () => {
    const { organizationId, workItemId } = await makeWorkItem('idem');
    const sourceEventId = crypto.randomUUID();
    const base = {
      organizationId,
      workItemId,
      actorType: 'user',
      action: 'workitem.created',
      summary: 'Work item created',
      correlationId: crypto.randomUUID(),
      sourceEventId,
      occurredAt: new Date(),
    };

    await insertActivity(app.db, base);
    await insertActivity(app.db, { ...base, summary: 'DIFFERENT (should be ignored)' });

    const rows = await listActivity(app.db, organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.summary).toBe('Work item created');
  });

  it('lists org-scoped, filters by work item, and paginates newest-first', async () => {
    const { organizationId, workItemId } = await makeWorkItem('list');

    for (let i = 0; i < 3; i++) {
      await insertActivity(app.db, {
        organizationId,
        workItemId,
        actorType: 'system',
        action: 'x',
        summary: `line ${i}`,
        correlationId: crypto.randomUUID(),
        sourceEventId: crypto.randomUUID(),
        occurredAt: new Date(Date.now() + i * 1000),
      });
    }
    // one org-level row not tied to a work item
    await insertActivity(app.db, {
      organizationId,
      workItemId: null,
      actorType: 'external',
      action: 'reconciliation.anomaly',
      summary: 'orphan',
      correlationId: crypto.randomUUID(),
      sourceEventId: crypto.randomUUID(),
      occurredAt: new Date(Date.now() + 5000),
    });

    const all = await listActivity(app.db, organizationId);
    expect(all).toHaveLength(4);
    expect(all[0]!.summary).toBe('orphan'); // newest first

    const itemOnly = await listActivity(app.db, organizationId, { workItemId });
    expect(itemOnly).toHaveLength(3);

    const paged = await listActivity(app.db, organizationId, { limit: 2 });
    expect(paged).toHaveLength(2);
  });
});
