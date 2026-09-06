import { type FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireOrgRole } from '../../../modules/access/org-context';
import { listActivity, type ActivityRow } from '../../../modules/activity/dal/activity.dal';
import {
  activityListResponseSchema,
  activityQuerySchema,
  orgActivityParamsSchema,
  workItemActivityParamsSchema,
} from './schema';

function toActivityResponse(row: ActivityRow) {
  return {
    id: row.id,
    workItemId: row.workItemId,
    actorType: row.actorType,
    actorId: row.actorId,
    action: row.action,
    summary: row.summary,
    metadata: row.metadata,
    correlationId: row.correlationId,
    occurredAt: row.occurredAt,
  };
}

export async function activityRouter(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/organizations/:organizationId/activity',
    {
      preHandler: requireOrgRole('viewer'),
      schema: {
        tags: ['Activity'],
        summary: 'Org-wide activity feed',
        params: orgActivityParamsSchema,
        querystring: activityQuerySchema,
        response: { 200: activityListResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const rows = await listActivity(app.db, request.orgContext.organizationId, {
        limit: request.query.limit,
        offset: request.query.offset,
      });
      return { activity: rows.map(toActivityResponse) };
    },
  );

  typed.get(
    '/organizations/:organizationId/work-items/:workItemId/activity',
    {
      preHandler: requireOrgRole('viewer'),
      schema: {
        tags: ['Activity'],
        summary: 'Activity for a single work item',
        params: workItemActivityParamsSchema,
        querystring: activityQuerySchema,
        response: { 200: activityListResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const rows = await listActivity(app.db, request.orgContext.organizationId, {
        workItemId: request.params.workItemId,
        limit: request.query.limit,
        offset: request.query.offset,
      });
      return { activity: rows.map(toActivityResponse) };
    },
  );
}
