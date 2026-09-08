import { describe, expect, it } from 'vitest';
import type { ProjectManagementPort } from '../ports';
import type { ProviderContext } from '../ports';

export interface ProjectManagementContractFixtures {
  createPort(): ProjectManagementPort;
  ctx: ProviderContext;
  projectId: string;
  issueExternalId: string;
}

/**
 * Shared contract suite every `ProjectManagementPort` adapter runs against
 * its own fixtures (design doc §14), mirroring `runSourceControlPortContractTests`.
 */
export function runProjectManagementPortContractTests(
  adapterName: string,
  fixtures: ProjectManagementContractFixtures,
): void {
  describe(`ProjectManagementPort contract: ${adapterName}`, () => {
    it('createIssue / getIssue return a normalized Issue', async () => {
      const port = fixtures.createPort();
      const issue = await port.createIssue(fixtures.ctx, {
        projectId: fixtures.projectId,
        title: 'Contract test issue',
      });
      expect(issue).toMatchObject({
        externalId: expect.any(String),
        title: expect.any(String),
        status: expect.any(String),
        url: expect.any(String),
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });

      const fetched = await port.getIssue(fixtures.ctx, {
        projectId: fixtures.projectId,
        externalId: fixtures.issueExternalId,
      });
      expect(fetched).toMatchObject({ externalId: expect.any(String) });
    });

    it('updateIssue returns a normalized Issue', async () => {
      const issue = await fixtures.createPort().updateIssue(fixtures.ctx, {
        projectId: fixtures.projectId,
        externalId: fixtures.issueExternalId,
        title: 'Updated title',
      });
      expect(issue).toMatchObject({
        externalId: expect.any(String),
        title: expect.any(String),
      });
    });

    it('createComment returns a normalized Comment', async () => {
      const comment = await fixtures.createPort().createComment(fixtures.ctx, {
        repo: fixtures.projectId,
        targetExternalId: fixtures.issueExternalId,
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
  });
}
