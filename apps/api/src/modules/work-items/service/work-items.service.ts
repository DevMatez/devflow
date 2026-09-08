import type { Database } from '@devflow/database';
import { decryptCredentials, type ProjectManagementPort } from '@devflow/integrations-core';
import { createPlaneProjectManagementAdapter } from '@devflow/integrations-plane';
import { publishOutbox } from '@devflow/events';
import type { WorkflowState } from '@devflow/types';
import type { OrgContext } from '../../access/org-context';
import { getConnection } from '../../integrations/service/connections.service';
import type { PlaneCredentials } from '../../integrations/service/plane-connect.service';
import { applyActorTransition, type ActorAction, type WorkItemStateView } from '../state-machine';
import { WorkItemCreated, WorkItemStateChanged } from '../events';
import {
  applyStateChange,
  createWorkItem,
  findWorkItemById,
  type WorkItemRow,
} from '../dal/work-items.dal';

/** No project-management connection for the org — a work item needs one to author its external issue (design §3.4). */
export class IntegrationRequiredError extends Error {
  constructor() {
    super('A project-management integration must be connected to create a work item');
  }
}

/** The PM provider rejected `createIssue` — the external issue is the anchor, so no work item is persisted (design §3.4). */
export class ProviderError extends Error {}

export class WorkItemNotFoundError extends Error {}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: WorkflowState,
    readonly to?: WorkflowState,
  ) {
    super(`Invalid work-item transition from ${from}${to ? ` to ${to}` : ''}`);
  }
}

/** Resolves the org's PM connection into a live port + the ids `createIssue` needs. Injectable for tests. */
export interface ResolvedPmAdapter {
  adapter: ProjectManagementPort;
  provider: string;
  connectionId: string;
}

export type ResolvePmAdapter = (
  db: Database,
  ctx: OrgContext,
  credentialsKey: Buffer,
) => Promise<ResolvedPmAdapter>;

const resolvePlaneAdapter: ResolvePmAdapter = async (db, ctx, credentialsKey) => {
  const connection = await getConnection(db, ctx, 'project-management');
  if (!connection) throw new IntegrationRequiredError();

  const decrypted = decryptCredentials(credentialsKey, {
    ciphertext: connection.encryptedCredentials,
    iv: connection.credentialsIv,
  });
  const credentials = JSON.parse(decrypted) as PlaneCredentials;
  const externalAccount = connection.externalAccount as { workspaceSlug: string };

  const adapter = createPlaneProjectManagementAdapter({
    apiToken: credentials.apiToken,
    workspaceSlug: externalAccount.workspaceSlug,
  });

  return { adapter, provider: connection.provider, connectionId: connection.id };
};

export interface CreateAndBindWorkItemInput {
  projectId: string;
  /** The provider's project the issue is authored in (e.g. the Plane project id); not persisted this wave. */
  externalProjectId: string;
  title: string;
  description?: string;
}

/**
 * Create-and-bind (design §3.1): author the external issue through the PM
 * port first (the issue is the anchor — no issue, no row), then persist the
 * bound work item and emit `workitem.created` in one transaction.
 */
export async function createAndBindWorkItem(
  db: Database,
  ctx: OrgContext,
  credentialsKey: Buffer,
  input: CreateAndBindWorkItemInput,
  correlationId: string,
  resolve: ResolvePmAdapter = resolvePlaneAdapter,
): Promise<WorkItemRow> {
  const { adapter, provider, connectionId } = await resolve(db, ctx, credentialsKey);

  let issue;
  try {
    issue = await adapter.createIssue(
      { organizationId: ctx.organizationId, connectionId },
      { projectId: input.externalProjectId, title: input.title, description: input.description },
    );
  } catch (error) {
    throw new ProviderError(
      `Could not create the issue in the project-management provider: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return db.transaction(async (tx) => {
    const row = await createWorkItem(tx, {
      organizationId: ctx.organizationId,
      projectId: input.projectId,
      title: issue.title,
      externalProvider: provider,
      externalIssueId: issue.externalId,
      externalIssueUrl: issue.url,
      externalAssigneeId: issue.assigneeExternalId,
    });

    await publishOutbox(
      tx,
      WorkItemCreated.create({
        organizationId: ctx.organizationId,
        aggregateId: row.id,
        correlationId,
        aggregateVersion: row.version,
        payload: {
          workItemId: row.id,
          projectId: row.projectId,
          externalKey: row.externalIssueKey,
        },
      }),
    );

    return row;
  });
}

/**
 * Applies a guarded actor transition (design §3.2): reads the item, runs the
 * pure state machine, persists the result (version-bumped) and emits
 * `workitem.state_changed` in one transaction.
 */
export async function transitionWorkItem(
  db: Database,
  ctx: OrgContext,
  workItemId: string,
  action: ActorAction,
  correlationId: string,
): Promise<WorkItemRow> {
  return db.transaction(async (tx) => {
    const current = await findWorkItemById(tx, ctx.organizationId, workItemId);
    if (!current) throw new WorkItemNotFoundError();

    const view: WorkItemStateView = {
      workflowState: current.workflowState,
      blockedFromState: current.blockedFromState,
    };
    const result = applyActorTransition(view, action);
    if (!result.ok) throw new InvalidTransitionError(result.from, result.to);

    const updated = await applyStateChange(tx, ctx.organizationId, workItemId, result.state);
    if (!updated) throw new WorkItemNotFoundError();

    await publishOutbox(
      tx,
      WorkItemStateChanged.create({
        organizationId: ctx.organizationId,
        aggregateId: updated.id,
        correlationId,
        aggregateVersion: updated.version,
        payload: {
          workItemId: updated.id,
          from: result.from,
          to: result.to,
          reason: result.reason,
          trigger: result.trigger,
        },
      }),
    );

    return updated;
  });
}
