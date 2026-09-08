import type { WorkItemRow } from '../work-items/dal/work-items.dal';

/** Lowercased, non-alphanumerics collapsed to `-`, trimmed, capped at 50 (design §15). */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}

function templateVars(workItem: WorkItemRow): Record<string, string> {
  const key = workItem.externalIssueKey ?? workItem.externalIssueId;
  const slug = slugify(workItem.title);
  return {
    type: 'feature',
    key,
    ticketKey: key,
    slug,
    'title-slug': slug,
    title: workItem.title,
    id: workItem.id,
  };
}

function render(pattern: string, vars: Record<string, string>): string {
  return pattern.replace(/\{([\w-]+)\}/g, (_match, token: string) => vars[token] ?? '');
}

/** Git refs disallow spaces and a handful of characters; keep `/` for `feature/...` prefixes. */
function sanitizeGitRef(ref: string): string {
  return ref
    .replace(/[\s~^:?*[\\]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/-+/g, '-')
    .replace(/^[-/]+|[-/]+$/g, '');
}

export function renderBranchName(pattern: string, workItem: WorkItemRow): string {
  return sanitizeGitRef(render(pattern, templateVars(workItem)));
}

export function renderPrTitle(template: string, workItem: WorkItemRow): string {
  return render(template, templateVars(workItem)).trim();
}
