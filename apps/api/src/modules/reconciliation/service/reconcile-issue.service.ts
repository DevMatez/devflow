import { schema, type Database, type DatabaseTransaction } from '@devflow/database';
import { eq } from 'drizzle-orm';
import { publishOutbox } from '@devflow/events';
import type { NormalizedIssueEvent } from '@devflow/integrations-core';
import {
  applyReconciliation,
  isTerminal,
  type ReconciliationTrigger,
} from '../../work-items/state-machine';
import { WorkItemCreated, WorkItemStateChanged, WorkItemReconciled } from '../../work-items/events';
import {
  applyStateChange,
  createWorkItem,
  lockWorkItemByExternalIssue,
  updateWorkItemMirror,
  type WorkItemRow,
} from '../../work-items/dal/work-items.dal';

const PROVIDER = 'plane';

/** The org's single project, used to bind an externally-authored issue (MVP; multi-project is skipped). */
async function resolveDefaultProject(
  tx: DatabaseTransaction,
  organizationId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.organizationId, organizationId))
    .limit(2);
  return rows.length === 1 ? rows[0]!.id : null;
}

function issueTrigger(
  event: NormalizedIssueEvent,
  existing: WorkItemRow,
): ReconciliationTrigger | null {
  if (event.statusClass === 'completed') {
    return { kind: 'issue_completed', prOpen: existing.prRef?.state === 'open' };
  }
  if (event.statusClass === 'cancelled') {
    return { kind: 'issue_cancelled' };
  }
  // open: only meaningful as a reopen out of a terminal state.
  if (isTerminal(existing.workflowState)) {
    return { kind: 'issue_reopened', hasBranch: Boolean(existing.branchRef) };
  }
  return null;
}

async function emitReconciled(
  tx: DatabaseTransaction,
  organizationId: string,
  workItemId: string | null,
  anomaly: boolean,
  detail: string,
  correlationId: string,
  aggregateId: string,
): Promise<void> {
  await publishOutbox(
    tx,
    WorkItemReconciled.create({
      organizationId,
      aggregateId,
      correlationId,
      payload: { workItemId, source: PROVIDER, anomaly, detail },
    }),
  );
}

async function bindExisting(
  tx: DatabaseTransaction,
  organizationId: string,
  event: NormalizedIssueEvent,
  correlationId: string,
): Promise<void> {
  const projectId = await resolveDefaultProject(tx, organizationId);
  if (!projectId) return; // multi/zero-project org: can't bind without a project mapping (MVP limitation)

  const row = await createWorkItem(tx, {
    organizationId,
    projectId,
    title: event.title,
    externalProvider: PROVIDER,
    externalIssueId: event.externalId,
    externalIssueKey: event.key,
    externalIssueUrl: event.url,
    externalAssigneeId: event.assigneeExternalId,
    lastExternalVersion: event.updatedAt,
  });

  await publishOutbox(
    tx,
    WorkItemCreated.create({
      organizationId,
      aggregateId: row.id,
      correlationId,
      aggregateVersion: row.version,
      payload: { workItemId: row.id, projectId, externalKey: row.externalIssueKey },
    }),
  );
  await emitReconciled(
    tx,
    organizationId,
    row.id,
    false,
    'bound from external issue',
    correlationId,
    row.id,
  );
}

/**
 * Reconciles an inbound PM issue event into DevFlow (design §6.2). Per-item
 * `FOR UPDATE` lock + cursor ordering; updates mirror columns (never writes
 * back to the provider), and drives a reconciliation jump on a status-class
 * change. Idempotent: absolute-value mirror writes + the cursor make a
 * replay/stale delivery a no-op.
 */
export async function reconcileIssueEvent(
  db: Database,
  organizationId: string,
  event: NormalizedIssueEvent,
  isCreated: boolean,
  correlationId: string,
): Promise<void> {
  if (!event.externalId) return;

  await db.transaction(async (tx) => {
    const existing = await lockWorkItemByExternalIssue(
      tx,
      organizationId,
      PROVIDER,
      event.externalId,
    );

    if (!existing) {
      if (isCreated) await bindExisting(tx, organizationId, event, correlationId);
      return;
    }

    const isStale =
      Boolean(existing.lastExternalVersion) &&
      Boolean(event.updatedAt) &&
      event.updatedAt! < existing.lastExternalVersion!;

    const newCursor =
      event.updatedAt &&
      (!existing.lastExternalVersion || event.updatedAt >= existing.lastExternalVersion)
        ? event.updatedAt
        : existing.lastExternalVersion;

    await updateWorkItemMirror(tx, organizationId, existing.id, {
      title: event.title || existing.title,
      externalAssigneeId: event.assigneeExternalId,
      lastExternalVersion: newCursor,
    });

    const trigger = issueTrigger(event, existing);
    if (!trigger) return;

    // Terminal-regression guard (§6.4): a provably-older event can't un-finish a terminal item.
    const wouldLeaveTerminal =
      isTerminal(existing.workflowState) && trigger.kind === 'issue_reopened';
    if (isStale && wouldLeaveTerminal) {
      await emitReconciled(
        tx,
        organizationId,
        existing.id,
        true,
        'stale reopen ignored (terminal-regression guard)',
        correlationId,
        existing.id,
      );
      return;
    }

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
      result.anomaly,
      `issue ${event.statusClass}`,
      correlationId,
      existing.id,
    );
  });
}
