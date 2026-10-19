import { REVIEW_SEVERITIES, type CodeReviewFinding } from '@devflow/ai';
import type { AiReviewRow } from './dal/ai-reviews.dal';

export const AI_REVIEW_CHECK_NAME = 'devflow/ai-review';

/** Hidden marker so the comment is recognizable as DevFlow's (and per-commit). */
const COMMENT_MARKER = '<!-- devflow:ai-review -->';
/** GitHub caps comment bodies at 65,536 chars and check summaries at 65,535. */
const MAX_BODY_CHARS = 60_000;

const SEVERITY_LABEL: Record<CodeReviewFinding['severity'], string> = {
  critical: '🔴 Critical',
  high: '🟠 High',
  medium: '🟡 Medium',
  low: '⚪ Low',
};

/** Model output is untrusted: keep it from pinging people or closing our markup. */
function sanitize(text: string): string {
  return text.replace(/@(?=[\w-])/g, '@​').replace(/<!--/g, '&lt;!--');
}

function truncate(text: string): string {
  return text.length <= MAX_BODY_CHARS
    ? text
    : `${text.slice(0, MAX_BODY_CHARS)}\n\n_…truncated; see DevFlow for the full review._`;
}

function renderFinding(f: CodeReviewFinding): string {
  const where = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
  const lines = [`- **${sanitize(f.title)}** — ${where}`, `  ${sanitize(f.explanation)}`];
  if (f.suggestion) lines.push(`  _Suggestion:_ ${sanitize(f.suggestion)}`);
  return lines.join('\n');
}

function renderFindings(findings: CodeReviewFinding[]): string {
  if (findings.length === 0) return '_No findings._';
  return REVIEW_SEVERITIES.flatMap((severity) => {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) return [];
    return [`#### ${SEVERITY_LABEL[severity]} (${group.length})`, ...group.map(renderFinding)];
  }).join('\n\n');
}

function findingsOf(review: AiReviewRow): CodeReviewFinding[] {
  return (review.findings as CodeReviewFinding[] | null) ?? [];
}

function conclusionLine(review: AiReviewRow): string {
  return review.policyConclusion === 'failure'
    ? 'Blocking: at least one **critical** finding. Fix it or have a human reviewer override.'
    : 'No critical findings — not blocking. Lower-severity findings are advisory.';
}

/** The check run's output panel (design §5.3). */
export function renderCheckOutput(review: AiReviewRow): { title: string; summary: string } {
  if (review.status === 'failed') {
    return {
      title: 'AI review unavailable',
      summary:
        'The automated review could not complete, so this check is neutral and does not block merge. ' +
        'A human review is still required.',
    };
  }
  if (review.status === 'pending') {
    return { title: 'AI review in progress', summary: 'Reviewing this commit…' };
  }
  const findings = findingsOf(review);
  const title =
    review.policyConclusion === 'failure'
      ? `${findings.filter((f) => f.severity === 'critical').length} critical finding(s)`
      : `${findings.length} finding(s), none critical`;
  return {
    title,
    summary: truncate(
      [sanitize(review.summary ?? ''), conclusionLine(review), renderFindings(findings)].join(
        '\n\n',
      ),
    ),
  };
}

/** One summary comment per reviewed commit (design §13 Q2), findings grouped by severity. */
export function renderSummaryComment(review: AiReviewRow): string {
  return truncate(
    [
      COMMENT_MARKER,
      `### DevFlow AI review for \`${review.headSha.slice(0, 7)}\``,
      sanitize(review.summary ?? ''),
      conclusionLine(review),
      renderFindings(findingsOf(review)),
      `<sub>${review.provider ?? ''} · ${review.model ?? ''} · prompt ${review.promptVersion}</sub>`,
    ].join('\n\n'),
  );
}
