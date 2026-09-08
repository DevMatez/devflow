import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { and, eq } from 'drizzle-orm';
import { workflowConfigSchema } from '@devflow/validation';
import type { NormalizedIssueEvent } from '@devflow/integrations-core';
import { buildApp } from '../../../app';
import { createUser } from '../../identity/dal/users.dal';
import { createOrganization } from '../../organizations/service/organizations.service';
import {
  createWorkItem,
  findWorkItemById,
  findWorkItemByExternalIssue,
  setPrRef,
  updateWorkItemMirror,
  type WorkItemRow,
} from '../../work-items/dal/work-items.dal';
import { reconcileIssueEvent } from '../service/reconcile-issue.service';
import type { OrganizationId, UserId } from '@devflow/types';

function issueEvent(overrides: Partial<NormalizedIssueEvent> = {}): NormalizedIssueEvent {
  return {
    externalId: 'plane-issue-1',
    key: null,
    title: 'Reconciled title',
    statusClass: 'open',
    assigneeExternalId: null,
    projectExternalId: 'plane-proj-1',
    url: null,
    updatedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('reconcile-issue service', () => {
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

  async function makeOrg(
    label: string,
  ): Promise<{ organizationId: OrganizationId; projectId: string }> {
    const githubId = `reconcile-issue-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);
    const org = await createOrganization(app.db, {
      name: `Reconcile Org ${label}`,
      userId: user.id as UserId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    const projectId = await addProject(org.id, label);
    return { organizationId: org.id as OrganizationId, projectId };
  }

  async function addProject(organizationId: string, label: string): Promise<string> {
    const [project] = await app.db
      .insert(schema.projects)
      .values({
        organizationId,
        name: `P ${label}`,
        slug: `p-${label}-${crypto.randomUUID()}`,
        workflowConfig: workflowConfigSchema.parse({}),
      })
      .returning();
    return project!.id;
  }

  function makeItem(
    organizationId: string,
    projectId: string,
    externalIssueId: string,
    workflowState: WorkItemRow['workflowState'] = 'in_progress',
  ) {
    return createWorkItem(app.db, {
      organizationId,
      projectId,
      title: 'Old title',
      externalProvider: 'plane',
      externalIssueId,
      workflowState,
    });
  }

  function outbox(aggregateId: string, type: string) {
    return app.db.query.outboxEvents.findMany({
      where: and(
        eq(schema.outboxEvents.aggregateId, aggregateId),
        eq(schema.outboxEvents.type, type),
      ),
    });
  }

  it('binds an externally-authored issue when the org has one project', async () => {
    const { organizationId } = await makeOrg('bind');
    await reconcileIssueEvent(
      app.db,
      organizationId,
      issueEvent({ externalId: 'ext-bind' }),
      true,
      crypto.randomUUID(),
    );

    const bound = await findWorkItemByExternalIssue(app.db, organizationId, 'plane', 'ext-bind');
    expect(bound?.title).toBe('Reconciled title');
    expect(bound?.lastExternalVersion).toBe('2026-03-01T00:00:00.000Z');
    expect(await outbox(bound!.id, 'workitem.created')).toHaveLength(1);
  });

  it('does not bind when the org has multiple projects (no mapping)', async () => {
    const { organizationId } = await makeOrg('bind-multi');
    await addProject(organizationId, 'second');
    await reconcileIssueEvent(
      app.db,
      organizationId,
      issueEvent({ externalId: 'ext-multi' }),
      true,
      crypto.randomUUID(),
    );
    expect(
      await findWorkItemByExternalIssue(app.db, organizationId, 'plane', 'ext-multi'),
    ).toBeUndefined();
  });

  it('updates mirror columns + cursor on an existing item without a state jump', async () => {
    const { organizationId, projectId } = await makeOrg('mirror');
    const item = await makeItem(organizationId, projectId, 'ext-mirror', 'in_progress');
    await reconcileIssueEvent(
      app.db,
      organizationId,
      issueEvent({ externalId: 'ext-mirror', title: 'New title', assigneeExternalId: 'user-7' }),
      false,
      crypto.randomUUID(),
    );

    const after = await findWorkItemById(app.db, organizationId, item.id);
    expect(after?.title).toBe('New title');
    expect(after?.externalAssigneeId).toBe('user-7');
    expect(after?.workflowState).toBe('in_progress');
    expect(await outbox(item.id, 'workitem.state_changed')).toHaveLength(0);
  });

  it('completes to DONE and flags an anomaly when a PR is still open', async () => {
    const { organizationId, projectId } = await makeOrg('complete');
    const item = await makeItem(organizationId, projectId, 'ext-complete', 'in_review');
    await setPrRef(app.db, organizationId, item.id, { repo: 'a/b', number: 1, state: 'open' });

    await reconcileIssueEvent(
      app.db,
      organizationId,
      issueEvent({
        externalId: 'ext-complete',
        statusClass: 'completed',
        updatedAt: '2026-04-01T00:00:00.000Z',
      }),
      false,
      crypto.randomUUID(),
    );

    const after = await findWorkItemById(app.db, organizationId, item.id);
    expect(after?.workflowState).toBe('done');
    const reconciled = await outbox(item.id, 'workitem.reconciled');
    expect(reconciled).toHaveLength(1);
    expect((reconciled[0]!.payload as { anomaly: boolean }).anomaly).toBe(true);
  });

  it('reopens out of DONE on an open status, recorded as an anomaly', async () => {
    const { organizationId, projectId } = await makeOrg('reopen');
    const item = await makeItem(organizationId, projectId, 'ext-reopen', 'done');

    await reconcileIssueEvent(
      app.db,
      organizationId,
      issueEvent({
        externalId: 'ext-reopen',
        statusClass: 'open',
        updatedAt: '2026-05-01T00:00:00.000Z',
      }),
      false,
      crypto.randomUUID(),
    );

    const after = await findWorkItemById(app.db, organizationId, item.id);
    expect(after?.workflowState).toBe('todo'); // no branch → todo
    expect(await outbox(item.id, 'workitem.state_changed')).toHaveLength(1);
  });

  it('does not un-finish a terminal item on a provably-older event', async () => {
    const { organizationId, projectId } = await makeOrg('stale');
    const item = await makeItem(organizationId, projectId, 'ext-stale', 'done');
    await updateWorkItemMirror(app.db, organizationId, item.id, {
      lastExternalVersion: '2026-06-01T00:00:00.000Z',
    });

    await reconcileIssueEvent(
      app.db,
      organizationId,
      issueEvent({
        externalId: 'ext-stale',
        statusClass: 'open',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      false,
      crypto.randomUUID(),
    );

    const after = await findWorkItemById(app.db, organizationId, item.id);
    expect(after?.workflowState).toBe('done'); // stale reopen ignored
    const reconciled = await outbox(item.id, 'workitem.reconciled');
    expect((reconciled.at(-1)!.payload as { anomaly: boolean }).anomaly).toBe(true);
  });

  it('is idempotent: re-delivering the same completed event does not re-transition', async () => {
    const { organizationId, projectId } = await makeOrg('idem');
    const item = await makeItem(organizationId, projectId, 'ext-idem', 'in_progress');
    const event = issueEvent({
      externalId: 'ext-idem',
      statusClass: 'completed',
      updatedAt: '2026-04-01T00:00:00.000Z',
    });

    await reconcileIssueEvent(app.db, organizationId, event, false, crypto.randomUUID());
    await reconcileIssueEvent(app.db, organizationId, event, false, crypto.randomUUID());

    const after = await findWorkItemById(app.db, organizationId, item.id);
    expect(after?.workflowState).toBe('done');
    // Only the first delivery transitions (done→done on replay is a no-op).
    expect(await outbox(item.id, 'workitem.state_changed')).toHaveLength(1);
  });
});
