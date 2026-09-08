import fp from 'fastify-plugin';
import { randomUUID } from 'node:crypto';
import { runWithCorrelationId } from '@devflow/observability';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

/**
 * Threads one correlation id through the whole request (and any job it
 * enqueues) via AsyncLocalStorage — every log line from `@devflow/observability`'s
 * logger picks it up automatically through its `mixin`.
 */
export const correlationPlugin = fp(async (app) => {
  app.addHook('onRequest', (request, reply, done) => {
    const header = request.headers['x-correlation-id'];
    const correlationId = typeof header === 'string' && header.length > 0 ? header : randomUUID();

    request.correlationId = correlationId;
    reply.header('x-correlation-id', correlationId);

    runWithCorrelationId(correlationId, () => done());
  });
});
