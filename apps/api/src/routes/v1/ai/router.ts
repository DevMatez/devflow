import { type FastifyInstance, type FastifyReply } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { schema } from '@devflow/database';
import { AiError, AiRateLimitError } from '@devflow/ai';
import { requireOrgRole } from '../../../modules/access/org-context';
import { getPlatformAiProvider } from '../../../modules/ai/provider';
import {
  generateTicketDraft,
  improveTicketDraft,
} from '../../../modules/ticket-ai/ticket-ai.service';
import {
  listReviewsForWorkItem,
  type AiReviewRow,
} from '../../../modules/ai-review/dal/ai-reviews.dal';
import {
  requestAiReviewRerun,
  AiReviewInProgressError,
  AiReviewNotFoundError,
} from '../../../modules/ai-review/service/ai-review.service';
import { findWorkItemById } from '../../../modules/work-items/dal/work-items.dal';
import {
  aiReviewResponseSchema,
  aiReviewsListResponseSchema,
  generateDraftBodySchema,
  improveDraftBodySchema,
  organizationParamsSchema,
  projectDraftParamsSchema,
  rerunReviewParamsSchema,
  reviewsQuerySchema,
  ticketDraftSchema,
  workItemReviewsParamsSchema,
} from './schema';

/** Each draft call is a paid model call — tighter than the global 100/min. */
const DRAFT_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

const AI_DISABLED = 'AI is not configured on this DevFlow instance';

function toReviewResponse(row: AiReviewRow) {
  return {
    id: row.id,
    workItemId: row.workItemId,
    repo: row.repo,
    prNumber: row.prNumber,
    headSha: row.headSha,
    status: row.status,
    policyConclusion: row.policyConclusion,
    summary: row.summary,
    findings: row.findings as never,
    rulesVersion: row.rulesVersion,
    promptVersion: row.promptVersion,
    model: row.model,
    provider: row.provider,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A failed interactive AI call is an upstream failure, not a server bug. */
function aiErrorReply(reply: FastifyReply, error: unknown) {
  if (error instanceof AiRateLimitError) return reply.tooManyRequests('AI provider rate limited');
  if (error instanceof AiError) return reply.badGateway(`AI request failed: ${error.message}`);
  throw error;
}

export async function aiRouter(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/organizations/:organizationId/projects/:projectId/work-items/draft',
    {
      preHandler: requireOrgRole('developer'),
      config: { rateLimit: DRAFT_RATE_LIMIT },
      schema: {
        tags: ['Ticket AI'],
        summary: 'Generate a ticket draft with AI',
        description:
          'Returns an unpersisted draft (title, description, acceptance criteria). Nothing is ' +
          'written: submit the (edited) draft to the create-work-item endpoint. Developer+.',
        params: projectDraftParamsSchema,
        body: generateDraftBodySchema,
        response: { 200: ticketDraftSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const ai = getPlatformAiProvider();
      if (!ai) return reply.serviceUnavailable(AI_DISABLED);

      const project = await app.db.query.projects.findFirst({
        where: and(
          eq(schema.projects.organizationId, request.orgContext.organizationId),
          eq(schema.projects.id, request.params.projectId),
        ),
      });
      if (!project) return reply.notFound();

      try {
        return await generateTicketDraft(ai, {
          prompt: request.body.prompt,
          projectName: project.name,
        });
      } catch (error) {
        return aiErrorReply(reply, error);
      }
    },
  );

  typed.post(
    '/organizations/:organizationId/work-items/draft/improve',
    {
      preHandler: requireOrgRole('developer'),
      config: { rateLimit: DRAFT_RATE_LIMIT },
      schema: {
        tags: ['Ticket AI'],
        summary: 'Improve a ticket draft with AI',
        description: 'Returns a revised, unpersisted draft. Developer+.',
        params: organizationParamsSchema,
        body: improveDraftBodySchema,
        response: { 200: ticketDraftSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const ai = getPlatformAiProvider();
      if (!ai) return reply.serviceUnavailable(AI_DISABLED);

      try {
        return await improveTicketDraft(ai, request.body);
      } catch (error) {
        return aiErrorReply(reply, error);
      }
    },
  );

  typed.get(
    '/organizations/:organizationId/work-items/:workItemId/ai-reviews',
    {
      preHandler: requireOrgRole('viewer'),
      schema: {
        tags: ['AI Reviews'],
        summary: "AI reviews of a work item's PR, newest first",
        params: workItemReviewsParamsSchema,
        querystring: reviewsQuerySchema,
        response: { 200: aiReviewsListResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const workItem = await findWorkItemById(
        app.db,
        request.orgContext.organizationId,
        request.params.workItemId,
      );
      if (!workItem) return reply.notFound();

      const rows = await listReviewsForWorkItem(
        app.db,
        request.orgContext.organizationId,
        request.params.workItemId,
        { limit: request.query.limit, offset: request.query.offset },
      );
      return { reviews: rows.map(toReviewResponse) };
    },
  );

  typed.post(
    '/organizations/:organizationId/work-items/:workItemId/ai-reviews/:reviewId/rerun',
    {
      preHandler: requireOrgRole('developer'),
      schema: {
        tags: ['AI Reviews'],
        summary: 'Re-run an AI review for the same commit',
        description:
          'Resets the review to pending and re-queues it; the GitHub check and a new summary ' +
          'comment follow when it completes. 409 while the review is still pending. Developer+.',
        params: rerunReviewParamsSchema,
        response: { 202: aiReviewResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      if (!getPlatformAiProvider()) return reply.serviceUnavailable(AI_DISABLED);

      try {
        const row = await requestAiReviewRerun(
          app.db,
          {
            organizationId: request.orgContext.organizationId,
            workItemId: request.params.workItemId,
            reviewId: request.params.reviewId,
            actorUserId: request.orgContext.userId,
          },
          request.correlationId,
        );
        reply.code(202);
        return toReviewResponse(row);
      } catch (error) {
        if (error instanceof AiReviewNotFoundError) return reply.notFound();
        if (error instanceof AiReviewInProgressError) {
          return reply.conflict('Review is already pending');
        }
        throw error;
      }
    },
  );
}
