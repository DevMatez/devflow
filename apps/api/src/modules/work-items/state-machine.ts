import type { WorkflowState } from '@devflow/types';

/**
 * Pure work-item state machine (Wave 3 design §3.2). Two distinct entry
 * points: `applyActorTransition` (guarded user/engine edges) and
 * `applyReconciliation` (external-event jumps that are never rejected). No
 * I/O — callers persist the returned view and emit the domain event.
 */

export const TERMINAL_STATES = ['done', 'cancelled'] as const;
export const ACTIVE_STATES = ['backlog', 'todo', 'in_progress', 'in_review'] as const;

/** States from which BLOCKED is reachable / that may populate `blockedFromState` (§3.2 invariants). */
const BLOCKABLE: readonly WorkflowState[] = ['in_progress', 'in_review'];
/** States an actor may cancel from (any non-terminal). */
const CANCELLABLE: readonly WorkflowState[] = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'blocked',
];

/** Guarded forward edges for a generic actor `advance` (excludes block/unblock/cancel, handled separately). */
const ACTOR_ADVANCE_EDGES: Record<WorkflowState, readonly WorkflowState[]> = {
  backlog: ['todo'],
  todo: ['in_progress'],
  in_progress: ['in_review'],
  in_review: ['done', 'in_progress'],
  blocked: [],
  done: [],
  cancelled: [],
};

export function isTerminal(state: WorkflowState): boolean {
  return state === 'done' || state === 'cancelled';
}

/** The two persisted state columns the machine reasons over. */
export interface WorkItemStateView {
  workflowState: WorkflowState;
  blockedFromState: WorkflowState | null;
}

export type ActorAction =
  | { type: 'advance'; to: WorkflowState }
  | { type: 'block' }
  | { type: 'unblock' }
  | { type: 'cancel' };

export type ReconciliationTrigger =
  | { kind: 'pr_opened' }
  | { kind: 'pr_merged' }
  | { kind: 'pr_closed_unmerged' }
  | { kind: 'pr_reopened' }
  | { kind: 'issue_completed'; prOpen: boolean }
  | { kind: 'issue_cancelled' }
  | { kind: 'issue_reopened'; hasBranch: boolean };

export interface TransitionOk {
  ok: true;
  state: WorkItemStateView;
  from: WorkflowState;
  to: WorkflowState;
  reason: 'actor' | 'reconciliation';
  /** Short trigger label for the `workitem.state_changed` event payload. */
  trigger: string;
  /** Reconciliation only: a surprising-but-applied jump surfaced on the timeline (§6.3). */
  anomaly: boolean;
}

export interface TransitionError {
  ok: false;
  error: 'invalid_transition';
  from: WorkflowState;
  to?: WorkflowState;
}

export type TransitionResult = TransitionOk | TransitionError;

/** `blockedFromState` is non-null iff `workflowState === 'blocked'` — every non-blocked target clears it. */
function toState(
  from: WorkflowState,
  to: WorkflowState,
  reason: 'actor' | 'reconciliation',
  trigger: string,
  anomaly: boolean,
  blockedFromState: WorkflowState | null,
): TransitionOk {
  return {
    ok: true,
    state: { workflowState: to, blockedFromState: to === 'blocked' ? blockedFromState : null },
    from,
    to,
    reason,
    trigger,
    anomaly,
  };
}

export function applyActorTransition(
  view: WorkItemStateView,
  action: ActorAction,
): TransitionResult {
  const from = view.workflowState;

  switch (action.type) {
    case 'advance': {
      const to = action.to;
      if (ACTOR_ADVANCE_EDGES[from].includes(to)) {
        return toState(from, to, 'actor', `advance:${to}`, false, null);
      }
      return { ok: false, error: 'invalid_transition', from, to };
    }
    case 'block': {
      if (BLOCKABLE.includes(from)) {
        return toState(from, 'blocked', 'actor', 'block', false, from);
      }
      return { ok: false, error: 'invalid_transition', from, to: 'blocked' };
    }
    case 'unblock': {
      if (from === 'blocked' && view.blockedFromState) {
        return toState(from, view.blockedFromState, 'actor', 'unblock', false, null);
      }
      return {
        ok: false,
        error: 'invalid_transition',
        from,
        to: view.blockedFromState ?? undefined,
      };
    }
    case 'cancel': {
      if (CANCELLABLE.includes(from)) {
        return toState(from, 'cancelled', 'actor', 'cancel', false, null);
      }
      return { ok: false, error: 'invalid_transition', from, to: 'cancelled' };
    }
  }
}

/**
 * Reconciliation jumps are **never rejected** (§3.2). A non-terminal external
 * event that arrives against a terminal state does not regress it (the §6.4
 * cursor is the real ordering guard); such a case stays put and is flagged as
 * an anomaly. Only explicit reopen triggers move an item out of a terminal state.
 */
export function applyReconciliation(
  view: WorkItemStateView,
  trigger: ReconciliationTrigger,
): TransitionOk {
  const from = view.workflowState;
  const terminal = isTerminal(from);
  const stay = (anomaly: boolean): TransitionOk => ({
    ok: true,
    state: view,
    from,
    to: from,
    reason: 'reconciliation',
    trigger: trigger.kind,
    anomaly,
  });

  switch (trigger.kind) {
    case 'pr_opened':
      if (terminal) return stay(true);
      return toState(from, 'in_review', 'reconciliation', trigger.kind, false, null);

    case 'pr_merged':
      if (from === 'done') return stay(false); // idempotent redelivery
      return toState(from, 'done', 'reconciliation', trigger.kind, from === 'cancelled', null);

    case 'pr_closed_unmerged':
      // Never forces the item back; records the surprise (§6.3).
      return stay(true);

    case 'pr_reopened':
      return toState(from, 'in_progress', 'reconciliation', trigger.kind, terminal, null);

    case 'issue_completed':
      if (from === 'done') return stay(false);
      if (from === 'cancelled')
        return toState(from, 'done', 'reconciliation', trigger.kind, true, null);
      return toState(from, 'done', 'reconciliation', trigger.kind, trigger.prOpen, null);

    case 'issue_cancelled':
      if (from === 'cancelled') return stay(false);
      if (from === 'done') return stay(true); // don't regress a completed workflow
      return toState(from, 'cancelled', 'reconciliation', trigger.kind, false, null);

    case 'issue_reopened':
      return toState(
        from,
        trigger.hasBranch ? 'in_progress' : 'todo',
        'reconciliation',
        trigger.kind,
        terminal,
        null,
      );
  }
}
