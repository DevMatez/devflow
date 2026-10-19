import { schema, type Database, type DatabaseTransaction } from '@devflow/database';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { CodeReviewFinding } from '@devflow/ai';
import type { PolicyConclusion } from '../policy';

export type AiReviewRow = typeof schema.aiReviews.$inferSelect;
type Db = Database | DatabaseTransaction;

export interface ReviewKey {
  organizationId: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/**
 * Insert-or-fetch on the `(org, repo, pr_number, head_sha)` unique key (design
 * §5.3): a redelivered or duplicate trigger reuses the existing row. `created`
 * is true only for the call that actually inserted.
 */
export async function insertOrFetchReview(
  db: Db,
  input: ReviewKey & { workItemId: string; promptVersion: string },
): Promise<{ row: AiReviewRow; created: boolean }> {
  const [inserted] = await db
    .insert(schema.aiReviews)
    .values(input)
    .onConflictDoNothing({
      target: [
        schema.aiReviews.organizationId,
        schema.aiReviews.repo,
        schema.aiReviews.prNumber,
        schema.aiReviews.headSha,
      ],
    })
    .returning();
  if (inserted) return { row: inserted, created: true };

  const existing = await findReviewByKey(db, input);
  if (!existing) throw new Error('insertOrFetchReview: conflicting row vanished');
  return { row: existing, created: false };
}

export function findReviewByKey(db: Db, key: ReviewKey) {
  return db.query.aiReviews.findFirst({
    where: and(
      eq(schema.aiReviews.organizationId, key.organizationId),
      eq(schema.aiReviews.repo, key.repo),
      eq(schema.aiReviews.prNumber, key.prNumber),
      eq(schema.aiReviews.headSha, key.headSha),
    ),
  });
}

/** Org-scoped lookup — a review in another org is invisible. */
export function findReviewById(db: Db, organizationId: string, id: string) {
  return db.query.aiReviews.findFirst({
    where: and(eq(schema.aiReviews.organizationId, organizationId), eq(schema.aiReviews.id, id)),
  });
}

/**
 * Takes the review lease for `claimant` (the queue job id, stable across that
 * job's retries). Succeeds when the row is pending and unclaimed, already held
 * by the same claimant, or held by a lease older than `leaseMs` (a crashed
 * worker). Two triggers for one commit therefore make at most one model call.
 */
export async function claimReview(
  db: Db,
  organizationId: string,
  id: string,
  claimant: string,
  leaseMs: number,
): Promise<AiReviewRow | undefined> {
  const staleBefore = new Date(Date.now() - leaseMs);
  const [row] = await db
    .update(schema.aiReviews)
    .set({ claimedBy: claimant, claimedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(schema.aiReviews.organizationId, organizationId),
        eq(schema.aiReviews.id, id),
        eq(schema.aiReviews.status, 'pending'),
        or(
          isNull(schema.aiReviews.claimedBy),
          eq(schema.aiReviews.claimedBy, claimant),
          lt(schema.aiReviews.claimedAt, staleBefore),
        ),
      ),
    )
    .returning();
  return row;
}

export interface CompleteReviewInput {
  summary: string;
  findings: CodeReviewFinding[];
  policyConclusion: PolicyConclusion;
  model: string;
  provider: string;
  rulesVersion: string | null;
}

/** pending → completed, only while `claimant` still holds the lease. */
export async function completeReview(
  db: Db,
  organizationId: string,
  id: string,
  claimant: string,
  input: CompleteReviewInput,
): Promise<AiReviewRow | undefined> {
  const [row] = await db
    .update(schema.aiReviews)
    .set({ ...input, status: 'completed', error: null, updatedAt: new Date() })
    .where(
      and(
        eq(schema.aiReviews.organizationId, organizationId),
        eq(schema.aiReviews.id, id),
        eq(schema.aiReviews.status, 'pending'),
        eq(schema.aiReviews.claimedBy, claimant),
      ),
    )
    .returning();
  return row;
}

/** pending → failed, only while `claimant` still holds the lease. */
export async function failReview(
  db: Db,
  organizationId: string,
  id: string,
  claimant: string,
  error: string,
): Promise<AiReviewRow | undefined> {
  const [row] = await db
    .update(schema.aiReviews)
    .set({ status: 'failed', error, updatedAt: new Date() })
    .where(
      and(
        eq(schema.aiReviews.organizationId, organizationId),
        eq(schema.aiReviews.id, id),
        eq(schema.aiReviews.status, 'pending'),
        eq(schema.aiReviews.claimedBy, claimant),
      ),
    )
    .returning();
  return row;
}

/** Cached GitHub pointers (design §2 ownership table) — never authoritative. */
export async function setReviewPointers(
  db: Db,
  organizationId: string,
  id: string,
  pointers: { checkRunExternalId?: string; commentExternalId?: string },
): Promise<void> {
  await db
    .update(schema.aiReviews)
    .set({ ...pointers, updatedAt: new Date() })
    .where(and(eq(schema.aiReviews.organizationId, organizationId), eq(schema.aiReviews.id, id)));
}

/**
 * Manual rerun (design §13 Q5): the one sanctioned mutation of a per-commit
 * row — reset it to pending, clear the result and the lease. Refused while a
 * review is still pending (it's already running or queued).
 */
export async function resetReviewForRerun(
  db: Db,
  organizationId: string,
  id: string,
  promptVersion: string,
): Promise<AiReviewRow | undefined> {
  const [row] = await db
    .update(schema.aiReviews)
    .set({
      status: 'pending',
      policyConclusion: null,
      summary: null,
      findings: null,
      model: null,
      provider: null,
      rulesVersion: null,
      error: null,
      commentExternalId: null,
      claimedBy: null,
      claimedAt: null,
      promptVersion,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.aiReviews.organizationId, organizationId),
        eq(schema.aiReviews.id, id),
        sql`${schema.aiReviews.status} <> 'pending'`,
      ),
    )
    .returning();
  return row;
}

export interface ListReviewsFilter {
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Org-scoped, newest first, paginated — same shape as `listActivity`. */
export function listReviewsForWorkItem(
  db: Database,
  organizationId: string,
  workItemId: string,
  filter: ListReviewsFilter = {},
): Promise<AiReviewRow[]> {
  return db
    .select()
    .from(schema.aiReviews)
    .where(
      and(
        eq(schema.aiReviews.organizationId, organizationId),
        eq(schema.aiReviews.workItemId, workItemId),
      ),
    )
    .orderBy(desc(schema.aiReviews.createdAt))
    .limit(Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT))
    .offset(filter.offset ?? 0);
}
