import { defineJob } from '@devflow/queue';
import { z } from 'zod';
import { publishOutbox } from '@devflow/events';
import type { Database } from '@devflow/database';
import type { FastifyBaseLogger } from 'fastify';
import type { OrganizationId } from '@devflow/types';
import { findWorkItemById, setBranchRef } from '../../work-items/dal/work-items.dal';
import { DevWorkflowBranchCreated } from '../events';
import {
  markWorkflowFailed,
  resolveGithubSourceControl,
  type ResolveSourceControl,
} from '../service/dev-workflow.service';

export const createBranchJobSchema: z.ZodType<{ organizationId: string; workItemId: string }> =
  z.object({ organizationId: z.string(), workItemId: z.string() });

const MAX_ATTEMPTS = 3;

/** The branch step's core (exported for direct testing) — find-or-create + persist + emit. */
export async function runCreateBranchStep(
  db: Database,
  credentialsKey: Buffer,
  resolve: ResolveSourceControl,
  payload: { organizationId: string; workItemId: string },
  correlationId: string,
): Promise<void> {
  const workItem = await findWorkItemById(db, payload.organizationId, payload.workItemId);
  if (!workItem?.branchRef) return;

  const { adapter, connectionId } = await resolve(db, payload.organizationId, credentialsKey);
  const branch = await adapter.findOrCreateBranch(
    { organizationId: payload.organizationId as OrganizationId, connectionId },
    {
      repo: workItem.branchRef.repo,
      name: workItem.branchRef.name,
      fromRef: workItem.branchRef.base ?? 'main',
    },
  );

  await db.transaction(async (tx) => {
    await setBranchRef(tx, payload.organizationId, payload.workItemId, {
      ...workItem.branchRef!,
      status: 'active',
      url: branch.url,
    });
    await publishOutbox(
      tx,
      DevWorkflowBranchCreated.create({
        organizationId: payload.organizationId,
        aggregateId: payload.workItemId,
        correlationId,
        payload: { workItemId: payload.workItemId, repo: branch.repo, branch: branch.name },
      }),
    );
  });
}

/**
 * Idempotent branch step (design §4.3): find-or-create the branch, mark the
 * pointer active, and emit branch_created (which drives create-pr). On the
 * final failed attempt, marks execution FAILED (§4.5) before dead-lettering.
 */
export function createCreateBranchJob(
  db: Database,
  logger: FastifyBaseLogger,
  credentialsKey: Buffer,
  resolve: ResolveSourceControl = resolveGithubSourceControl,
) {
  return defineJob({
    name: 'dev-workflow.create-branch',
    version: 1,
    schema: createBranchJobSchema,
    defaults: { attempts: MAX_ATTEMPTS },
    timeout: 30_000,
    handler: async (payload, ctx) => {
      try {
        await runCreateBranchStep(db, credentialsKey, resolve, payload, ctx.correlationId);
        logger.info({ workItemId: payload.workItemId }, 'dev-workflow: branch created');
      } catch (error) {
        if (ctx.attempt >= MAX_ATTEMPTS) {
          await markWorkflowFailed(
            db,
            payload.organizationId,
            payload.workItemId,
            'create-branch',
            error,
            ctx.correlationId,
          );
        }
        throw error;
      }
    },
  });
}
