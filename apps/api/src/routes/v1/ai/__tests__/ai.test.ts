import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { and, eq } from 'drizzle-orm';
import { workflowConfigSchema } from '@devflow/validation';
import { AiProviderError, type AiProvider } from '@devflow/ai';
import type { OrganizationId, UserId } from '@devflow/types';
import { buildApp } from '../../../../app';
import { createUser } from '../../../../modules/identity/dal/users.dal';
import { createUserSession } from '../../../../modules/identity/service/session.service';
import { SESSION_COOKIE_NAME } from '../../../../plugins/auth';
import { createOrganization } from '../../../../modules/organizations/service/organizations.service';
import { createWorkItem } from '../../../../modules/work-items/dal/work-items.dal';
import {
  insertOrFetchReview,
  findReviewById,
} from '../../../../modules/ai-review/dal/ai-reviews.dal';

const fake = vi.hoisted(() => ({ provider: null as AiProvider | null }));
vi.mock('../../../../modules/ai/provider', () => ({
  getPlatformAiProvider: () => fake.provider,
}));

const draft = {
  title: 'Add password reset',
  description: 'Users need a way to reset their password.',
  acceptanceCriteria: ['A reset email is sent', 'The link expires after 1 hour'],
};

function providerReturning(output: unknown | Error) {
  const generateStructuredOutput = vi.fn(async () => {
    if (output instanceof Error) throw output;
    return { output, model: 'm', provider: 'p' };
  });
  return {
    provider: {
      name: 'fake',
      generateText: vi.fn(),
      generateStructuredOutput,
    } as unknown as AiProvider,
    generateStructuredOutput,
  };
}

describe('AI routes', () => {
  let app: FastifyInstance;
  const createdUserIds: UserId[] = [];
  const createdOrgIds: OrganizationId[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  beforeEach(() => {
    fake.provider = null;
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

  async function seed(label: string) {
    const githubId = `ai-route-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);
    const { token } = await createUserSession(
      app.db,
      { ttlDays: 30, refreshThresholdDays: 7 },
      { userId: user.id as UserId },
    );
    const org = await createOrganization(app.db, {
      name: `AI Route Org ${label}`,
      userId: user.id as UserId,
      correlationId: crypto.randomUUID(),
    });
    createdOrgIds.push(org.id as OrganizationId);
    const [project] = await app.db
      .insert(schema.projects)
      .values({
        organizationId: org.id,
        name: `Checkout ${label}`,
        slug: `p-${label}-${crypto.randomUUID()}`,
        workflowConfig: workflowConfigSchema.parse({}),
      })
      .returning();
    const workItem = await createWorkItem(app.db, {
      organizationId: org.id,
      projectId: project!.id,
      title: 'WI',
      externalProvider: 'plane',
      externalIssueId: `issue-${crypto.randomUUID()}`,
    });
    return {
      cookie: `${SESSION_COOKIE_NAME}=${app.signCookie(token)}`,
      organizationId: org.id,
      projectId: project!.id,
      workItemId: workItem.id,
    };
  }

  describe('ticket drafts', () => {
    it('returns an AI draft and persists nothing', async () => {
      const s = await seed('draft');
      const { provider, generateStructuredOutput } = providerReturning(draft);
      fake.provider = provider;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${s.organizationId}/projects/${s.projectId}/work-items/draft`,
        headers: { cookie: s.cookie },
        payload: { prompt: 'let users reset their password' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(draft);
      const call = generateStructuredOutput.mock.calls[0] as unknown as [
        { capability: string; messages: { content: string }[] },
      ];
      expect(call[0].capability).toBe('ticket-draft');
      expect(call[0].messages[0]!.content).toContain('Checkout draft');

      const items = await app.db.query.workItems.findMany({
        where: eq(schema.workItems.organizationId, s.organizationId),
      });
      expect(items).toHaveLength(1); // only the seeded one
      const workItemEvents = await app.db.query.outboxEvents.findMany({
        where: and(
          eq(schema.outboxEvents.organizationId, s.organizationId),
          eq(schema.outboxEvents.type, 'workitem.created'),
        ),
      });
      expect(workItemEvents).toHaveLength(0);
    });

    it('improves an existing draft', async () => {
      const s = await seed('improve');
      const improved = { ...draft, title: 'Add self-service password reset' };
      fake.provider = providerReturning(improved).provider;

      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${s.organizationId}/work-items/draft/improve`,
        headers: { cookie: s.cookie },
        payload: { draft, instructions: 'make the title more specific' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().title).toBe(improved.title);
    });

    it('503 when AI is not configured, 502 when the provider fails, 404 for a foreign project', async () => {
      const s = await seed('errors');
      const url = `/api/v1/organizations/${s.organizationId}/projects/${s.projectId}/work-items/draft`;
      const send = (u = url) =>
        app.inject({
          method: 'POST',
          url: u,
          headers: { cookie: s.cookie },
          payload: { prompt: 'x' },
        });

      expect((await send()).statusCode).toBe(503);

      fake.provider = providerReturning(new AiProviderError('boom')).provider;
      expect((await send()).statusCode).toBe(502);

      expect(
        (
          await send(
            `/api/v1/organizations/${s.organizationId}/projects/${crypto.randomUUID()}/work-items/draft`,
          )
        ).statusCode,
      ).toBe(404);
    });
  });

  describe('ai reviews', () => {
    async function seedReview(
      s: Awaited<ReturnType<typeof seed>>,
      status: 'pending' | 'completed',
    ) {
      const { row } = await insertOrFetchReview(app.db, {
        organizationId: s.organizationId,
        workItemId: s.workItemId,
        repo: 'acme/widgets',
        prNumber: 7,
        headSha: `sha-${crypto.randomUUID()}`,
        promptVersion: 'review-v1',
      });
      if (status === 'completed') {
        await app.db
          .update(schema.aiReviews)
          .set({
            status: 'completed',
            policyConclusion: 'success',
            summary: 'ok',
            findings: [],
            commentExternalId: 'comment-1',
          })
          .where(eq(schema.aiReviews.id, row.id));
      }
      return row.id;
    }

    it('lists reviews for a work item', async () => {
      const s = await seed('list');
      const id = await seedReview(s, 'completed');

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/organizations/${s.organizationId}/work-items/${s.workItemId}/ai-reviews`,
        headers: { cookie: s.cookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().reviews).toEqual([
        expect.objectContaining({ id, status: 'completed', policyConclusion: 'success' }),
      ]);
    });

    it('rerun resets a finished review to pending and emits the rerun event; 409 while pending', async () => {
      const s = await seed('rerun');
      fake.provider = providerReturning(draft).provider;
      const id = await seedReview(s, 'completed');
      const url = `/api/v1/organizations/${s.organizationId}/work-items/${s.workItemId}/ai-reviews/${id}/rerun`;

      const first = await app.inject({ method: 'POST', url, headers: { cookie: s.cookie } });
      expect(first.statusCode).toBe(202);
      expect(first.json()).toMatchObject({ id, status: 'pending', summary: null });

      const row = await findReviewById(app.db, s.organizationId, id);
      expect(row).toMatchObject({ status: 'pending', commentExternalId: null, claimedBy: null });
      const events = await app.db.query.outboxEvents.findMany({
        where: and(
          eq(schema.outboxEvents.aggregateId, s.workItemId),
          eq(schema.outboxEvents.type, 'ai.review_rerun_requested'),
        ),
      });
      expect(events).toHaveLength(1);

      const second = await app.inject({ method: 'POST', url, headers: { cookie: s.cookie } });
      expect(second.statusCode).toBe(409);

      const other = await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${s.organizationId}/work-items/${s.workItemId}/ai-reviews/${crypto.randomUUID()}/rerun`,
        headers: { cookie: s.cookie },
      });
      expect(other.statusCode).toBe(404);
    });
  });
});
