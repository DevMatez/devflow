import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';

/**
 * Generates the OpenAPI spec from Zod route schemas (@fastify/swagger) and
 * serves the Scalar API reference UI at /doc.
 */
export const openapiPlugin = fp(async (app) => {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'DevFlow API',
        description:
          'HTTP API for the DevFlow developer workflow orchestration platform. ' +
          'Coordinates project management, source control, chat, and calendar ' +
          'integrations across the ticket → branch → PR → review → merge lifecycle. ' +
          'Routes are versioned under `/api/v{n}`.',
        version: '0.0.0',
      },
      tags: [
        { name: 'Health', description: 'Liveness and readiness probes for the service.' },
        { name: 'System', description: 'Foundation-proving endpoints (Wave 0), not domain APIs.' },
        {
          name: 'Auth',
          description: 'GitHub login, session, and logout (Wave 1 Identity & Access).',
        },
        {
          name: 'Organizations',
          description: 'Organizations, memberships, invitations, and teams (Wave 1).',
        },
      ],
    },
    transform: jsonSchemaTransform,
  });

  // Serve the generated spec for tooling and the docs UI.
  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  await app.register(scalar, {
    routePrefix: '/doc',
  });
});
