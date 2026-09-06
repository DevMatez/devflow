import { describe, expect, it } from 'vitest';
import { WORKFLOW_STATES, type WorkflowState } from '@devflow/types';
import {
  applyActorTransition,
  applyReconciliation,
  isTerminal,
  type ReconciliationTrigger,
  type WorkItemStateView,
} from '../state-machine';

const view = (
  workflowState: WorkflowState,
  blockedFromState: WorkflowState | null = null,
): WorkItemStateView => ({ workflowState, blockedFromState });

/** The one true edge set, duplicated here so the test fails if the machine drifts. */
const LEGAL_ADVANCE: Record<WorkflowState, WorkflowState[]> = {
  backlog: ['todo'],
  todo: ['in_progress'],
  in_progress: ['in_review'],
  in_review: ['done', 'in_progress'],
  blocked: [],
  done: [],
  cancelled: [],
};

describe('state machine — actor advance edges (exhaustive)', () => {
  for (const from of WORKFLOW_STATES) {
    for (const to of WORKFLOW_STATES) {
      const legal = LEGAL_ADVANCE[from].includes(to);
      it(`${from} -> ${to} is ${legal ? 'accepted' : 'rejected'}`, () => {
        const result = applyActorTransition(view(from), { type: 'advance', to });
        if (legal) {
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.state.workflowState).toBe(to);
            expect(result.state.blockedFromState).toBeNull();
            expect(result.reason).toBe('actor');
            expect(result.anomaly).toBe(false);
          }
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error).toBe('invalid_transition');
        }
      });
    }
  }
});

describe('state machine — block / unblock', () => {
  it('blocks from in_progress and captures blockedFromState', () => {
    const result = applyActorTransition(view('in_progress'), { type: 'block' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.workflowState).toBe('blocked');
      expect(result.state.blockedFromState).toBe('in_progress');
    }
  });

  it('blocks from in_review and captures blockedFromState', () => {
    const result = applyActorTransition(view('in_review'), { type: 'block' });
    expect(result.ok && result.state.blockedFromState).toBe('in_review');
  });

  it('rejects block from non-blockable states', () => {
    for (const from of ['backlog', 'todo', 'blocked', 'done', 'cancelled'] as WorkflowState[]) {
      expect(applyActorTransition(view(from), { type: 'block' }).ok).toBe(false);
    }
  });

  it('unblock restores blockedFromState and clears the column', () => {
    const result = applyActorTransition(view('blocked', 'in_review'), { type: 'unblock' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.workflowState).toBe('in_review');
      expect(result.state.blockedFromState).toBeNull();
    }
  });

  it('rejects unblock when not blocked, and when blocked without a captured state', () => {
    expect(applyActorTransition(view('in_progress'), { type: 'unblock' }).ok).toBe(false);
    expect(applyActorTransition(view('blocked', null), { type: 'unblock' }).ok).toBe(false);
  });

  it('does not overwrite the original blockedFromState (block while blocked is rejected)', () => {
    const result = applyActorTransition(view('blocked', 'in_review'), { type: 'block' });
    expect(result.ok).toBe(false);
  });
});

describe('state machine — cancel', () => {
  it('cancels from any non-terminal state and clears blockedFromState', () => {
    for (const from of [
      'backlog',
      'todo',
      'in_progress',
      'in_review',
      'blocked',
    ] as WorkflowState[]) {
      const result = applyActorTransition(view(from, from === 'blocked' ? 'in_review' : null), {
        type: 'cancel',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.workflowState).toBe('cancelled');
        expect(result.state.blockedFromState).toBeNull();
      }
    }
  });

  it('rejects cancel from terminal states', () => {
    expect(applyActorTransition(view('done'), { type: 'cancel' }).ok).toBe(false);
    expect(applyActorTransition(view('cancelled'), { type: 'cancel' }).ok).toBe(false);
  });
});

describe('state machine — reconciliation jumps (never rejected)', () => {
  const cases: Array<{
    name: string;
    from: WorkflowState;
    trigger: ReconciliationTrigger;
    to: WorkflowState;
    anomaly: boolean;
  }> = [
    {
      name: 'pr_opened advances to review',
      from: 'in_progress',
      trigger: { kind: 'pr_opened' },
      to: 'in_review',
      anomaly: false,
    },
    {
      name: 'pr_opened on terminal stays + anomaly',
      from: 'done',
      trigger: { kind: 'pr_opened' },
      to: 'done',
      anomaly: true,
    },
    {
      name: 'pr_merged completes',
      from: 'in_review',
      trigger: { kind: 'pr_merged' },
      to: 'done',
      anomaly: false,
    },
    {
      name: 'pr_merged redelivery on done is a no-op',
      from: 'done',
      trigger: { kind: 'pr_merged' },
      to: 'done',
      anomaly: false,
    },
    {
      name: 'pr_merged after cancel is an anomaly',
      from: 'cancelled',
      trigger: { kind: 'pr_merged' },
      to: 'done',
      anomaly: true,
    },
    {
      name: 'pr_closed_unmerged stays + anomaly',
      from: 'in_progress',
      trigger: { kind: 'pr_closed_unmerged' },
      to: 'in_progress',
      anomaly: true,
    },
    {
      name: 'pr_reopened from done -> in_progress + anomaly',
      from: 'done',
      trigger: { kind: 'pr_reopened' },
      to: 'in_progress',
      anomaly: true,
    },
    {
      name: 'issue_completed with open PR is an anomaly',
      from: 'in_review',
      trigger: { kind: 'issue_completed', prOpen: true },
      to: 'done',
      anomaly: true,
    },
    {
      name: 'issue_completed with no open PR is clean',
      from: 'in_progress',
      trigger: { kind: 'issue_completed', prOpen: false },
      to: 'done',
      anomaly: false,
    },
    {
      name: 'issue_cancelled cancels',
      from: 'todo',
      trigger: { kind: 'issue_cancelled' },
      to: 'cancelled',
      anomaly: false,
    },
    {
      name: 'issue_cancelled does not regress a done item',
      from: 'done',
      trigger: { kind: 'issue_cancelled' },
      to: 'done',
      anomaly: true,
    },
    {
      name: 'issue_reopened with branch -> in_progress',
      from: 'done',
      trigger: { kind: 'issue_reopened', hasBranch: true },
      to: 'in_progress',
      anomaly: true,
    },
    {
      name: 'issue_reopened without branch -> todo',
      from: 'cancelled',
      trigger: { kind: 'issue_reopened', hasBranch: false },
      to: 'todo',
      anomaly: true,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const result = applyReconciliation(view(c.from), c.trigger);
      expect(result.ok).toBe(true);
      expect(result.to).toBe(c.to);
      expect(result.anomaly).toBe(c.anomaly);
      expect(result.reason).toBe('reconciliation');
      // Invariant: blockedFromState is non-null only while blocked.
      if (result.state.workflowState !== 'blocked') {
        expect(result.state.blockedFromState).toBeNull();
      }
    });
  }

  it('clears blockedFromState when a blocked item is merged out-of-band', () => {
    const result = applyReconciliation(view('blocked', 'in_review'), { kind: 'pr_merged' });
    expect(result.to).toBe('done');
    expect(result.state.blockedFromState).toBeNull();
  });
});

describe('state machine — helpers', () => {
  it('isTerminal only for done and cancelled', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('cancelled')).toBe(true);
    for (const s of ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'] as WorkflowState[]) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});
