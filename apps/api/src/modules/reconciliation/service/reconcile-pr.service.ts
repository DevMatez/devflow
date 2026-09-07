import { randomUUID } from 'node:crypto';
import { type Database } from '@devflow/database';
import { publishOutbox } from '@devflow/events';
import type { PullRequest } from '@devflow/integrations-core';
import {
  applyReconciliation,
  isTerminal,
  type ReconciliationTrigger,
} from '../../work-items/state-machine';
import { WorkItemStateChanged, WorkItemReconciled } from '../../work-items/events';
import {
  applyStateChange,
  lockWorkItemForPrEvent,
  setPrRef,
  type WorkItemRow,
} from '../../work-items/dal/work-items.dal';

const SOURCE = 'github';

export type PrEventKind = 'opened' | 'updated' | 'merged' | 'closed';

/**
 * Derives the reconciliation trigger for a PR event (design §6.3). GitHub's
 * `reopened` action has no distinct canonical type — it arrives as `updated`
 * with an open PR, so a reopen is detected by the work item already being
 * terminal. Idempotency keys off `pr_ref`'s last-seen state (§6.3), not a
 * cross-system timestamp cursor (kept separate from the issue-side
 * `last_external_version`, which is Plane's clock, not GitHub's).
 */
function prTrigger(
  kind: PrEventKind,
  pr: PullRequest,
  existing: WorkItemRow,
): ReconciliationTrigger | null {
  switch (kind) {
    case 'opened':
      return { kind: 'pr_opened' };
    case 'merged':
      return { kind: 'pr_merged' };
    case 'closed':
      return { kind: 'pr_closed_unmerged' };
    case 'updated':
      if (pr.state === 'open' && isTerminal(existing.workflowState)) {
        return { kind: 'pr_reopened' };
      }
      return null; // ordinary edit/synchronize — pointer refresh only, no state jump
  }
}

async function emitReconciled(
  db: Parameters<typeof publishOutbox>[0],
  organizationId: string,
  workItemId: string | null,
  aggregateId: string,
  anomaly: boolean,
  detail: string,
  correlationId: string,
): Promise<void> {
  await publishOutbox(
    db,
    WorkItemReconciled.create({
      organizationId,
      aggregateId,
      correlationId,
      payload: { workItemId, source: SOURCE, anomaly, detail },
    }),
  );
}

/**
 * Reconciles an inbound `sourcecontrol.pull_request.*` event into DevFlow
 * (design §6.1, §6.3). Matches by `pr_ref` first, falls back to the head
 * branch for the first `opened` before `pr_ref` is set. An event for a PR
 * DevFlow doesn't track is recorded as an anomaly with `workItemId = null`
 * (§6.1) — never silently dropped, never retroactively bound (§6.1).
 */
export async function reconcilePrEvent(
  db: Database,
  organizationId: string,
  kind: PrEventKind,
  pr: PullRequest,
  correlationId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const existing = await lockWorkItemForPrEvent(
      tx,
      organizationId,
      pr.repo,
      pr.number,
      pr.headRef,
    );

    if (!existing) {
      // No aggregate to anchor to — the outbox requires a uuid, so mint one for this orphan record.
      await emitReconciled(
        tx,
        organizationId,
        null,
        randomUUID(),
        true,
        `PR ${pr.repo}#${pr.number} has no matching work item`,
        correlationId,
      );
      return;
    }

    // A stale/out-of-order event (e.g. a delayed "closed unmerged" arriving after
    // we've already recorded the merge) must not corrupt the pr_ref pointer's
    // cached state back to something older than what we know happened. The
    // state machine independently protects workflow_state from regressing;
    // this guard protects the pointer itself.
    const staleAgainstRecordedMerge =
      existing.prRef?.state === 'merged' && kind !== 'merged' && pr.state !== 'merged';

    await setPrRef(tx, organizationId, existing.id, {
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      state: staleAgainstRecordedMerge ? existing.prRef!.state : pr.state,
    });

    if (staleAgainstRecordedMerge) {
      await emitReconciled(
        tx,
        organizationId,
        existing.id,
        existing.id,
        true,
        'stale PR event ignored (already recorded as merged)',
        correlationId,
      );
      return;
    }

    const trigger = prTrigger(kind, pr, existing);
    if (!trigger) return; // ordinary edit/synchronize: pointer refreshed above, no reconciliation jump

    const result = applyReconciliation(
      { workflowState: existing.workflowState, blockedFromState: existing.blockedFromState },
      trigger,
    );

    if (result.to !== existing.workflowState) {
      const updated = await applyStateChange(tx, organizationId, existing.id, result.state);
      if (updated) {
        await publishOutbox(
          tx,
          WorkItemStateChanged.create({
            organizationId,
            aggregateId: existing.id,
            correlationId,
            aggregateVersion: updated.version,
            payload: {
              workItemId: existing.id,
              from: result.from,
              to: result.to,
              reason: 'reconciliation',
              trigger: trigger.kind,
            },
          }),
        );
      }
    }

    await emitReconciled(
      tx,
      organizationId,
      existing.id,
      existing.id,
      result.anomaly,
      `PR ${pr.repo}#${pr.number} ${kind}`,
      correlationId,
    );
  });
}
