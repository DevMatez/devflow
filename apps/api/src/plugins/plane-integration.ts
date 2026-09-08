import fp from 'fastify-plugin';
import { createPlaneWebhookHandler } from '@devflow/integrations-plane';
import { parseCredentialsKey } from '@devflow/integrations-core';
import type { OrganizationId } from '@devflow/types';
import { env } from '../config/env';
import { webhookHandlers } from '../modules/integrations/webhook-handlers';
import { getConnectionByWorkspaceId } from '../modules/integrations/service/connections.service';
import { getPlaneWebhookSecretForWorkspace } from '../modules/integrations/service/plane-connect.service';

/** Registers the Plane webhook handler at boot (design doc §6). */
export const planeIntegrationPlugin = fp(async (app) => {
  const credentialsKey = parseCredentialsKey(env.INTEGRATION_CREDENTIALS_KEY);

  webhookHandlers.plane = createPlaneWebhookHandler({
    getWebhookSecretForWorkspace: (workspaceId) =>
      getPlaneWebhookSecretForWorkspace(app.db, credentialsKey, workspaceId),
    findConnectionByWorkspaceId: async (workspaceId) => {
      const connection = await getConnectionByWorkspaceId(app.db, workspaceId);
      if (!connection) return null;
      return {
        organizationId: connection.organizationId as OrganizationId,
        connectionId: connection.id,
      };
    },
  });
});
