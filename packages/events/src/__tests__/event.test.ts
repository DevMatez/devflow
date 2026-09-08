import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineEvent } from '../event';

const WorkItemStarted = defineEvent({
  type: 'work-item.started',
  schemaVersion: 1,
  schema: z.object({ title: z.string() }),
});

const WorkItemMerged = defineEvent({
  type: 'work-item.merged',
  schemaVersion: 1,
  schema: z.object({ prId: z.string() }),
  ordering: 'aggregate',
});

describe('defineEvent', () => {
  it('creates an event stamped with id, occurredAt, and schemaVersion', () => {
    const event = WorkItemStarted.create({
      organizationId: 'org-1',
      aggregateId: 'wi-1',
      correlationId: 'corr-1',
      payload: { title: 'Fix bug' },
    });

    expect(event.type).toBe('work-item.started');
    expect(event.schemaVersion).toBe(1);
    expect(event.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
    expect(event.payload).toEqual({ title: 'Fix bug' });
  });

  it('generates a unique id per event', () => {
    const a = WorkItemStarted.create({
      organizationId: 'org-1',
      aggregateId: 'wi-1',
      correlationId: 'corr-1',
      payload: { title: 'A' },
    });
    const b = WorkItemStarted.create({
      organizationId: 'org-1',
      aggregateId: 'wi-1',
      correlationId: 'corr-1',
      payload: { title: 'B' },
    });

    expect(a.id).not.toBe(b.id);
  });

  it('validates the payload against the schema', () => {
    expect(() =>
      WorkItemStarted.create({
        organizationId: 'org-1',
        aggregateId: 'wi-1',
        correlationId: 'corr-1',
        // @ts-expect-error invalid payload on purpose
        payload: { title: 123 },
      }),
    ).toThrow();
  });

  it('requires aggregateVersion when ordering is "aggregate"', () => {
    expect(() =>
      WorkItemMerged.create({
        organizationId: 'org-1',
        aggregateId: 'wi-1',
        correlationId: 'corr-1',
        payload: { prId: 'pr-1' },
      }),
    ).toThrow(/aggregateVersion/);
  });

  it('accepts aggregateVersion when provided for ordering: aggregate', () => {
    const event = WorkItemMerged.create({
      organizationId: 'org-1',
      aggregateId: 'wi-1',
      correlationId: 'corr-1',
      aggregateVersion: 3,
      payload: { prId: 'pr-1' },
    });

    expect(event.aggregateVersion).toBe(3);
  });

  it('defaults ordering to "none"', () => {
    expect(WorkItemStarted.ordering).toBe('none');
    expect(WorkItemMerged.ordering).toBe('aggregate');
  });
});
