import { type FastifyInstance } from 'fastify';
import { healthRouter } from './health/router';
import { systemRouter } from './system/router';
import { authRouter } from './auth/router';
import { organizationsRouter } from './organizations/router';
import { invitationsRouter } from './invitations/router';
import { integrationsRouter } from './integrations/router';
import { webhooksRouter } from './webhooks/router';
import { workItemsRouter } from './work-items/router';
import { activityRouter } from './activity/router';

/**
 * Registers all v1 routers. The parent mounts this under /api/v1
 * (see routes/index.ts). Add new modules' v1 routers here.
 */
export async function v1Routes(app: FastifyInstance): Promise<void> {
  await app.register(healthRouter);
  await app.register(systemRouter);
  await app.register(authRouter);
  await app.register(organizationsRouter);
  await app.register(invitationsRouter);
  await app.register(integrationsRouter);
  await app.register(webhooksRouter);
  await app.register(workItemsRouter);
  await app.register(activityRouter);
}
