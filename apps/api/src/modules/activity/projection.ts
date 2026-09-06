import type { InsertActivityInput } from './dal/activity.dal';

/** The domain-event essentials the projector needs (design §7). */
export interface ProjectionEvent {
  eventId: string;
  type: string;
  organizationId: string;
  aggregateId: string;
  correlationId: string;
  occurredAt: string;
  payload?: unknown;
}

type ActorType = 'user' | 'system' | 'external';

interface Line {
  workItemId?: string | null;
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  summary: string;
  metadata?: unknown;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return (payload ?? {}) as Record<string, unknown>;
}

/**
 * Pure event → activity-line projection. Provenance (`actorType`) is derived
 * from the event: DevFlow user actions are `user`, workflow automation is
 * `system`, reconciled external changes are `external` (design §7).
 */
function toLine(event: ProjectionEvent): Line {
  const p = asRecord(event.payload);
  const workItemId = (p.workItemId as string | undefined) ?? event.aggregateId;

  switch (event.type) {
    case 'workitem.created':
      return {
        workItemId,
        actorType: 'user',
        action: 'workitem.created',
        summary: 'Work item created',
      };

    case 'workitem.state_changed': {
      const reason = p.reason as string | undefined;
      return {
        workItemId,
        actorType: reason === 'reconciliation' ? 'external' : 'user',
        action: 'workitem.state_changed',
        summary: `State changed from ${String(p.from)} to ${String(p.to)}`,
        metadata: { from: p.from, to: p.to, reason: p.reason, trigger: p.trigger },
      };
    }

    case 'devworkflow.work_started':
      return {
        workItemId,
        actorType: 'user',
        actorId: (p.actorUserId as string | undefined) ?? null,
        action: 'devworkflow.work_started',
        summary: 'Work started',
      };

    case 'devworkflow.branch_created':
      return {
        workItemId,
        actorType: 'system',
        action: 'devworkflow.branch_created',
        summary: `Branch ${String(p.branch)} created`,
        metadata: { repo: p.repo, branch: p.branch },
      };

    case 'devworkflow.pull_request_opened':
      return {
        workItemId,
        actorType: 'system',
        action: 'devworkflow.pull_request_opened',
        summary: `Pull request #${String(p.number)} opened`,
        metadata: { repo: p.repo, number: p.number, url: p.url },
      };

    case 'devworkflow.workflow_failed':
      return {
        workItemId,
        actorType: 'system',
        action: 'devworkflow.workflow_failed',
        summary: `Automation failed at ${String(p.step)}`,
        metadata: { step: p.step, error: p.error },
      };

    case 'workitem.reconciled':
      return {
        workItemId: (p.workItemId as string | null) ?? null,
        actorType: 'external',
        action: p.anomaly ? 'reconciliation.anomaly' : 'workitem.reconciled',
        summary: String(p.detail ?? 'Reconciled from an external change'),
        metadata: { source: p.source, anomaly: p.anomaly },
      };

    default:
      return {
        workItemId,
        actorType: 'system',
        action: event.type,
        summary: event.type,
      };
  }
}

export function projectActivity(event: ProjectionEvent): InsertActivityInput {
  const line = toLine(event);
  return {
    organizationId: event.organizationId,
    workItemId: line.workItemId ?? null,
    actorType: line.actorType,
    actorId: line.actorId ?? null,
    action: line.action,
    summary: line.summary,
    metadata: line.metadata,
    correlationId: event.correlationId,
    sourceEventId: event.eventId,
    occurredAt: new Date(event.occurredAt),
  };
}

/** The DevFlow event types the timeline surfaces (routed to the projector, §5). */
export const ACTIVITY_EVENT_TYPES = [
  'workitem.created',
  'workitem.state_changed',
  'devworkflow.work_started',
  'devworkflow.branch_created',
  'devworkflow.pull_request_opened',
  'devworkflow.workflow_failed',
  'workitem.reconciled',
] as const;
