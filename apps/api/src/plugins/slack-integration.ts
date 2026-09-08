import fp from 'fastify-plugin';
import { createSlackWebhookHandler } from '@devflow/integrations-slack';
import type { OrganizationId } from '@devflow/types';
import { env } from '../config/env';
import { webhookHandlers } from '../modules/integrations/webhook-handlers';
import { getConnectionByTeamId } from '../modules/integrations/service/connections.service';

/** Registers the Slack webhook handler at boot (design doc §7). */
export const slackIntegrationPlugin = fp(async (app) => {
  webhookHandlers.slack = createSlackWebhookHandler({
    signingSecret: env.SLACK_SIGNING_SECRET,
    findConnectionByTeamId: async (teamId) => {
      const connection = await getConnectionByTeamId(app.db, teamId);
      if (!connection) return null;
      return {
        organizationId: connection.organizationId as OrganizationId,
        connectionId: connection.id,
      };
    },
  });
});
