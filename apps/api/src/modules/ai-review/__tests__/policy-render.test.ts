import { describe, expect, it } from 'vitest';
import type { CodeReviewFinding } from '@devflow/ai';
import { policyConclusion } from '../policy';
import { renderCheckOutput, renderSummaryComment } from '../render';
import type { AiReviewRow } from '../dal/ai-reviews.dal';

const f = (severity: CodeReviewFinding['severity']) => ({ severity });

describe('policyConclusion', () => {
  it.each([
    [[], 'success'],
    [[f('low')], 'success'],
    [[f('low'), f('medium'), f('high')], 'success'],
    [[f('critical')], 'failure'],
    [[f('low'), f('critical'), f('high')], 'failure'],
  ] as const)('%j → %s', (findings, expected) => {
    expect(policyConclusion(findings)).toBe(expected);
  });
});

function review(overrides: Partial<AiReviewRow> = {}): AiReviewRow {
  return {
    id: 'r1',
    organizationId: 'o1',
    workItemId: 'w1',
    repo: 'acme/widgets',
    prNumber: 7,
    headSha: 'abcdef1234567',
    status: 'completed',
    policyConclusion: 'success',
    summary: 'Summary.',
    findings: [],
    rulesVersion: null,
    promptVersion: 'review-v1',
    model: 'm',
    provider: 'anthropic',
    checkRunExternalId: null,
    commentExternalId: null,
    error: null,
    claimedBy: null,
    claimedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('render', () => {
  it('groups findings by severity and neutralizes @mentions from model output', () => {
    const findings: CodeReviewFinding[] = [
      { id: '1', source: 'ai', severity: 'low', file: 'a.ts', title: 'Nit', explanation: 'x' },
      {
        id: '2',
        source: 'ai',
        severity: 'critical',
        file: 'b.ts',
        line: 4,
        title: 'Ping @octocat',
        explanation: 'cc @acme/security',
      },
    ];
    const body = renderSummaryComment(review({ findings, policyConclusion: 'failure' }));

    expect(body.indexOf('Critical')).toBeLessThan(body.indexOf('Low'));
    expect(body).toContain('`b.ts:4`');
    expect(body).not.toMatch(/@octocat|@acme/);
    expect(body).toContain('abcdef1');
  });

  it('describes a failed review as non-blocking', () => {
    const out = renderCheckOutput(review({ status: 'failed', policyConclusion: null }));
    expect(out.title).toBe('AI review unavailable');
    expect(out.summary).toContain('does not block merge');
  });
});
