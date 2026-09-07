import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { and, eq } from 'drizzle-orm';
import { workflowConfigSchema } from '@devflow/validation';
import type { PullRequest } from '@devflow/integrations-core';
import { buildApp } from '../../../app';
import { createUser } from '../../identity/dal/users.dal';
import { createOrganization } from '../../organizations/service/organizations.service';
import {
  createWorkItem,
  findWorkItemById,
  setBranchRef,
  setPrRef,
  type WorkItemRow,
} from '../../work-items/dal/work-items.dal';
import { reconcilePrEvent, type PrEventKind } from '../service/reconcile-pr.service';
import type { OrganizationId, UserId } from '@devflow/types';

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    externalId: 'gh-pr-1',
    repo: 'acme/widgets',
    number: 7,
    title: 'Add feature',
    state: 'open',
    url: 'https://github.com/acme/widgets/pull/7',
    headRef: 'feature/PROJ-1-x',
    baseRef: 'main',
    authorExternalId: '42',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('reconcile-pr service', () => {
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
    const githubId = `reconcile-pr-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);
    const org = await createOrganization(app.db, {
      name: `Reconcile PR Org ${label}`,
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
    return { organizationId: org.id as OrganizationId, projectId: project!.id };
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
      title: 'x',
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

  async function reconcile(organizationId: string, kind: PrEventKind, event: PullRequest) {
    await reconcilePrEvent(app.db, organizationId, kind, event, crypto.randomUUID());
  }

  it('matches by head branch on the first opened, sets pr_ref, advances to in_review', async () => {
    const { organizationId, projectId } = await makeOrg('branch-match');
    const item = await makeItem(organizationId, projectId, 'issue-branch-match');
    await setBranchRef(app.db, organizationId, item.id, {
      repo: 'acme/widgets',
      name: 'feature/PROJ-1-x',
      base: 'main',
      status: 'active',
    });

    await reconcile(organizationId, 'opened', pr());

    const after = await findWorkItemById(app.db, organizationId, item.id);
    expect(after?.prRef).toMatchObject({ repo: 'acme/widgets', number: 7, state: 'open' });
    expect(after?.workflowState).toBe('in_review');
    expect(await outbox(item.id, 'workitem.reconciled')).toHaveLength(1);
  });

  it('matches by pr_ref once set, without needing the branch anymore', async () => {
    const { organizationId, projectId } = await makeOrg('pr-ref-match');
    const item = await makeItem(organizationId, projectId, 'issue-pr-ref', 'in_review');
    await setPrRef(app.db, organizationId, item.id, {
      repo: 'acme/widgets',
      number: 7,
      state: 'open',
    });

    await reconcile(organizationId, 'merged', pr({ state: 'merged' }));

    const after = await findWorkItemById(app.db, organizationId, item.id);
    expect(after?.workflowState).toBe('done');
    expect(after?.prRef?.state).toBe('merged');
  });

  it('records an anomaly with a null work item for an unmatched PR', async () => {
    const { organizationId } = await makeOrg('unmatched');
    await reconcile(organizationId, 'opened', pr({ externalId: 'gh-pr-orphan' }));

    const reconciled = await app.db.query.outboxEvents.findMany({
      where: and(
        eq(schema.outboxEvents.organizationId, organizationId),
        eq(schema.outboxEvents.type, 'workitem.reconciled'),
      ),
    });
    expect(reconciled).toHaveLength(1);
    const payload = reconciled[0]!.payload as { workItemId: string | null; anomaly: boolean };
    expect(payload.workItemId).toBeNull();
    expect(payload.anomaly).toBe(true);
  });

  it('closes unmerged: stays in_progress, records an anomaly', async () => {
    const { organizationId, projectId } = await makeOrg('closed-unmerged');
    const item = await makeItem(organizationId, projectId, 'issue-closed', 'in_progress');
    await setPrRef(app.db, organizationId, item.id, {
      repo: 'acme/widgets',
      number: 7,
      state: 'open',
    });

    await reconcile(organizationId, 'closed', pr({ state: 'closed' }));

    const after = await findWorkItemById(app.db, organizationId, item.id);
    expect(after?.workflowState).toBe('in_progress');
    const reconciled = await outbox(item.id, 'workitem.reconciled');
    expect((reconciled.at(-1)!.payload as { anomaly: boolean }).anomaly).toBe(true);
  });

  it('reopens out of DONE via an "updated" event, recorded as an anomaly', async () => {
    const { organizationId, projectId } = await makeOrg('reopen');
    const item = await makeItem(organizationId, projectId, 'issue-reopen', 'done');
    // Realistic setup: GitHub can only reopen a closed-unmerged PR, never a merged one.
    await setPrRef(app.db, organizationId, item.id, {
      repo: 'acme/widgets',
      number: 7,
      state: 'closed',
    });

    await reconcile(organizationId, 'updated', pr({ state: 'open' }));

    const after = await findWorkItemById(app.db, organizationId, item.id);
    expect(after?.workflowState).toBe('in_progress');
    expect(await outbox(item.id, 'workitem.state_changed')).toHaveLength(1);
  });

  it('an ordinary update (synchronize/edited) refreshes the pointer without a state jump', async () => {
    const { organizationId, projectId } = await makeOrg('ordinary-update');
    const item = await makeItem(organizationId, projectId, 'issue-update', 'in_review');
    await setPrRef(app.db, organizationId, item.id, {
      repo: 'acme/widgets',
      number: 7,
      state: 'open',
    });

    await reconcile(organizationId, 'updated', pr({ title: 'Edited title' }));

    const after = await findWorkItemById(app.db, organizationId, item.id);
    expect(after?.workflowState).toBe('in_review');
    expect(await outbox(item.id, 'workitem.reconciled')).toHaveLength(0);
  });

  it('does not let a stale closed-unmerged event corrupt an already-recorded merge', async () => {
    const { organizationId, projectId } = await makeOrg('stale-merge');
    const item = await makeItem(organizationId, projectId, 'issue-stale', 'done');
    await setPrRef(app.db, organizationId, item.id, {
      repo: 'acme/widgets',
      number: 7,
      state: 'merged',
    });

    await reconcile(organizationId, 'closed', pr({ state: 'closed' }));

    const after = await findWorkItemById(app.db, organizationId, item.id);
    expect(after?.prRef?.state).toBe('merged'); // pointer not corrupted
    expect(after?.workflowState).toBe('done');
  });

  it('is idempotent: redelivering the same merge event does not re-transition', async () => {
    const { organizationId, projectId } = await makeOrg('idem');
    const item = await makeItem(organizationId, projectId, 'issue-idem', 'in_review');
    await setPrRef(app.db, organizationId, item.id, {
      repo: 'acme/widgets',
      number: 7,
      state: 'open',
    });

    await reconcile(organizationId, 'merged', pr({ state: 'merged' }));
    await reconcile(organizationId, 'merged', pr({ state: 'merged' }));

    const after = await findWorkItemById(app.db, organizationId, item.id);
    expect(after?.workflowState).toBe('done');
    expect(await outbox(item.id, 'workitem.state_changed')).toHaveLength(1);
  });
});
