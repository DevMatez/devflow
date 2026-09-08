import { defineJob } from '@devflow/queue';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@devflow/database';
import { publishOutbox } from '@devflow/events';
import type { FastifyBaseLogger } from 'fastify';
import type { OrganizationId } from '@devflow/types';
import {
  findWorkItemById,
  applyStateChange,
  setPrRef,
  setWorkflowExecutionStatus,
} from '../../work-items/dal/work-items.dal';
import { applyActorTransition } from '../../work-items/state-machine';
import { WorkItemStateChanged } from '../../work-items/events';
import { renderPrTitle } from '../naming';
import { DevWorkflowPullRequestOpened } from '../events';
import {
  markWorkflowFailed,
  resolveGithubSourceControl,
  type ResolveSourceControl,
} from '../service/dev-workflow.service';

export const createPrJobSchema: z.ZodType<{ organizationId: string; workItemId: string }> =
  z.object({ organizationId: z.string(), workItemId: z.string() });

const MAX_ATTEMPTS = 3;

/** The PR step's core (exported for direct testing). */
export async function runCreatePrStep(
  db: Database,
  credentialsKey: Buffer,
  resolve: ResolveSourceControl,
  payload: { organizationId: string; workItemId: string },
  correlationId: string,
): Promise<void> {
  const workItem = await findWorkItemById(db, payload.organizationId, payload.workItemId);
  if (!workItem?.branchRef || workItem.branchRef.status !== 'active') return;

  const project = await db.query.projects.findFirst({
    where: and(
      eq(schema.projects.organizationId, payload.organizationId),
      eq(schema.projects.id, workItem.projectId),
    ),
  });
  if (!project) return;

  const base = workItem.branchRef.base ?? 'main';
  const { adapter, connectionId } = await resolve(db, payload.organizationId, credentialsKey);
  const pr = await adapter.findOrCreatePullRequest(
    { organizationId: payload.organizationId as OrganizationId, connectionId },
    {
      repo: workItem.branchRef.repo,
      title: renderPrTitle(project.workflowConfig.prTitleTemplate, workItem),
      headRef: workItem.branchRef.name,
      baseRef: base,
    },
  );

  await db.transaction(async (tx) => {
    await setPrRef(tx, payload.organizationId, payload.workItemId, {
      repo: pr.repo,
      number: pr.number,
      url: pr.url,
      state: pr.state,
    });

    if (workItem.workflowState === 'in_progress') {
      const transition = applyActorTransition(
        { workflowState: workItem.workflowState, blockedFromState: workItem.blockedFromState },
        { type: 'advance', to: 'in_review' },
      );
      if (transition.ok) {
        const updated = await applyStateChange(
          tx,
          payload.organizationId,
          payload.workItemId,
          transition.state,
        );
        if (updated) {
          await publishOutbox(
            tx,
            WorkItemStateChanged.create({
              organizationId: payload.organizationId,
              aggregateId: payload.workItemId,
              correlationId,
              aggregateVersion: updated.version,
              payload: {
                workItemId: payload.workItemId,
                from: transition.from,
                to: transition.to,
                reason: transition.reason,
                trigger: transition.trigger,
              },
            }),
          );
        }
      }
    }

    await setWorkflowExecutionStatus(tx, payload.organizationId, payload.workItemId, 'completed');
    await publishOutbox(
      tx,
      DevWorkflowPullRequestOpened.create({
        organizationId: payload.organizationId,
        aggregateId: payload.workItemId,
        correlationId,
        payload: {
          workItemId: payload.workItemId,
          repo: pr.repo,
          number: pr.number,
          url: pr.url,
        },
      }),
    );
  });
}

/**
 * Idempotent PR step (design §4.3, §4.2): find-or-create the PR, set the
 * pointer, advance IN_PROGRESS→IN_REVIEW, and mark execution COMPLETED. On
 * the final failed attempt, marks execution FAILED (§4.5) before DLQ.
 */
export function createCreatePrJob(
  db: Database,
  logger: FastifyBaseLogger,
  credentialsKey: Buffer,
  resolve: ResolveSourceControl = resolveGithubSourceControl,
) {
  return defineJob({
    name: 'dev-workflow.create-pr',
    version: 1,
    schema: createPrJobSchema,
    defaults: { attempts: MAX_ATTEMPTS },
    timeout: 30_000,
    handler: async (payload, ctx) => {
      try {
        await runCreatePrStep(db, credentialsKey, resolve, payload, ctx.correlationId);
        logger.info({ workItemId: payload.workItemId }, 'dev-workflow: PR opened');
      } catch (error) {
        if (ctx.attempt >= MAX_ATTEMPTS) {
          await markWorkflowFailed(
            db,
            payload.organizationId,
            payload.workItemId,
            'create-pr',
            error,
            ctx.correlationId,
          );
        }
        throw error;
      }
    },
  });
}
