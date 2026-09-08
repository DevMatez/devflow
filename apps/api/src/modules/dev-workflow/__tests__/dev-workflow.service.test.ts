import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { and, eq } from 'drizzle-orm';
import { workflowConfigSchema } from '@devflow/validation';
import type { SourceControlPort } from '@devflow/integrations-core';
import { buildApp } from '../../../app';
import { createUser } from '../../identity/dal/users.dal';
import { createOrganization } from '../../organizations/service/organizations.service';
import {
  createWorkItem,
  findWorkItemById,
  setBranchRef,
  setWorkflowExecutionStatus,
  type WorkItemRow,
} from '../../work-items/dal/work-items.dal';
import {
  startWork,
  markWorkflowFailed,
  WorkflowExecutionConflictError,
  type ResolveSourceControl,
} from '../service/dev-workflow.service';
import { runCreateBranchStep } from '../jobs/create-branch.job';
import { runCreatePrStep } from '../jobs/create-pr.job';
import {
  WorkItemNotFoundError,
  InvalidTransitionError,
} from '../../work-items/service/work-items.service';
import type { OrgContext } from '../../access/org-context';
import type { OrganizationId, UserId } from '@devflow/types';

const key = Buffer.alloc(32, 7);

const branchFixture = {
  name: 'feature/PROJ-1-x',
  repo: 'acme/widgets',
  sha: 'sha1',
  url: 'https://github.com/acme/widgets/tree/feature/PROJ-1-x',
};
const prFixture = {
  externalId: 'pr-100',
  repo: 'acme/widgets',
  number: 7,
  title: '[PROJ-1] x',
  state: 'open' as const,
  url: 'https://github.com/acme/widgets/pull/7',
  headRef: 'feature/PROJ-1-x',
  baseRef: 'main',
  authorExternalId: '42',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const stubResolve: ResolveSourceControl = async () => ({
  adapter: {
    findOrCreateBranch: async () => branchFixture,
    findOrCreatePullRequest: async () => prFixture,
  } as unknown as SourceControlPort,
  connectionId: 'conn-1',
});

describe('dev-workflow service + saga steps', () => {
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

  async function makeCtx(label: string): Promise<OrgContext & { projectId: string }> {
    const githubId = `dev-workflow-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);
    const org = await createOrganization(app.db, {
      name: `DW Org ${label}`,
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
    return {
      organizationId: org.id as OrganizationId,
      userId: user.id as UserId,
      role: 'owner',
      projectId: project!.id,
    };
  }

  function item(
    ctx: OrgContext & { projectId: string },
    label: string,
    workflowState: WorkItemRow['workflowState'] = 'todo',
  ) {
    return createWorkItem(app.db, {
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      title: 'x',
      externalProvider: 'plane',
      externalIssueId: `issue-${label}-${crypto.randomUUID()}`,
      externalIssueKey: 'PROJ-1',
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

  it('startWork (initial) advances to in_progress, sets execution running + branch intent, emits events', async () => {
    const ctx = await makeCtx('start');
    const wi = await item(ctx, 'start');

    const result = await startWork(
      app.db,
      ctx,
      { workItemId: wi.id, repo: 'acme/widgets' },
      crypto.randomUUID(),
    );
    expect(result.status).toBe('starting');

    const after = await findWorkItemById(app.db, ctx.organizationId, wi.id);
    expect(after?.workflowState).toBe('in_progress');
    expect(after?.workflowExecutionStatus).toBe('running');
    expect(after?.branchRef).toMatchObject({
      repo: 'acme/widgets',
      base: 'main',
      status: 'pending',
    });
    expect(await outbox(wi.id, 'workitem.state_changed')).toHaveLength(1);
    expect(await outbox(wi.id, 'devworkflow.work_started')).toHaveLength(1);
  });

  it('rejects starting when already running or completed', async () => {
    const ctx = await makeCtx('conflict');
    const wi = await item(ctx, 'conflict');
    await setWorkflowExecutionStatus(app.db, ctx.organizationId, wi.id, 'running');
    await expect(
      startWork(app.db, ctx, { workItemId: wi.id, repo: 'a/b' }, crypto.randomUUID()),
    ).rejects.toBeInstanceOf(WorkflowExecutionConflictError);

    await setWorkflowExecutionStatus(app.db, ctx.organizationId, wi.id, 'completed');
    await expect(
      startWork(app.db, ctx, { workItemId: wi.id, repo: 'a/b' }, crypto.randomUUID()),
    ).rejects.toBeInstanceOf(WorkflowExecutionConflictError);
  });

  it('rejects a missing work item and an illegal initial transition', async () => {
    const ctx = await makeCtx('bad');
    await expect(
      startWork(app.db, ctx, { workItemId: crypto.randomUUID(), repo: 'a/b' }, crypto.randomUUID()),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);

    const done = await item(ctx, 'bad', 'done');
    await expect(
      startWork(app.db, ctx, { workItemId: done.id, repo: 'a/b' }, crypto.randomUUID()),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('create-branch step finds-or-creates the branch, marks it active, emits branch_created', async () => {
    const ctx = await makeCtx('branch');
    const wi = await item(ctx, 'branch', 'in_progress');
    await setBranchRef(app.db, ctx.organizationId, wi.id, {
      repo: 'acme/widgets',
      name: 'feature/PROJ-1-x',
      base: 'main',
      status: 'pending',
    });

    await runCreateBranchStep(
      app.db,
      key,
      stubResolve,
      { organizationId: ctx.organizationId, workItemId: wi.id },
      crypto.randomUUID(),
    );

    const after = await findWorkItemById(app.db, ctx.organizationId, wi.id);
    expect(after?.branchRef).toMatchObject({ status: 'active', url: branchFixture.url });
    expect(await outbox(wi.id, 'devworkflow.branch_created')).toHaveLength(1);
  });

  it('create-pr step opens the PR, advances to in_review, completes execution', async () => {
    const ctx = await makeCtx('pr');
    const wi = await item(ctx, 'pr', 'in_progress');
    await setBranchRef(app.db, ctx.organizationId, wi.id, {
      repo: 'acme/widgets',
      name: 'feature/PROJ-1-x',
      base: 'main',
      status: 'active',
    });

    await runCreatePrStep(
      app.db,
      key,
      stubResolve,
      { organizationId: ctx.organizationId, workItemId: wi.id },
      crypto.randomUUID(),
    );

    const after = await findWorkItemById(app.db, ctx.organizationId, wi.id);
    expect(after?.prRef).toMatchObject({ repo: 'acme/widgets', number: 7, state: 'open' });
    expect(after?.workflowState).toBe('in_review');
    expect(after?.workflowExecutionStatus).toBe('completed');
    expect(await outbox(wi.id, 'devworkflow.pull_request_opened')).toHaveLength(1);
    expect(await outbox(wi.id, 'workitem.state_changed')).toHaveLength(1);
  });

  it('resumes a FAILED run from the first incomplete step', async () => {
    const ctx = await makeCtx('resume');
    // branch pending -> resume re-emits work_started
    const a = await item(ctx, 'resume-a', 'in_progress');
    await setBranchRef(app.db, ctx.organizationId, a.id, {
      repo: 'a/b',
      name: 'n',
      base: 'main',
      status: 'pending',
    });
    await setWorkflowExecutionStatus(app.db, ctx.organizationId, a.id, 'failed', 'boom');
    await startWork(app.db, ctx, { workItemId: a.id, repo: 'a/b' }, crypto.randomUUID());
    expect(
      (await findWorkItemById(app.db, ctx.organizationId, a.id))?.workflowExecutionStatus,
    ).toBe('running');
    expect(await outbox(a.id, 'devworkflow.work_started')).toHaveLength(1);

    // branch active, no PR -> resume re-emits branch_created
    const b = await item(ctx, 'resume-b', 'in_progress');
    await setBranchRef(app.db, ctx.organizationId, b.id, {
      repo: 'a/b',
      name: 'n',
      base: 'main',
      status: 'active',
    });
    await setWorkflowExecutionStatus(app.db, ctx.organizationId, b.id, 'failed', 'boom');
    await startWork(app.db, ctx, { workItemId: b.id, repo: 'a/b' }, crypto.randomUUID());
    expect(await outbox(b.id, 'devworkflow.branch_created')).toHaveLength(1);
  });

  it('markWorkflowFailed sets FAILED + records the error and emits workflow_failed', async () => {
    const ctx = await makeCtx('fail');
    const wi = await item(ctx, 'fail', 'in_progress');
    await markWorkflowFailed(
      app.db,
      ctx.organizationId,
      wi.id,
      'create-branch',
      new Error('nope'),
      crypto.randomUUID(),
    );

    const after = await findWorkItemById(app.db, ctx.organizationId, wi.id);
    expect(after?.workflowExecutionStatus).toBe('failed');
    expect(after?.workflowExecutionError).toBe('nope');
    expect(await outbox(wi.id, 'devworkflow.workflow_failed')).toHaveLength(1);
  });
});
