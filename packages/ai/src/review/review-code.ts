import { createHash } from 'node:crypto';
import type { AiProvider, AiResult } from '../provider';
import { buildReviewRequest } from './prompts';
import {
  ModelReviewOutputSchema,
  type CodeReviewFinding,
  type CodeReviewResult,
  type ModelReviewOutput,
  type ReviewCodeInput,
} from './types';

/** Upper bound on review output; large diffs can yield long finding lists. */
const REVIEW_MAX_OUTPUT_TOKENS = 16_000;

/**
 * Default finding identity: a hash of where the finding is and what it says
 * (normalized). Deterministic for identical model output, so the pipeline can
 * dedupe its comments; the pipeline may override with its own scheme.
 */
export function defaultFindingId(f: ModelReviewOutput['findings'][number]): string {
  const signature = [f.file, f.line ?? '', f.severity, f.title.trim().toLowerCase()].join('|');
  return createHash('sha256').update(signature).digest('hex').slice(0, 16);
}

/**
 * The DevFlow code-review use case, built on the capability-only port.
 * Returns severity-tagged findings — never a pass/fail decision.
 */
export async function reviewCode(
  provider: AiProvider,
  input: ReviewCodeInput,
): Promise<AiResult<CodeReviewResult>> {
  const { instructions, messages } = buildReviewRequest(input);
  const result = await provider.generateStructuredOutput({
    capability: 'code-review',
    schema: ModelReviewOutputSchema,
    schemaName: 'code_review',
    instructions,
    messages,
    maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS,
    signal: input.signal,
  });

  const seen = new Set<string>();
  const findings: CodeReviewFinding[] = [];
  for (const f of result.output.findings) {
    const id = defaultFindingId(f);
    if (seen.has(id)) continue; // model repeated itself
    seen.add(id);
    findings.push({ ...f, id, source: 'ai' });
  }

  return { ...result, output: { summary: result.output.summary, findings } };
}
