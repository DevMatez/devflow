import fp from 'fastify-plugin';
import { createGoogleCalendarWebhookHandler } from '@devflow/integrations-calendar';
import type { OrganizationId } from '@devflow/types';
import { env } from '../config/env';
import { webhookHandlers } from '../modules/integrations/webhook-handlers';
import { getConnectionByChannelId } from '../modules/integrations/service/connections.service';
import {
  getGoogleCalendarChannelToken,
  getGoogleCalendarSyncContext,
  updateGoogleCalendarSyncToken,
} from '../modules/integrations/service/calendar-connect.service';
import { parseCredentialsKey } from '@devflow/integrations-core';

/** Registers the Calendar webhook handler at boot (design doc §8). */
export const calendarIntegrationPlugin = fp(async (app) => {
  const credentialsKey = parseCredentialsKey(env.INTEGRATION_CREDENTIALS_KEY);

  webhookHandlers.calendar = createGoogleCalendarWebhookHandler({
    getChannelToken: (channelId) =>
      getGoogleCalendarChannelToken(app.db, credentialsKey, channelId),
    getSyncContext: (channelId) =>
      getGoogleCalendarSyncContext(
        app.db,
        credentialsKey,
        { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
        channelId,
      ),
    updateSyncToken: (channelId, syncToken) =>
      updateGoogleCalendarSyncToken(app.db, channelId, syncToken),
    findConnectionByChannelId: async (channelId) => {
      const connection = await getConnectionByChannelId(app.db, channelId);
      if (!connection) return null;
      return {
        organizationId: connection.organizationId as OrganizationId,
        connectionId: connection.id,
      };
    },
  });
});
