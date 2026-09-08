import fp from 'fastify-plugin';
import { createGithubWebhookHandler } from '@devflow/integrations-github';
import type { OrganizationId } from '@devflow/types';
import { env } from '../config/env';
import { webhookHandlers } from '../modules/integrations/webhook-handlers';
import { getConnectionByInstallationId } from '../modules/integrations/service/connections.service';

/** Registers the GitHub webhook handler at boot — the reference implementation for the framework (design doc §5). */
export const githubIntegrationPlugin = fp(async (app) => {
  webhookHandlers.github = createGithubWebhookHandler({
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
    findConnectionByInstallationId: async (installationId) => {
      const connection = await getConnectionByInstallationId(app.db, installationId);
      if (!connection) return null;
      return {
        organizationId: connection.organizationId as OrganizationId,
        connectionId: connection.id,
      };
    },
  });
});
