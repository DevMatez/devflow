import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { workflowConfigSchema } from '@devflow/validation';
import { buildApp } from '../../../app';
import { createUser } from '../../identity/dal/users.dal';
import { createOrganization } from '../../organizations/service/organizations.service';
import {
  applyStateChange,
  createWorkItem,
  findWorkItemByExternalIssue,
  findWorkItemById,
  listWorkItems,
} from '../dal/work-items.dal';
import type { OrganizationId, UserId } from '@devflow/types';

describe('work-items DAL', () => {
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

  async function makeProject(
    label: string,
  ): Promise<{ organizationId: string; projectId: string }> {
    const githubId = `work-items-dal-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);

    const org = await createOrganization(app.db, {
      name: `Work Items Org ${label}`,
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

    return { organizationId: org.id, projectId: project.id };
  }

  it('creates a work item with the expected defaults', async () => {
    const { organizationId, projectId } = await makeProject('create');
    const row = await createWorkItem(app.db, {
      organizationId,
      projectId,
      title: 'Add login',
      externalProvider: 'plane',
      externalIssueId: 'issue-1',
      externalIssueKey: 'PROJ-1',
    });

    expect(row.workflowState).toBe('backlog');
    expect(row.workflowExecutionStatus).toBe('not_started');
    expect(row.blockedFromState).toBeNull();
    expect(row.version).toBe(0);
  });

  it('finds by id (org-scoped) and by external issue, and hides other orgs', async () => {
    const a = await makeProject('scoped-a');
    const b = await makeProject('scoped-b');
    const row = await createWorkItem(app.db, {
      organizationId: a.organizationId,
      projectId: a.projectId,
      title: 'Scoped',
      externalProvider: 'plane',
      externalIssueId: 'issue-scoped',
    });

    expect((await findWorkItemById(app.db, a.organizationId, row.id))?.id).toBe(row.id);
    expect(await findWorkItemById(app.db, b.organizationId, row.id)).toBeUndefined();
    expect(
      (await findWorkItemByExternalIssue(app.db, a.organizationId, 'plane', 'issue-scoped'))?.id,
    ).toBe(row.id);
  });

  it('lists work items filtered by workflow state', async () => {
    const { organizationId, projectId } = await makeProject('list');
    await createWorkItem(app.db, {
      organizationId,
      projectId,
      title: 'Backlog item',
      externalProvider: 'plane',
      externalIssueId: 'issue-b',
    });
    const inProgress = await createWorkItem(app.db, {
      organizationId,
      projectId,
      title: 'Active item',
      externalProvider: 'plane',
      externalIssueId: 'issue-a',
      workflowState: 'in_progress',
    });

    const filtered = await listWorkItems(app.db, organizationId, { workflowState: 'in_progress' });
    expect(filtered.map((r) => r.id)).toEqual([inProgress.id]);
  });

  it('applies a state change and bumps version', async () => {
    const { organizationId, projectId } = await makeProject('transition');
    const row = await createWorkItem(app.db, {
      organizationId,
      projectId,
      title: 'Transition me',
      externalProvider: 'plane',
      externalIssueId: 'issue-t',
      workflowState: 'in_progress',
    });

    const updated = await applyStateChange(app.db, organizationId, row.id, {
      workflowState: 'blocked',
      blockedFromState: 'in_progress',
    });

    expect(updated?.workflowState).toBe('blocked');
    expect(updated?.blockedFromState).toBe('in_progress');
    expect(updated?.version).toBe(1);
  });

  it('enforces one work item per (org, provider, external issue id)', async () => {
    const { organizationId, projectId } = await makeProject('unique');
    await createWorkItem(app.db, {
      organizationId,
      projectId,
      title: 'First',
      externalProvider: 'plane',
      externalIssueId: 'dupe',
    });

    await expect(
      createWorkItem(app.db, {
        organizationId,
        projectId,
        title: 'Second',
        externalProvider: 'plane',
        externalIssueId: 'dupe',
      }),
    ).rejects.toThrow();
  });
});
