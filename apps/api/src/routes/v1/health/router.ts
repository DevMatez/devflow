import { type FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { healthResponseSchema } from './schema';
import { getHealth } from '../../../modules/health/service/health.service';

export async function healthRouter(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/health',
    {
      schema: {
        tags: ['Health'],
        summary: 'Liveness/health check',
        description:
          'Returns the service status, process uptime (seconds), and current ' +
          'server timestamp (ISO 8601). Used by load balancers and uptime monitors.',
        response: { 200: healthResponseSchema },
      },
    },
    async () => getHealth(),
  );
}
