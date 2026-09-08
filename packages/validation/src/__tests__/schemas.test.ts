import { describe, expect, it } from 'vitest';
import {
  roleSchema,
  prioritySchema,
  slugSchema,
  uuidSchema,
  invitationStatusSchema,
  normalizeSlug,
  workflowConfigSchema,
} from '../index';

describe('validation schemas', () => {
  it('accepts a valid role and rejects an unknown one', () => {
    expect(roleSchema.parse('admin')).toBe('admin');
    expect(roleSchema.safeParse('superadmin').success).toBe(false);
  });

  it('accepts a valid priority', () => {
    expect(prioritySchema.parse('urgent')).toBe('urgent');
  });

  it('validates slugs', () => {
    expect(slugSchema.safeParse('devflow-core').success).toBe(true);
    expect(slugSchema.safeParse('Not A Slug').success).toBe(false);
  });

  it('validates uuids', () => {
    expect(uuidSchema.safeParse('3f333df6-90a4-4fda-8dd3-9485d27cee36').success).toBe(true);
    expect(uuidSchema.safeParse('nope').success).toBe(false);
  });

  it('validates invitation statuses', () => {
    expect(invitationStatusSchema.parse('pending')).toBe('pending');
    expect(invitationStatusSchema.safeParse('deleted').success).toBe(false);
  });

  it('normalizes arbitrary names into canonical slugs', () => {
    expect(normalizeSlug('Acme Engineering')).toBe('acme-engineering');
    expect(normalizeSlug('  Héllo,  World!  ')).toBe('hello-world');
    expect(normalizeSlug('ALL__CAPS')).toBe('all-caps');
    // A normalized slug always satisfies the strict slug schema.
    expect(slugSchema.safeParse(normalizeSlug('Some Project 2')).success).toBe(true);
  });

  it('applies workflow-config defaults and pins version 1', () => {
    const parsed = workflowConfigSchema.parse({});
    expect(parsed.version).toBe(1);
    expect(parsed.reviewPolicy.requiredApprovals).toBe(1);
    expect(parsed.reviewPolicy.requireAiReview).toBe(true);
    expect(parsed.branchNamingPattern.length).toBeGreaterThan(0);
  });

  it('rejects an unknown workflow-config version', () => {
    expect(workflowConfigSchema.safeParse({ version: 2 }).success).toBe(false);
  });
});
