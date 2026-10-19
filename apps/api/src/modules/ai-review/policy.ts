import type { CodeReviewFinding } from '@devflow/ai';

export type PolicyConclusion = 'success' | 'failure';

/**
 * The deterministic merge-gate policy (design §5.4) — the entire enforcement
 * boundary. Only a `critical` finding fails the check; everything upstream
 * (the model call, the schema) only produces data.
 */
export function policyConclusion(
  findings: readonly Pick<CodeReviewFinding, 'severity'>[],
): PolicyConclusion {
  return findings.some((f) => f.severity === 'critical') ? 'failure' : 'success';
}
