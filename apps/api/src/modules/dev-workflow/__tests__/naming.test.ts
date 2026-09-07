import { describe, expect, it } from 'vitest';
import { slugify, renderBranchName, renderPrTitle } from '../naming';
import type { WorkItemRow } from '../../work-items/dal/work-items.dal';

function workItem(overrides: Partial<WorkItemRow> = {}): WorkItemRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    title: 'Add OAuth login',
    externalIssueKey: 'PROJ-142',
    externalIssueId: 'issue-1',
    ...overrides,
  } as WorkItemRow;
}

describe('dev-workflow naming', () => {
  it('slugifies titles: lowercase, dashed, trimmed, capped at 50', () => {
    expect(slugify('Add OAuth Login')).toBe('add-oauth-login');
    expect(slugify('  Héllo,  World!! ')).toBe('h-llo-world');
    expect(slugify('x'.repeat(80))).toHaveLength(50);
  });

  it('renders a branch name from the pattern and sanitizes git refs', () => {
    expect(renderBranchName('{type}/{ticketKey}-{slug}', workItem())).toBe(
      'feature/PROJ-142-add-oauth-login',
    );
    expect(renderBranchName('{key}/{title-slug}', workItem())).toBe('PROJ-142/add-oauth-login');
  });

  it('falls back to the external issue id when there is no key', () => {
    expect(renderBranchName('{key}', workItem({ externalIssueKey: null }))).toBe('issue-1');
  });

  it('renders a PR title from the template', () => {
    expect(renderPrTitle('[{ticketKey}] {title}', workItem())).toBe('[PROJ-142] Add OAuth login');
  });
});
