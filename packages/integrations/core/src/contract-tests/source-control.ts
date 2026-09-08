import { describe, expect, it } from 'vitest';
import type { SourceControlPort } from '../ports';
import type { ProviderContext } from '../ports';

export interface SourceControlContractFixtures {
  createPort(): SourceControlPort;
  ctx: ProviderContext;
  repo: string;
  fromRef: string;
  branchName: string;
  prNumber: number;
  headSha: string;
}

/**
 * Shared contract suite every `SourceControlPort` adapter runs against its
 * own fixtures (design doc §14) — catches an adapter silently deviating
 * from the port's normalized shape, independent of any one vendor.
 */
export function runSourceControlPortContractTests(
  adapterName: string,
  fixtures: SourceControlContractFixtures,
): void {
  describe(`SourceControlPort contract: ${adapterName}`, () => {
    it('listRepositories returns normalized Repository[] shape', async () => {
      const repos = await fixtures.createPort().listRepositories(fixtures.ctx);
      expect(Array.isArray(repos)).toBe(true);
      for (const repo of repos) {
        expect(repo).toMatchObject({
          externalId: expect.any(String),
          name: expect.any(String),
          fullName: expect.any(String),
          defaultBranch: expect.any(String),
          url: expect.any(String),
        });
      }
    });

    it('createBranch returns a normalized Branch', async () => {
      const branch = await fixtures.createPort().createBranch(fixtures.ctx, {
        repo: fixtures.repo,
        name: fixtures.branchName,
        fromRef: fixtures.fromRef,
      });
      expect(branch).toMatchObject({
        name: expect.any(String),
        repo: expect.any(String),
        sha: expect.any(String),
        url: expect.any(String),
      });
    });

    it('findOrCreateBranch returns a normalized Branch', async () => {
      const branch = await fixtures.createPort().findOrCreateBranch(fixtures.ctx, {
        repo: fixtures.repo,
        name: fixtures.branchName,
        fromRef: fixtures.fromRef,
      });
      expect(branch).toMatchObject({
        name: expect.any(String),
        repo: expect.any(String),
        sha: expect.any(String),
        url: expect.any(String),
      });
    });

    it('createPullRequest / getPullRequest return a normalized PullRequest', async () => {
      const port = fixtures.createPort();
      const pr = await port.createPullRequest(fixtures.ctx, {
        repo: fixtures.repo,
        title: 'Contract test PR',
        headRef: fixtures.branchName,
        baseRef: fixtures.fromRef,
      });
      expect(pr).toMatchObject({
        externalId: expect.any(String),
        repo: expect.any(String),
        number: expect.any(Number),
        title: expect.any(String),
        state: expect.stringMatching(/^(open|closed|merged)$/),
        url: expect.any(String),
        headRef: expect.any(String),
        baseRef: expect.any(String),
        authorExternalId: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });

      const fetched = await port.getPullRequest(fixtures.ctx, {
        repo: fixtures.repo,
        number: fixtures.prNumber,
      });
      expect(fetched).toMatchObject({ externalId: expect.any(String), number: expect.any(Number) });
    });

    it('findOrCreatePullRequest returns a normalized PullRequest', async () => {
      const pr = await fixtures.createPort().findOrCreatePullRequest(fixtures.ctx, {
        repo: fixtures.repo,
        title: 'Contract test PR',
        headRef: fixtures.branchName,
        baseRef: fixtures.fromRef,
      });
      expect(pr).toMatchObject({
        externalId: expect.any(String),
        number: expect.any(Number),
        state: expect.stringMatching(/^(open|closed|merged)$/),
      });
    });

    it('createComment returns a normalized Comment', async () => {
      const comment = await fixtures.createPort().createComment(fixtures.ctx, {
        repo: fixtures.repo,
        targetExternalId: String(fixtures.prNumber),
        body: 'contract test comment',
      });
      expect(comment).toMatchObject({
        externalId: expect.any(String),
        body: expect.any(String),
        authorExternalId: expect.any(String),
        url: expect.any(String),
        createdAt: expect.any(String),
      });
    });

    it('getDiff returns a string', async () => {
      const diff = await fixtures.createPort().getDiff(fixtures.ctx, {
        repo: fixtures.repo,
        number: fixtures.prNumber,
      });
      expect(typeof diff).toBe('string');
    });

    it('upsertCheckRun returns a normalized CheckRun', async () => {
      const checkRun = await fixtures.createPort().upsertCheckRun(fixtures.ctx, {
        repo: fixtures.repo,
        headSha: fixtures.headSha,
        name: 'contract-test-check',
        status: 'in_progress',
      });
      expect(checkRun).toMatchObject({
        externalId: expect.any(String),
        name: expect.any(String),
        status: expect.stringMatching(/^(queued|in_progress|completed)$/),
        url: expect.any(String),
      });
    });
  });
}
