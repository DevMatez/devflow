import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { schema } from '@devflow/database';
import { and, eq } from 'drizzle-orm';
import { workflowConfigSchema } from '@devflow/validation';
import {
  AiRateLimitError,
  AiValidationError,
  type AiProvider,
  type GenerateStructuredInput,
} from '@devflow/ai';
import type {
  SourceControlPort,
  UpsertCheckRunInput,
  CreateCommentInput,
} from '@devflow/integrations-core';
import type { OrganizationId, UserId } from '@devflow/types';
import { buildApp } from '../../../app';
import { createUser } from '../../identity/dal/users.dal';
import { createOrganization } from '../../organizations/service/organizations.service';
import { createWorkItem, setBranchRef } from '../../work-items/dal/work-items.dal';
import type { ResolveSourceControl } from '../../dev-workflow/service/dev-workflow.service';
import { runAiReview, type AiReviewRunContext } from '../service/ai-review.service';
import { AI_REVIEW_CHECK_NAME } from '../render';

const key = Buffer.alloc(32, 7);
const REPO = 'acme/widgets';
const BRANCH = 'feature/PROJ-1-x';

type ModelFinding = {
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line?: number;
  title: string;
  explanation: string;
};

function fakeSourceControl(prNumber: number, headSha = 'sha-1') {
  const checks: UpsertCheckRunInput[] = [];
  const comments: CreateCommentInput[] = [];
  const adapter = {
    getPullRequest: vi.fn(async () => ({
      externalId: 'pr-1',
      repo: REPO,
      number: prNumber,
      title: 'Add login',
      state: 'open' as const,
      url: `https://github.com/${REPO}/pull/${prNumber}`,
      headRef: BRANCH,
      headSha,
      baseRef: 'main',
      authorExternalId: '1',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    getDiff: vi.fn(async () => 'diff --git a/x.ts b/x.ts\n+const x = 1;'),
    upsertCheckRun: vi.fn(async (_ctx: unknown, input: UpsertCheckRunInput) => {
      checks.push(input);
      return {
        externalId: 'check-1',
        name: input.name,
        status: input.status,
        conclusion: input.conclusion ?? null,
        url: 'https://x',
      };
    }),
    createComment: vi.fn(async (_ctx: unknown, input: CreateCommentInput) => {
      comments.push(input);
      return {
        externalId: `comment-${comments.length}`,
        body: input.body,
        authorExternalId: 'bot',
        url: 'https://x',
        createdAt: '2026-01-01T00:00:00Z',
      };
    }),
  };
  const resolve: ResolveSourceControl = async () => ({
    adapter: adapter as unknown as SourceControlPort,
    connectionId: 'conn-1',
  });
  return { adapter, resolve, checks, comments };
}

function fakeAi(behavior: (() => Promise<{ summary: string; findings: ModelFinding[] }>) | Error) {
  const generateStructuredOutput = vi.fn<
    (input: GenerateStructuredInput<never>) => Promise<unknown>
  >(async () => {
    if (behavior instanceof Error) throw behavior;
    return { output: await behavior(), model: 'claude-test', provider: 'anthropic' };
  });
  return {
    ai: { name: 'fake', generateText: vi.fn(), generateStructuredOutput } as unknown as AiProvider,
    generateStructuredOutput,
  };
}

const clean = async () => ({ summary: 'Looks fine.', findings: [] });

function run(overrides: Partial<AiReviewRunContext> = {}): AiReviewRunContext {
  return {
    correlationId: crypto.randomUUID(),
    claimant: `job-${crypto.randomUUID()}`,
    attempt: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

describe('AI review pipeline', () => {
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

  /** An org with one work item whose branch is the PR head (PR not yet bound — branch fallback). */
  async function setup(label: string) {
    const githubId = `ai-review-${label}-${crypto.randomUUID()}`;
    const user = await createUser(app.db, { githubId, email: `${githubId}@example.test` });
    createdUserIds.push(user.id as UserId);
    const org = await createOrganization(app.db, {
      name: `AI Org ${label}`,
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
    const workItem = await createWorkItem(app.db, {
      organizationId: org.id,
      projectId: project!.id,
      title: 'Add login',
      externalProvider: 'plane',
      externalIssueId: `issue-${crypto.randomUUID()}`,
      workflowState: 'in_review',
    });
    await setBranchRef(app.db, org.id, workItem.id, {
      repo: REPO,
      name: BRANCH,
      base: 'main',
      status: 'active',
    });
    return { organizationId: org.id, workItemId: workItem.id };
  }

  function reviews(organizationId: string) {
    return app.db.query.aiReviews.findMany({
      where: eq(schema.aiReviews.organizationId, organizationId),
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

  const request = (organizationId: string, headSha = 'sha-1') => ({
    organizationId,
    repo: REPO,
    prNumber: 7,
    headSha,
    headRef: BRANCH,
  });

  it('reviews a linked PR: pending check → completed success, one summary comment, events', async () => {
    const { organizationId, workItemId } = await setup('happy');
    const sc = fakeSourceControl(7);
    const { ai, generateStructuredOutput } = fakeAi(async () => ({
      summary: 'Adds a constant.',
      findings: [{ severity: 'high', file: 'x.ts', line: 1, title: 'Bug', explanation: 'why' }],
    }));

    const row = await runAiReview(
      { db: app.db, ai, credentialsKey: key, resolveSourceControl: sc.resolve },
      request(organizationId),
      run(),
    );

    expect(row).toMatchObject({
      status: 'completed',
      policyConclusion: 'success',
      workItemId,
      model: 'claude-test',
      provider: 'anthropic',
      checkRunExternalId: 'check-1',
      commentExternalId: 'comment-1',
    });
    expect(generateStructuredOutput).toHaveBeenCalledTimes(1);
    expect(generateStructuredOutput.mock.calls[0]![0].capability).toBe('code-review');
    expect(sc.checks.map((c) => [c.name, c.status, c.conclusion])).toEqual([
      [AI_REVIEW_CHECK_NAME, 'in_progress', undefined],
      [AI_REVIEW_CHECK_NAME, 'completed', 'success'],
    ]);
    expect(sc.comments).toHaveLength(1);
    expect(sc.comments[0]).toMatchObject({ repo: REPO, targetExternalId: '7' });
    expect(await outbox(workItemId, 'ai.review_requested')).toHaveLength(1);
    expect(await outbox(workItemId, 'ai.review_completed')).toHaveLength(1);
  });

  it('a critical finding fails the check (policy)', async () => {
    const { organizationId } = await setup('critical');
    const sc = fakeSourceControl(7);
    const { ai } = fakeAi(async () => ({
      summary: 's',
      findings: [{ severity: 'critical', file: 'x.ts', title: 'SQLi', explanation: 'e' }],
    }));

    const row = await runAiReview(
      { db: app.db, ai, credentialsKey: key, resolveSourceControl: sc.resolve },
      request(organizationId),
      run(),
    );

    expect(row?.policyConclusion).toBe('failure');
    expect(sc.checks.at(-1)).toMatchObject({ status: 'completed', conclusion: 'failure' });
  });

  it('two near-simultaneous triggers for one commit → one row, one model call, one comment', async () => {
    const { organizationId } = await setup('dedupe');
    const sc = fakeSourceControl(7);
    const { ai, generateStructuredOutput } = fakeAi(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return { summary: 's', findings: [] };
    });
    const deps = { db: app.db, ai, credentialsKey: key, resolveSourceControl: sc.resolve };

    await Promise.all([
      runAiReview(deps, request(organizationId), run()),
      runAiReview(deps, request(organizationId), run()),
    ]);
    // A later redelivery of a completed commit only re-projects.
    await runAiReview(deps, request(organizationId), run());

    expect(await reviews(organizationId)).toHaveLength(1);
    expect(generateStructuredOutput).toHaveBeenCalledTimes(1);
    expect(sc.comments).toHaveLength(1);
  });

  it('a new push (new head sha) creates a new row; the previous row is untouched', async () => {
    const { organizationId } = await setup('push');
    const sc = fakeSourceControl(7);
    const { ai, generateStructuredOutput } = fakeAi(clean);
    const deps = { db: app.db, ai, credentialsKey: key, resolveSourceControl: sc.resolve };

    const first = await runAiReview(deps, request(organizationId, 'sha-1'), run());
    const second = await runAiReview(deps, request(organizationId, 'sha-2'), run());

    expect(second?.id).not.toBe(first?.id);
    const rows = await reviews(organizationId);
    expect(rows.map((r) => r.headSha).sort()).toEqual(['sha-1', 'sha-2']);
    expect(rows.find((r) => r.headSha === 'sha-1')?.updatedAt).toEqual(first?.updatedAt);
    expect(generateStructuredOutput).toHaveBeenCalledTimes(2);
  });

  it('a non-retryable AI error resolves failed + neutral check + ai.review_failed, without throwing', async () => {
    const { organizationId, workItemId } = await setup('ai-fail');
    const sc = fakeSourceControl(7);
    const { ai } = fakeAi(new AiValidationError('bad schema'));

    const row = await runAiReview(
      { db: app.db, ai, credentialsKey: key, resolveSourceControl: sc.resolve },
      request(organizationId),
      run(),
    );

    expect(row).toMatchObject({ status: 'failed', policyConclusion: null });
    expect(row?.error).toContain('bad schema');
    expect(sc.checks.at(-1)).toMatchObject({ status: 'completed', conclusion: 'neutral' });
    expect(sc.checks.some((c) => c.conclusion === 'failure')).toBe(false);
    expect(sc.comments).toHaveLength(0);
    expect(await outbox(workItemId, 'ai.review_failed')).toHaveLength(1);
  });

  it('a retryable AI error is rethrown for the queue until the last attempt, then degrades to neutral', async () => {
    const { organizationId } = await setup('ai-retry');
    const sc = fakeSourceControl(7);
    const { ai } = fakeAi(new AiRateLimitError('slow down'));
    const deps = { db: app.db, ai, credentialsKey: key, resolveSourceControl: sc.resolve };
    const claimant = `job-${crypto.randomUUID()}`;

    await expect(
      runAiReview(deps, request(organizationId), run({ claimant, attempt: 1 })),
    ).rejects.toBeInstanceOf(AiRateLimitError);
    expect((await reviews(organizationId))[0]?.status).toBe('pending');

    await expect(
      runAiReview(deps, request(organizationId), run({ claimant, attempt: 3 })),
    ).rejects.toBeInstanceOf(AiRateLimitError);
    expect((await reviews(organizationId))[0]?.status).toBe('failed');
    expect(sc.checks.at(-1)).toMatchObject({ status: 'completed', conclusion: 'neutral' });
  });

  it('skips PRs that are not linked to a work item, and closed PRs', async () => {
    const { organizationId } = await setup('unlinked');
    const sc = fakeSourceControl(7);
    const { ai, generateStructuredOutput } = fakeAi(clean);
    const deps = { db: app.db, ai, credentialsKey: key, resolveSourceControl: sc.resolve };

    expect(
      await runAiReview(deps, { ...request(organizationId), headRef: 'someone-else' }, run()),
    ).toBeNull();
    expect(
      await runAiReview(deps, { ...request(organizationId), prState: 'closed' }, run()),
    ).toBeNull();

    expect(await reviews(organizationId)).toHaveLength(0);
    expect(generateStructuredOutput).not.toHaveBeenCalled();
  });

  it('fetches the head sha from the PR when the trigger does not carry it', async () => {
    const { organizationId, workItemId } = await setup('fetch-sha');
    const sc = fakeSourceControl(7, 'sha-from-github');
    const { ai } = fakeAi(clean);

    const row = await runAiReview(
      { db: app.db, ai, credentialsKey: key, resolveSourceControl: sc.resolve },
      { organizationId, repo: REPO, prNumber: 7, workItemId },
      run(),
    );

    expect(sc.adapter.getPullRequest).toHaveBeenCalledTimes(1);
    expect(row?.headSha).toBe('sha-from-github');
  });
});
