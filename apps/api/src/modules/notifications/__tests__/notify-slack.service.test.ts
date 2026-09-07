import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { workflowConfigSchema } from '@devflow/validation';
import type { ChatPort } from '@devflow/integrations-core';
import { buildApp } from '../../../app';
import { createUser } from '../../identity/dal/users.dal';
import { createOrganization } from '../../organizations/service/organizations.service';
import { createWorkItem } from '../../work-items/dal/work-items.dal';
import {
  notifySlack,
  type NotifiableEvent,
  type ResolveChat,
} from '../service/notify-slack.service';
import type { OrganizationId, UserId } from '@devflow/types';

const credentialsKey = Buffer.alloc(32, 3);

function stubResolve(postMessage: ReturnType<typeof vi.fn>): ResolveChat {
  const adapter = { listChannels: vi.fn(), postMessage } as unknown as ChatPort;
  return async () => ({ adapter, connectionId: 'conn-1' });
}

describe('notify-slack service', () => {
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

  async function makeContext(label: string, notificationChannelId?: string) {
    const githubId = `notify-slack-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);
    const org = await createOrganization(app.db, {
      name: `Notify Org ${label}`,
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
        workflowConfig: workflowConfigSchema.parse({ notificationChannelId }),
      })
      .returning();
    const item = await createWorkItem(app.db, {
      organizationId: org.id,
      projectId: project!.id,
      title: 'Add login',
      externalProvider: 'plane',
      externalIssueId: `issue-${crypto.randomUUID()}`,
      externalIssueKey: 'PROJ-1',
    });
    return { organizationId: org.id as OrganizationId, workItemId: item.id };
  }

  it('posts to the configured channel on work_started', async () => {
    const { organizationId, workItemId } = await makeContext('started', 'C123');
    const postMessage = vi.fn().mockResolvedValue({});
    const event: NotifiableEvent = {
      organizationId,
      type: 'devworkflow.work_started',
      payload: { workItemId, actorUserId: 'u-1' },
    };

    await notifySlack(app.db, event, credentialsKey, stubResolve(postMessage));

    expect(postMessage).toHaveBeenCalledWith(
      { organizationId, connectionId: 'conn-1' },
      { channelExternalId: 'C123', text: expect.stringContaining('PROJ-1') },
    );
  });

  it('posts on pull_request_opened and on state_changed to done', async () => {
    const { organizationId, workItemId } = await makeContext('events', 'C123');
    const postMessage = vi.fn().mockResolvedValue({});
    const resolve = stubResolve(postMessage);

    await notifySlack(
      app.db,
      {
        organizationId,
        type: 'devworkflow.pull_request_opened',
        payload: { workItemId, url: 'https://x/7' },
      },
      credentialsKey,
      resolve,
    );
    await notifySlack(
      app.db,
      {
        organizationId,
        type: 'workitem.state_changed',
        payload: { workItemId, from: 'in_review', to: 'done' },
      },
      credentialsKey,
      resolve,
    );

    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('skips a state_changed event that is not a completion', async () => {
    const { organizationId, workItemId } = await makeContext('non-done', 'C123');
    const postMessage = vi.fn().mockResolvedValue({});

    await notifySlack(
      app.db,
      {
        organizationId,
        type: 'workitem.state_changed',
        payload: { workItemId, from: 'todo', to: 'in_progress' },
      },
      credentialsKey,
      stubResolve(postMessage),
    );

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('skips silently when no notificationChannelId is configured', async () => {
    const { organizationId, workItemId } = await makeContext('no-channel');
    const postMessage = vi.fn();

    await notifySlack(
      app.db,
      {
        organizationId,
        type: 'devworkflow.work_started',
        payload: { workItemId, actorUserId: 'u-1' },
      },
      credentialsKey,
      stubResolve(postMessage),
    );

    expect(postMessage).not.toHaveBeenCalled();
  });

  it('skips silently when there is no chat connection', async () => {
    const { organizationId, workItemId } = await makeContext('no-conn', 'C123');
    const resolve: ResolveChat = async () => null;

    await expect(
      notifySlack(
        app.db,
        {
          organizationId,
          type: 'devworkflow.work_started',
          payload: { workItemId, actorUserId: 'u-1' },
        },
        credentialsKey,
        resolve,
      ),
    ).resolves.toBeUndefined();
  });

  it('ignores an event type it does not notify on', async () => {
    const { organizationId, workItemId } = await makeContext('other-event', 'C123');
    const postMessage = vi.fn();

    await notifySlack(
      app.db,
      { organizationId, type: 'workitem.created', payload: { workItemId } },
      credentialsKey,
      stubResolve(postMessage),
    );

    expect(postMessage).not.toHaveBeenCalled();
  });
});
