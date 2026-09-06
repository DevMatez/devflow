import fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { createLogger } from '@devflow/observability';
import { env } from './config/env';
import { openapiPlugin } from './plugins/openapi';
import { correlationPlugin } from './plugins/correlation';
import { databasePlugin } from './plugins/database';
import { queuePlugin } from './plugins/queue';
import { outboxRelayPlugin } from './plugins/outbox-relay';
import { webhookRelayPlugin } from './plugins/webhook-relay';
import { githubIntegrationPlugin } from './plugins/github-integration';
import { planeIntegrationPlugin } from './plugins/plane-integration';
import { slackIntegrationPlugin } from './plugins/slack-integration';
import { authPlugin } from './plugins/auth';
import { registerRoutes } from './routes';

export async function buildApp(): Promise<FastifyInstance> {
  const app = fastify({
    loggerInstance: createLogger({
      name: 'api',
      level: env.LOG_LEVEL,
      pretty: env.NODE_ENV === 'development',
    }) as FastifyBaseLogger,
  }).withTypeProvider<ZodTypeProvider>();

  // Use Zod as the validation + serialization engine for all routes.
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Core plugins.
  await app.register(sensible);
  // CSP disabled so the Scalar docs UI can load its assets.
  await app.register(helmet, { contentSecurityPolicy: false });
  // credentials: true so the session cookie is sent on cross-origin
  // requests from apps/web; requires a reflected (non-wildcard) origin.
  await app.register(cors, { origin: true, credentials: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  // Threads a correlation id through every request (and jobs it enqueues).
  await app.register(correlationPlugin);

  // Foundation infrastructure: Postgres, Redis/BullMQ, then the outbox
  // relay + worker that depend on both being available.
  await app.register(databasePlugin);
  // Session cookie → request.user; depends on app.db.
  await app.register(authPlugin);
  await app.register(queuePlugin);
  await app.register(outboxRelayPlugin);
  await app.register(webhookRelayPlugin);
  await app.register(githubIntegrationPlugin);
  await app.register(planeIntegrationPlugin);
  await app.register(slackIntegrationPlugin);

  // API docs (OpenAPI + Scalar).
  await app.register(openapiPlugin);

  // Versioned feature routes (/api/v1, ...).
  await app.register(registerRoutes);

  return app;
}
