import { type FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { parseCredentialsKey } from '@devflow/integrations-core';
import { env } from '../../../config/env';
import { requireOrgRole } from '../../../modules/access/org-context';
import {
  createAndBindWorkItem,
  transitionWorkItem,
  IntegrationRequiredError,
  ProviderError,
  WorkItemNotFoundError,
  InvalidTransitionError,
  type ResolvePmAdapter,
} from '../../../modules/work-items/service/work-items.service';
import {
  startWork,
  WorkflowExecutionConflictError,
} from '../../../modules/dev-workflow/service/dev-workflow.service';
import {
  findWorkItemById,
  listWorkItems,
  type WorkItemRow,
} from '../../../modules/work-items/dal/work-items.dal';
import type { ActorAction } from '../../../modules/work-items/state-machine';
import {
  createWorkItemBodySchema,
  listWorkItemsQuerySchema,
  projectWorkItemsParamsSchema,
  startWorkBodySchema,
  startWorkResponseSchema,
  transitionWorkItemBodySchema,
  workItemParamsSchema,
  workItemsListResponseSchema,
  workItemResponseSchema,
} from './schema';

function toWorkItemResponse(row: WorkItemRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    externalProvider: row.externalProvider,
    externalIssueId: row.externalIssueId,
    externalIssueKey: row.externalIssueKey,
    externalIssueUrl: row.externalIssueUrl,
    workflowState: row.workflowState,
    blockedFromState: row.blockedFromState,
    workflowExecutionStatus: row.workflowExecutionStatus,
    workflowExecutionError: row.workflowExecutionError,
    assigneeUserId: row.assigneeUserId,
    externalAssigneeId: row.externalAssigneeId,
    branchRef: row.branchRef,
    prRef: row.prRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `resolvePmAdapter` is injectable so tests can stub the PM provider without a live connection. */
export interface WorkItemsRouterOptions {
  resolvePmAdapter?: ResolvePmAdapter;
}

export async function workItemsRouter(
  app: FastifyInstance,
  options: WorkItemsRouterOptions = {},
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/organizations/:organizationId/projects/:projectId/work-items',
    {
      preHandler: requireOrgRole('developer'),
      schema: {
        tags: ['Work Items'],
        summary: 'Create and bind a work item',
        description:
          'Authors the issue in the connected PM provider, then binds a work item to it. Developer+.',
        params: projectWorkItemsParamsSchema,
        body: createWorkItemBodySchema,
        response: { 201: workItemResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        const row = await createAndBindWorkItem(
          app.db,
          request.orgContext,
          parseCredentialsKey(env.INTEGRATION_CREDENTIALS_KEY),
          {
            projectId: request.params.projectId,
            externalProjectId: request.body.externalProjectId,
            title: request.body.title,
            description: request.body.description,
          },
          request.correlationId,
          options.resolvePmAdapter,
        );
        reply.code(201);
        return toWorkItemResponse(row);
      } catch (error) {
        if (error instanceof IntegrationRequiredError) return reply.conflict(error.message);
        if (error instanceof ProviderError) return reply.badGateway(error.message);
        throw error;
      }
    },
  );

  typed.get(
    '/organizations/:organizationId/projects/:projectId/work-items',
    {
      preHandler: requireOrgRole('viewer'),
      schema: {
        tags: ['Work Items'],
        summary: 'List work items in a project',
        params: projectWorkItemsParamsSchema,
        querystring: listWorkItemsQuerySchema,
        response: { 200: workItemsListResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const rows = await listWorkItems(app.db, request.orgContext.organizationId, {
        projectId: request.params.projectId,
        workflowState: request.query.workflowState,
        assigneeUserId: request.query.assigneeUserId,
      });
      return { workItems: rows.map(toWorkItemResponse) };
    },
  );

  typed.get(
    '/organizations/:organizationId/work-items/:workItemId',
    {
      preHandler: requireOrgRole('viewer'),
      schema: {
        tags: ['Work Items'],
        summary: 'Get a work item',
        params: workItemParamsSchema,
        response: { 200: workItemResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const row = await findWorkItemById(
        app.db,
        request.orgContext.organizationId,
        request.params.workItemId,
      );
      if (!row) return reply.notFound();
      return toWorkItemResponse(row);
    },
  );

  typed.post(
    '/organizations/:organizationId/work-items/:workItemId/transition',
    {
      preHandler: requireOrgRole('developer'),
      schema: {
        tags: ['Work Items'],
        summary: 'Apply an actor transition to a work item',
        description: 'Guarded lifecycle transition (advance/block/unblock/cancel). Developer+.',
        params: workItemParamsSchema,
        body: transitionWorkItemBodySchema,
        response: { 200: workItemResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      const action: ActorAction =
        request.body.action === 'advance'
          ? { type: 'advance', to: request.body.to! }
          : { type: request.body.action };

      try {
        const row = await transitionWorkItem(
          app.db,
          request.orgContext,
          request.params.workItemId,
          action,
          request.correlationId,
        );
        return toWorkItemResponse(row);
      } catch (error) {
        if (error instanceof WorkItemNotFoundError) return reply.notFound();
        if (error instanceof InvalidTransitionError) return reply.conflict(error.message);
        throw error;
      }
    },
  );

  typed.post(
    '/organizations/:organizationId/work-items/:workItemId/start',
    {
      preHandler: requireOrgRole('developer'),
      schema: {
        tags: ['Work Items'],
        summary: 'Start work — create branch + PR via the source-control port',
        description:
          'Outbox-driven saga: advances the work item and kicks off branch/PR creation. Returns 202. Developer+.',
        params: workItemParamsSchema,
        body: startWorkBodySchema,
        response: { 202: startWorkResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        const result = await startWork(
          app.db,
          request.orgContext,
          {
            workItemId: request.params.workItemId,
            repo: request.body.repo,
            baseBranch: request.body.baseBranch,
          },
          request.correlationId,
        );
        reply.code(202);
        return result;
      } catch (error) {
        if (error instanceof WorkItemNotFoundError) return reply.notFound();
        if (error instanceof InvalidTransitionError) return reply.conflict(error.message);
        if (error instanceof WorkflowExecutionConflictError) return reply.conflict(error.message);
        throw error;
      }
    },
  );
}
