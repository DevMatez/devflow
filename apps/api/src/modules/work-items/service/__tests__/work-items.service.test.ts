import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../../../../app';
import { createUser } from '../../../identity/dal/users.dal';
import { createOrganization } from '../../../organizations/service/organizations.service';
import { workflowConfigSchema } from '@devflow/validation';
import { createWorkItem } from '../../dal/work-items.dal';
import {
  createAndBindWorkItem,
  transitionWorkItem,
  IntegrationRequiredError,
  ProviderError,
  InvalidTransitionError,
  WorkItemNotFoundError,
  type ResolvePmAdapter,
} from '../work-items.service';
import type { OrgContext } from '../../../access/org-context';
import type { OrganizationId, UserId } from '@devflow/types';
import type { ProjectManagementPort } from '@devflow/integrations-core';

const credentialsKey = Buffer.alloc(32, 7);

function stubIssue(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'plane-issue-1',
    title: 'Add login',
    description: null,
    status: 'state-1',
    assigneeExternalId: null,
    url: 'https://app.plane.so/acme/projects/pp1/issues/42',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Injected PM resolver — no live Plane connection needed (design §13 "stubbed PM adapter"). */
function stubResolve(createIssue: ReturnType<typeof vi.fn>): ResolvePmAdapter {
  const adapter = {
    createIssue,
    updateIssue: vi.fn(),
    getIssue: vi.fn(),
    createComment: vi.fn(),
  } as unknown as ProjectManagementPort;
  return async () => ({ adapter, provider: 'plane', connectionId: 'connection-1' });
}

describe('work-items service', () => {
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

  async function makeContext(label: string): Promise<OrgContext & { projectId: string }> {
    const githubId = `work-items-service-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);

    const org = await createOrganization(app.db, {
      name: `Work Items Service Org ${label}`,
      userId: user.id as UserId,
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

    return {
      organizationId: org.id as OrganizationId,
      userId: user.id as UserId,
      role: 'owner',
      projectId: project.id,
    };
  }

  function outboxEvents(aggregateId: string, type: string) {
    return app.db.query.outboxEvents.findMany({
      where: and(
        eq(schema.outboxEvents.aggregateId, aggregateId),
        eq(schema.outboxEvents.type, type),
      ),
    });
  }

  it('create-and-bind authors the issue then persists the bound work item + event', async () => {
    const ctx = await makeContext('bind');
    const createIssue = vi.fn().mockResolvedValue(stubIssue());

    const row = await createAndBindWorkItem(
      app.db,
      ctx,
      credentialsKey,
      { projectId: ctx.projectId, externalProjectId: 'pp1', title: 'Add login' },
      crypto.randomUUID(),
      stubResolve(createIssue),
    );

    expect(createIssue).toHaveBeenCalledWith(
      { organizationId: ctx.organizationId, connectionId: 'connection-1' },
      { projectId: 'pp1', title: 'Add login', description: undefined },
    );
    expect(row.externalProvider).toBe('plane');
    expect(row.externalIssueId).toBe('plane-issue-1');
    expect(row.workflowState).toBe('backlog');
    expect(await outboxEvents(row.id, 'workitem.created')).toHaveLength(1);
  });

  it('requires a project-management connection (default resolver, no connection)', async () => {
    const ctx = await makeContext('no-pm');
    await expect(
      createAndBindWorkItem(
        app.db,
        ctx,
        credentialsKey,
        { projectId: ctx.projectId, externalProjectId: 'pp1', title: 'X' },
        crypto.randomUUID(),
      ),
    ).rejects.toBeInstanceOf(IntegrationRequiredError);
  });

  it('does not persist a work item when the provider rejects createIssue', async () => {
    const ctx = await makeContext('provider-error');
    const createIssue = vi.fn().mockRejectedValue(new Error('plane 500'));

    await expect(
      createAndBindWorkItem(
        app.db,
        ctx,
        credentialsKey,
        { projectId: ctx.projectId, externalProjectId: 'pp1', title: 'X' },
        crypto.randomUUID(),
        stubResolve(createIssue),
      ),
    ).rejects.toBeInstanceOf(ProviderError);

    const rows = await app.db.query.workItems.findMany({
      where: eq(schema.workItems.projectId, ctx.projectId),
    });
    expect(rows).toHaveLength(0);
  });

  it('applies an actor transition, bumps version, and emits state_changed', async () => {
    const ctx = await makeContext('transition');
    const item = await createWorkItem(app.db, {
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      title: 'Move me',
      externalProvider: 'plane',
      externalIssueId: 'issue-move',
      workflowState: 'todo',
    });

    const updated = await transitionWorkItem(
      app.db,
      ctx,
      item.id,
      { type: 'advance', to: 'in_progress' },
      crypto.randomUUID(),
    );

    expect(updated.workflowState).toBe('in_progress');
    expect(updated.version).toBe(1);
    expect(await outboxEvents(item.id, 'workitem.state_changed')).toHaveLength(1);
  });

  it('rejects an illegal actor transition and a missing work item', async () => {
    const ctx = await makeContext('invalid');
    const item = await createWorkItem(app.db, {
      organizationId: ctx.organizationId,
      projectId: ctx.projectId,
      title: 'Guarded',
      externalProvider: 'plane',
      externalIssueId: 'issue-guard',
      workflowState: 'todo',
    });

    await expect(
      transitionWorkItem(
        app.db,
        ctx,
        item.id,
        { type: 'advance', to: 'done' },
        crypto.randomUUID(),
      ),
    ).rejects.toBeInstanceOf(InvalidTransitionError);

    await expect(
      transitionWorkItem(app.db, ctx, crypto.randomUUID(), { type: 'cancel' }, crypto.randomUUID()),
    ).rejects.toBeInstanceOf(WorkItemNotFoundError);
  });
});
