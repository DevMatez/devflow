import { schema, type Database } from '@devflow/database';
import { and, eq } from 'drizzle-orm';
import { publishOutbox } from '@devflow/events';
import { decryptCredentials, type SourceControlPort } from '@devflow/integrations-core';
import { createGithubSourceControlAdapter } from '@devflow/integrations-github';
import { env } from '../../../config/env';
import type { OrgContext } from '../../access/org-context';
import { findConnection } from '../../integrations/dal/connections.dal';
import { decodeGithubAppPrivateKey } from '../../integrations/service/github-connect.service';
import { applyActorTransition } from '../../work-items/state-machine';
import { WorkItemStateChanged } from '../../work-items/events';
import {
  findWorkItemById,
  applyStateChange,
  setWorkflowExecutionStatus,
  setBranchRef,
  type WorkItemRow,
} from '../../work-items/dal/work-items.dal';
import {
  WorkItemNotFoundError,
  InvalidTransitionError,
} from '../../work-items/service/work-items.service';
import { renderBranchName } from '../naming';
import {
  DevWorkflowWorkStarted,
  DevWorkflowBranchCreated,
  DevWorkflowWorkflowFailed,
} from '../events';

/** No source-control connection, or the work item's automation is already running/completed. */
export class WorkflowExecutionConflictError extends Error {
  constructor(readonly reason: 'running' | 'completed' | 'no_source_control') {
    super(`Workflow cannot start: ${reason}`);
  }
}

export interface ResolvedSourceControl {
  adapter: SourceControlPort;
  connectionId: string;
}

/** Resolve → decrypt → build a live GitHub adapter. Injectable so jobs/tests can stub it. */
export type ResolveSourceControl = (
  db: Database,
  organizationId: string,
  credentialsKey: Buffer,
) => Promise<ResolvedSourceControl>;

export const resolveGithubSourceControl: ResolveSourceControl = async (
  db,
  organizationId,
  credentialsKey,
) => {
  const connection = await findConnection(db, organizationId, 'source-control');
  if (!connection) throw new WorkflowExecutionConflictError('no_source_control');

  const decrypted = decryptCredentials(credentialsKey, {
    ciphertext: connection.encryptedCredentials,
    iv: connection.credentialsIv,
  });
  const { installationId } = JSON.parse(decrypted) as { installationId: string };

  const adapter = createGithubSourceControlAdapter({
    appId: env.GITHUB_APP_ID,
    privateKey: decodeGithubAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY_BASE64),
    installationId,
  });
  return { adapter, connectionId: connection.id };
};

export interface StartWorkInput {
  workItemId: string;
  /** The GitHub repo (owner/name) the branch + PR are created in. */
  repo: string;
  /** Branch to cut from / merge into; defaults to `main`. */
  baseBranch?: string;
}

export interface StartWorkResult {
  workItemId: string;
  status: 'starting';
}

/** The first incomplete saga step for a FAILED retry (design §4.5). */
function resumePoint(workItem: WorkItemRow): 'work_started' | 'branch_created' | null {
  if (!workItem.branchRef || workItem.branchRef.status === 'pending') return 'work_started';
  if (workItem.branchRef.status === 'active' && !workItem.prRef) return 'branch_created';
  return null;
}

/**
 * Outbox-driven initiation (design §4.2): commits the state change +
 * execution status + branch intent + trigger event in one transaction; the
 * relay routes the trigger to the create-branch job. A FAILED retry resumes
 * from the first incomplete step instead of re-running the whole saga (§4.5).
 */
export async function startWork(
  db: Database,
  ctx: OrgContext,
  input: StartWorkInput,
  correlationId: string,
): Promise<StartWorkResult> {
  const workItem = await findWorkItemById(db, ctx.organizationId, input.workItemId);
  if (!workItem) throw new WorkItemNotFoundError();

  const exec = workItem.workflowExecutionStatus;
  if (exec === 'running') throw new WorkflowExecutionConflictError('running');
  if (exec === 'completed') throw new WorkflowExecutionConflictError('completed');

  if (exec === 'failed') {
    const resume = resumePoint(workItem);
    if (!resume) {
      await setWorkflowExecutionStatus(db, ctx.organizationId, workItem.id, 'completed');
      return { workItemId: workItem.id, status: 'starting' };
    }
    return db.transaction(async (tx) => {
      await setWorkflowExecutionStatus(tx, ctx.organizationId, workItem.id, 'running');
      if (resume === 'work_started') {
        await publishOutbox(
          tx,
          DevWorkflowWorkStarted.create({
            organizationId: ctx.organizationId,
            aggregateId: workItem.id,
            correlationId,
            payload: { workItemId: workItem.id, actorUserId: ctx.userId },
          }),
        );
      } else {
        await publishOutbox(
          tx,
          DevWorkflowBranchCreated.create({
            organizationId: ctx.organizationId,
            aggregateId: workItem.id,
            correlationId,
            payload: {
              workItemId: workItem.id,
              repo: workItem.branchRef!.repo,
              branch: workItem.branchRef!.name,
            },
          }),
        );
      }
      return { workItemId: workItem.id, status: 'starting' as const };
    });
  }

  // Initial start: TODO → IN_PROGRESS.
  const transition = applyActorTransition(
    { workflowState: workItem.workflowState, blockedFromState: workItem.blockedFromState },
    { type: 'advance', to: 'in_progress' },
  );
  if (!transition.ok) throw new InvalidTransitionError(transition.from, transition.to);

  const project = await db.query.projects.findFirst({
    where: and(
      eq(schema.projects.organizationId, ctx.organizationId),
      eq(schema.projects.id, workItem.projectId),
    ),
  });
  if (!project) throw new WorkItemNotFoundError();

  const branchName = renderBranchName(project.workflowConfig.branchNamingPattern, workItem);
  const base = input.baseBranch ?? 'main';

  return db.transaction(async (tx) => {
    const updated = await applyStateChange(tx, ctx.organizationId, workItem.id, transition.state);
    if (!updated) throw new WorkItemNotFoundError();

    await setWorkflowExecutionStatus(tx, ctx.organizationId, workItem.id, 'running');
    await setBranchRef(tx, ctx.organizationId, workItem.id, {
      repo: input.repo,
      name: branchName,
      base,
      status: 'pending',
    });

    await publishOutbox(
      tx,
      WorkItemStateChanged.create({
        organizationId: ctx.organizationId,
        aggregateId: workItem.id,
        correlationId,
        aggregateVersion: updated.version,
        payload: {
          workItemId: workItem.id,
          from: transition.from,
          to: transition.to,
          reason: transition.reason,
          trigger: transition.trigger,
        },
      }),
    );
    await publishOutbox(
      tx,
      DevWorkflowWorkStarted.create({
        organizationId: ctx.organizationId,
        aggregateId: workItem.id,
        correlationId,
        payload: { workItemId: workItem.id, actorUserId: ctx.userId },
      }),
    );

    return { workItemId: workItem.id, status: 'starting' as const };
  });
}

/** Sets execution FAILED + records the reason and emits workflow_failed (design §4.5, DLQ path). */
export async function markWorkflowFailed(
  db: Database,
  organizationId: string,
  workItemId: string,
  step: string,
  error: unknown,
  correlationId: string,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db.transaction(async (tx) => {
    await setWorkflowExecutionStatus(tx, organizationId, workItemId, 'failed', message);
    await publishOutbox(
      tx,
      DevWorkflowWorkflowFailed.create({
        organizationId,
        aggregateId: workItemId,
        correlationId,
        payload: { workItemId, step, error: message },
      }),
    );
  });
}
