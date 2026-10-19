import { type FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireOrgRole } from '../../../modules/access/org-context';
import {
  createProject,
  getProject,
  listProjects,
  updateProject,
  ProjectNotFoundError,
  ProjectSlugTakenError,
} from '../../../modules/projects/service/projects.service';
import {
  createProjectBodySchema,
  organizationProjectsParamsSchema,
  projectParamsSchema,
  projectResponseSchema,
  projectsListResponseSchema,
  updateProjectBodySchema,
} from './schema';

export async function projectsRouter(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/organizations/:organizationId/projects',
    {
      preHandler: requireOrgRole('viewer'),
      schema: {
        tags: ['Projects'],
        summary: 'List projects',
        description: 'Projects in the organization, by name. Any member can read.',
        params: organizationProjectsParamsSchema,
        response: { 200: projectsListResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      return { projects: await listProjects(app.db, request.orgContext) };
    },
  );

  typed.post(
    '/organizations/:organizationId/projects',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Projects'],
        summary: 'Create a project',
        description:
          'Creates a project with a workflow config (defaults fill anything omitted). ' +
          '409 if the slug is taken. Admin/owner only.',
        params: organizationProjectsParamsSchema,
        body: createProjectBodySchema,
        response: { 201: projectResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      try {
        const project = await createProject(
          app.db,
          request.orgContext,
          request.body,
          request.correlationId,
        );
        reply.code(201);
        return project;
      } catch (error) {
        if (error instanceof ProjectSlugTakenError) return reply.conflict(error.message);
        throw error;
      }
    },
  );

  typed.get(
    '/organizations/:organizationId/projects/:projectId',
    {
      preHandler: requireOrgRole('viewer'),
      schema: {
        tags: ['Projects'],
        summary: 'Get a project',
        params: projectParamsSchema,
        response: { 200: projectResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      try {
        return await getProject(app.db, request.orgContext, request.params.projectId);
      } catch (error) {
        if (error instanceof ProjectNotFoundError) return reply.notFound();
        throw error;
      }
    },
  );

  typed.patch(
    '/organizations/:organizationId/projects/:projectId',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Projects'],
        summary: 'Update a project',
        description:
          'Updates name/slug/key and/or merges a partial workflow config. Admin/owner only.',
        params: projectParamsSchema,
        body: updateProjectBodySchema,
        response: { 200: projectResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      try {
        return await updateProject(
          app.db,
          request.orgContext,
          request.params.projectId,
          request.body,
          request.correlationId,
        );
      } catch (error) {
        if (error instanceof ProjectNotFoundError) return reply.notFound();
        if (error instanceof ProjectSlugTakenError) return reply.conflict(error.message);
        throw error;
      }
    },
  );
}
