import type { Database } from '@devflow/database';
import { publishOutbox } from '@devflow/events';
import { AiError, REVIEW_PROMPT_VERSION, reviewCode, type AiProvider } from '@devflow/ai';
import type { ProviderContext, SourceControlPort } from '@devflow/integrations-core';
import type { OrganizationId } from '@devflow/types';
import type { FastifyBaseLogger } from 'fastify';
import { findWorkItemById, findWorkItemForPr } from '../../work-items/dal/work-items.dal';
import type { ResolveSourceControl } from '../../dev-workflow/service/dev-workflow.service';
import {
  claimReview,
  completeReview,
  failReview,
  findReviewById,
  insertOrFetchReview,
  resetReviewForRerun,
  setReviewPointers,
  type AiReviewRow,
} from '../dal/ai-reviews.dal';
import {
  AiReviewCompleted,
  AiReviewFailed,
  AiReviewRequested,
  AiReviewRerunRequested,
} from '../events';
import { policyConclusion } from '../policy';
import { AI_REVIEW_CHECK_NAME, renderCheckOutput, renderSummaryComment } from '../render';

export interface AiReviewRequest {
  organizationId: string;
  repo: string;
  prNumber: number;
  /** Absent for triggers that don't carry it (e.g. older devworkflow events) — fetched from the PR. */
  headSha?: string;
  headRef?: string;
  /** Known when the trigger is DevFlow's own saga; otherwise matched by pr_ref / head branch. */
  workItemId?: string;
  /** PR state at trigger time, when the trigger carries it. Only open PRs are reviewed. */
  prState?: 'open' | 'closed' | 'merged';
}

export interface AiReviewDeps {
  db: Database;
  ai: AiProvider;
  credentialsKey: Buffer;
  resolveSourceControl: ResolveSourceControl;
  logger?: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

export interface AiReviewRunContext {
  correlationId: string;
  /** Lease holder — the queue job id, stable across that job's retries. */
  claimant: string;
  attempt: number;
  maxAttempts: number;
}

/** Long enough to outlast one job attempt (its timeout), so a live worker is never preempted. */
export const REVIEW_LEASE_MS = 15 * 60_000;

/**
 * The AI Review Pipeline (design §5.3): resolve the PR's commit and work item,
 * insert-or-fetch the per-commit row, take the lease, post a pending check,
 * fetch the diff, call `reviewCode`, apply the deterministic policy, persist
 * + emit in one transaction, then project onto GitHub (check + one comment).
 *
 * A completed/failed row short-circuits to re-projection only — never a second
 * model call for the same commit.
 */
export async function runAiReview(
  deps: AiReviewDeps,
  request: AiReviewRequest,
  run: AiReviewRunContext,
): Promise<AiReviewRow | null> {
  const { db } = deps;
  if (request.prState && request.prState !== 'open') return null;
  const { adapter, connectionId } = await deps.resolveSourceControl(
    db,
    request.organizationId,
    deps.credentialsKey,
  );
  const pctx: ProviderContext = {
    organizationId: request.organizationId as OrganizationId,
    connectionId,
  };

  let { headSha, headRef } = request;
  let prTitle: string | undefined;
  let baseRef: string | undefined;
  // headRef is only needed to match the work item; a known work item + sha needs no lookup.
  if (!headSha || (!headRef && !request.workItemId)) {
    const pr = await adapter.getPullRequest(pctx, { repo: request.repo, number: request.prNumber });
    if (pr.state !== 'open') return null; // nothing to gate on a closed/merged PR
    ({ headSha, headRef, baseRef, title: prTitle } = pr);
  }

  const workItem = request.workItemId
    ? await findWorkItemById(db, request.organizationId, request.workItemId)
    : await findWorkItemForPr(
        db,
        request.organizationId,
        request.repo,
        request.prNumber,
        headRef ?? '',
      );
  if (!workItem) {
    deps.logger?.info(
      { repo: request.repo, prNumber: request.prNumber },
      'ai-review: PR not linked to a work item, skipping',
    );
    return null;
  }

  const key = {
    organizationId: request.organizationId,
    repo: request.repo,
    prNumber: request.prNumber,
    headSha,
  };
  const { row } = await db.transaction(async (tx) => {
    const result = await insertOrFetchReview(tx, {
      ...key,
      workItemId: workItem.id,
      promptVersion: REVIEW_PROMPT_VERSION,
    });
    if (result.created) {
      await publishOutbox(
        tx,
        AiReviewRequested.create({
          organizationId: request.organizationId,
          aggregateId: workItem.id,
          correlationId: run.correlationId,
          payload: { workItemId: workItem.id, ...key },
        }),
      );
    }
    return result;
  });

  if (row.status !== 'pending') return projectReview(adapter, pctx, db, row);

  const claimed = await claimReview(
    db,
    request.organizationId,
    row.id,
    run.claimant,
    REVIEW_LEASE_MS,
  );
  if (!claimed) return null; // another job holds the lease for this commit

  try {
    const pending = await adapter.upsertCheckRun(pctx, {
      repo: request.repo,
      headSha,
      name: AI_REVIEW_CHECK_NAME,
      status: 'in_progress',
      output: renderCheckOutput(claimed),
    });
    await setReviewPointers(db, request.organizationId, row.id, {
      checkRunExternalId: pending.externalId,
    });

    const diff = await adapter.getDiff(pctx, { repo: request.repo, number: request.prNumber });
    const result = await reviewCode(deps.ai, {
      repository: { fullName: request.repo },
      pullRequest: { number: request.prNumber, title: prTitle, headRef, baseRef, headSha },
      diff,
      // Project-specific rules are deferred to Phase 2 (design §13 Q6).
      projectRules: undefined,
      context: { relatedTicket: { title: workItem.title } },
    });
    const conclusion = policyConclusion(result.output.findings);

    const completed = await db.transaction(async (tx) => {
      const updated = await completeReview(tx, request.organizationId, row.id, run.claimant, {
        summary: result.output.summary,
        findings: result.output.findings,
        policyConclusion: conclusion,
        model: result.model,
        provider: result.provider,
        rulesVersion: null,
      });
      if (!updated) return undefined; // lease lost (stolen after expiry) — the other holder reports
      await publishOutbox(
        tx,
        AiReviewCompleted.create({
          organizationId: request.organizationId,
          aggregateId: workItem.id,
          correlationId: run.correlationId,
          payload: {
            workItemId: workItem.id,
            ...key,
            policyConclusion: conclusion,
            findingCount: result.output.findings.length,
          },
        }),
      );
      return updated;
    });
    if (!completed) return null;

    return await projectReview(adapter, pctx, db, completed);
  } catch (error) {
    const terminal =
      (error instanceof AiError && !error.retryable) || run.attempt >= run.maxAttempts;
    if (!terminal) throw error;

    let failed = await markReviewFailed(deps, workItem.id, row.id, key, run, error);
    if (failed) {
      // Best effort: GitHub may be the thing that's failing.
      failed = await projectReview(adapter, pctx, db, failed).catch(() => failed);
    }
    // Non-retryable AI errors are fully handled (row failed, check neutral); an
    // exhausted retry budget still rethrows so the job lands in the DLQ.
    if (error instanceof AiError && !error.retryable) return failed ?? null;
    throw error;
  }
}

async function markReviewFailed(
  deps: AiReviewDeps,
  workItemId: string,
  reviewId: string,
  key: { organizationId: string; repo: string; prNumber: number; headSha: string },
  run: AiReviewRunContext,
  error: unknown,
): Promise<AiReviewRow | undefined> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  deps.logger?.error({ err: error, reviewId }, 'ai-review: review failed');
  return deps.db.transaction(async (tx) => {
    const failed = await failReview(tx, key.organizationId, reviewId, run.claimant, message);
    if (!failed) return undefined;
    await publishOutbox(
      tx,
      AiReviewFailed.create({
        organizationId: key.organizationId,
        aggregateId: workItemId,
        correlationId: run.correlationId,
        payload: { workItemId, ...key, error: message },
      }),
    );
    return failed;
  });
}

/**
 * Projects a finished row onto GitHub. Idempotent and re-derivable from the
 * row (design §2): the check upsert reconciles by name + sha, and the summary
 * comment is only posted while no comment pointer is cached. Returns the row
 * with its refreshed pointers.
 */
export async function projectReview(
  adapter: SourceControlPort,
  pctx: ProviderContext,
  db: Database,
  review: AiReviewRow,
): Promise<AiReviewRow> {
  if (review.status === 'pending') return review;

  const check = await adapter.upsertCheckRun(pctx, {
    repo: review.repo,
    headSha: review.headSha,
    name: AI_REVIEW_CHECK_NAME,
    status: 'completed',
    // An AI outage degrades to neutral, never to failure (design §5.3).
    conclusion: review.status === 'failed' ? 'neutral' : (review.policyConclusion ?? 'neutral'),
    output: renderCheckOutput(review),
  });
  if (check.externalId !== review.checkRunExternalId) {
    await setReviewPointers(db, review.organizationId, review.id, {
      checkRunExternalId: check.externalId,
    });
  }

  if (review.status === 'completed' && !review.commentExternalId) {
    const comment = await adapter.createComment(pctx, {
      repo: review.repo,
      targetExternalId: String(review.prNumber),
      body: renderSummaryComment(review),
    });
    await setReviewPointers(db, review.organizationId, review.id, {
      commentExternalId: comment.externalId,
    });
  }
  return (await findReviewById(db, review.organizationId, review.id)) ?? review;
}

export class AiReviewNotFoundError extends Error {}
/** The review is still pending — already queued or running. */
export class AiReviewInProgressError extends Error {}

/**
 * Manual rerun for the same commit (design §8, §13 Q5): resets the row to
 * pending and emits `ai.review_rerun_requested` in one transaction; the
 * outbox relay routes it to the same ai-review.request job.
 */
export async function requestAiReviewRerun(
  db: Database,
  input: { organizationId: string; workItemId: string; reviewId: string; actorUserId: string },
  correlationId: string,
): Promise<AiReviewRow> {
  return db.transaction(async (tx) => {
    const existing = await findReviewById(tx, input.organizationId, input.reviewId);
    if (!existing || existing.workItemId !== input.workItemId) throw new AiReviewNotFoundError();

    const reset = await resetReviewForRerun(
      tx,
      input.organizationId,
      input.reviewId,
      REVIEW_PROMPT_VERSION,
    );
    if (!reset) throw new AiReviewInProgressError();

    await publishOutbox(
      tx,
      AiReviewRerunRequested.create({
        organizationId: input.organizationId,
        aggregateId: input.workItemId,
        correlationId,
        payload: {
          workItemId: input.workItemId,
          reviewId: reset.id,
          repo: reset.repo,
          prNumber: reset.prNumber,
          headSha: reset.headSha,
          actorUserId: input.actorUserId,
        },
      }),
    );
    return reset;
  });
}
