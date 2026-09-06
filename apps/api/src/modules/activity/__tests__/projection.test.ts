import { describe, expect, it } from 'vitest';
import { projectActivity, type ProjectionEvent } from '../projection';

function event(
  type: string,
  payload: unknown,
  overrides: Partial<ProjectionEvent> = {},
): ProjectionEvent {
  return {
    eventId: 'event-1',
    type,
    organizationId: 'org-1',
    aggregateId: 'wi-1',
    correlationId: 'corr-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    payload,
    ...overrides,
  };
}

describe('activity projection', () => {
  it('carries the event id as the idempotency key and the correlation id through', () => {
    const row = projectActivity(
      event('workitem.created', { workItemId: 'wi-1', projectId: 'p-1' }),
    );
    expect(row.sourceEventId).toBe('event-1');
    expect(row.correlationId).toBe('corr-1');
    expect(row.organizationId).toBe('org-1');
    expect(row.occurredAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
  });

  it('projects workitem.created as a user action', () => {
    const row = projectActivity(event('workitem.created', { workItemId: 'wi-1' }));
    expect(row).toMatchObject({
      actorType: 'user',
      action: 'workitem.created',
      workItemId: 'wi-1',
    });
  });

  it('derives provenance from a state change reason', () => {
    const actor = projectActivity(
      event('workitem.state_changed', {
        workItemId: 'wi-1',
        from: 'todo',
        to: 'in_progress',
        reason: 'actor',
        trigger: 'advance:in_progress',
      }),
    );
    expect(actor.actorType).toBe('user');
    expect(actor.summary).toBe('State changed from todo to in_progress');

    const reconciled = projectActivity(
      event('workitem.state_changed', {
        workItemId: 'wi-1',
        from: 'in_review',
        to: 'done',
        reason: 'reconciliation',
        trigger: 'pr_merged',
      }),
    );
    expect(reconciled.actorType).toBe('external');
  });

  it('projects a reconciliation anomaly with the anomaly action', () => {
    const row = projectActivity(
      event('workitem.reconciled', {
        workItemId: 'wi-1',
        source: 'github',
        anomaly: true,
        detail: 'PR closed without merge',
      }),
    );
    expect(row).toMatchObject({
      actorType: 'external',
      action: 'reconciliation.anomaly',
      summary: 'PR closed without merge',
    });
  });

  it('keeps a null workItemId for an unmatched reconciliation', () => {
    const row = projectActivity(
      event(
        'workitem.reconciled',
        { workItemId: null, source: 'github', anomaly: true, detail: 'Unknown PR' },
        { aggregateId: 'pr-9' },
      ),
    );
    expect(row.workItemId).toBeNull();
  });

  it('projects workflow automation events as system provenance', () => {
    expect(
      projectActivity(
        event('devworkflow.work_started', { workItemId: 'wi-1', actorUserId: 'u-1' }),
      ),
    ).toMatchObject({
      actorType: 'user',
      actorId: 'u-1',
    });
    expect(
      projectActivity(
        event('devworkflow.branch_created', { workItemId: 'wi-1', repo: 'r', branch: 'feature/x' }),
      ),
    ).toMatchObject({
      actorType: 'system',
      summary: 'Branch feature/x created',
    });
    expect(
      projectActivity(event('devworkflow.pull_request_opened', { workItemId: 'wi-1', number: 7 })),
    ).toMatchObject({
      actorType: 'system',
      summary: 'Pull request #7 opened',
    });
  });
});
