import { type FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import { env } from '../../../config/env';
import { requireOrgRole, resolveOrgContext } from '../../../modules/access/org-context';
import {
  requireAuth,
  setIntegrationOAuthStateCookie,
  consumeIntegrationOAuthStateCookie,
} from '../../../plugins/auth';
import { createOAuthState, verifyOAuthState } from '../../../modules/integrations/oauth-state';
import {
  listConnections,
  disconnect,
  ConnectionNotFoundError,
  type ConnectionRow,
} from '../../../modules/integrations/service/connections.service';
import {
  completeGithubInstall,
  decodeGithubAppPrivateKey,
} from '../../../modules/integrations/service/github-connect.service';
import { connectPlaneWorkspace } from '../../../modules/integrations/service/plane-connect.service';
import { completeSlackInstall } from '../../../modules/integrations/service/slack-connect.service';
import { parseCredentialsKey } from '@devflow/integrations-core';
import { PlaneApiError } from '@devflow/integrations-plane';
import {
  buildSlackAuthorizeUrl,
  SlackOAuthError,
  type SlackOAuthConfig,
} from '@devflow/integrations-slack';
import {
  integrationCategoryParamsSchema,
  connectionResponseSchema,
  connectionsListResponseSchema,
  githubInstallCallbackQuerySchema,
  planeConnectBodySchema,
  slackOAuthCallbackQuerySchema,
} from './schema';
import { organizationParamsSchema } from '../organizations/schema';

const OAUTH_STATE_TTL_MS = () => env.OAUTH_STATE_TTL_MINUTES * 60_000;

const SLACK_BOT_SCOPES = 'chat:write,channels:read,groups:read';

function slackConfig(): SlackOAuthConfig {
  return {
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    redirectUri: env.SLACK_OAUTH_CALLBACK_URL,
    scopes: SLACK_BOT_SCOPES,
  };
}

/** Never spreads the row — `encryptedCredentials`/`credentialsIv` must never leave the service layer. */
function toConnectionResponse(row: ConnectionRow) {
  return {
    id: row.id,
    category: row.category,
    provider: row.provider,
    status: row.status,
    externalAccount: row.externalAccount,
    tokenExpiresAt: row.tokenExpiresAt,
    lastSyncedAt: row.lastSyncedAt,
    lastFailureAt: row.lastFailureAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function integrationsRouter(app: FastifyInstance): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    '/organizations/:organizationId/integrations',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Integrations'],
        summary: 'List integration connections',
        description: 'Lists connections and their health for the organization. Admin/owner only.',
        params: organizationParamsSchema,
        response: { 200: connectionsListResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();
      const connections = await listConnections(app.db, request.orgContext);
      return { connections: connections.map(toConnectionResponse) };
    },
  );

  typed.delete(
    '/organizations/:organizationId/integrations/:category',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Integrations'],
        summary: 'Disconnect an integration',
        description: 'Marks the connection revoked and wipes stored credentials. Admin/owner only.',
        params: integrationCategoryParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        await disconnect(app.db, request.orgContext, request.params.category);
      } catch (error) {
        if (error instanceof ConnectionNotFoundError) return reply.notFound(error.message);
        throw error;
      }

      return reply.code(204).send();
    },
  );

  typed.get(
    '/organizations/:organizationId/integrations/github/install',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Integrations'],
        summary: 'Start a GitHub App install',
        description:
          'Sets a short-lived signed state cookie and redirects to the GitHub App install URL (design doc §5).',
        params: organizationParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      const state = createOAuthState(env.SESSION_COOKIE_SECRET, OAUTH_STATE_TTL_MS(), {
        organizationId: request.orgContext.organizationId,
        provider: 'github',
      });
      setIntegrationOAuthStateCookie(reply, state);

      const url = new URL(`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new`);
      url.searchParams.set('state', state);
      return reply.redirect(url.toString(), 302);
    },
  );

  // Fixed path, not org-scoped: a GitHub App has exactly one static callback
  // URL — the org id can only travel through the signed `state` (design doc
  // §12), never a per-org path segment GitHub itself would need to know about.
  typed.get(
    '/integrations/github/callback',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Integrations'],
        summary: 'Complete a GitHub App install',
        description:
          'Verifies the signed state, re-verifies the caller is an org admin/owner, fetches the ' +
          'installation via the App JWT, and stores the connection.',
        querystring: githubInstallCallbackQuerySchema,
      },
    },
    async (request, reply) => {
      if (!request.user) return reply.unauthorized();
      const { installation_id: installationId, state } = request.query;

      const parsedState = verifyOAuthState(env.SESSION_COOKIE_SECRET, state);
      const cookieState = consumeIntegrationOAuthStateCookie(request, reply);
      if (!parsedState || parsedState.provider !== 'github' || cookieState !== state) {
        return reply.badRequest('Invalid or expired OAuth state');
      }

      if (!installationId) {
        return reply.badRequest('Missing installation_id (install was not completed)');
      }

      const ctx = await resolveOrgContext(
        app.db,
        parsedState.organizationId,
        request.user.id,
        'admin',
      );
      if (!ctx) return reply.forbidden();

      await completeGithubInstall(
        app.db,
        ctx,
        {
          appId: env.GITHUB_APP_ID,
          privateKey: decodeGithubAppPrivateKey(env.GITHUB_APP_PRIVATE_KEY_BASE64),
        },
        parseCredentialsKey(env.INTEGRATION_CREDENTIALS_KEY),
        installationId,
      );

      return reply.redirect(`${env.WEB_APP_URL}/settings/integrations?connected=github`, 302);
    },
  );

  typed.post(
    '/organizations/:organizationId/integrations/plane/connect',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Integrations'],
        summary: 'Connect a Plane workspace',
        description:
          'Token-based connect (design doc §6) — validates the API token against the workspace ' +
          'before storing the connection. Admin/owner only.',
        params: organizationParamsSchema,
        body: planeConnectBodySchema,
        response: { 201: connectionResponseSchema },
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      try {
        const row = await connectPlaneWorkspace(
          app.db,
          request.orgContext,
          parseCredentialsKey(env.INTEGRATION_CREDENTIALS_KEY),
          request.body,
        );
        reply.code(201);
        return toConnectionResponse(row);
      } catch (error) {
        if (error instanceof PlaneApiError) {
          return reply.badRequest(`Could not verify the Plane workspace/token: ${error.message}`);
        }
        throw error;
      }
    },
  );

  typed.get(
    '/organizations/:organizationId/integrations/slack/authorize',
    {
      preHandler: requireOrgRole('admin'),
      schema: {
        tags: ['Integrations'],
        summary: 'Start a Slack OAuth install',
        description:
          "Sets a short-lived signed state cookie and redirects to Slack's OAuth v2 authorize URL (design doc §7).",
        params: organizationParamsSchema,
      },
    },
    async (request, reply) => {
      if (!request.orgContext) return reply.forbidden();

      const state = createOAuthState(env.SESSION_COOKIE_SECRET, OAUTH_STATE_TTL_MS(), {
        organizationId: request.orgContext.organizationId,
        provider: 'slack',
      });
      setIntegrationOAuthStateCookie(reply, state);

      return reply.redirect(buildSlackAuthorizeUrl(slackConfig(), state), 302);
    },
  );

  // Fixed path, not org-scoped: the redirect_uri is a single value registered
  // with Slack and must match exactly across both OAuth steps (same reasoning
  // as GitHub's callback, design doc §12) — org context travels via state only.
  typed.get(
    '/integrations/slack/callback',
    {
      preHandler: requireAuth,
      schema: {
        tags: ['Integrations'],
        summary: 'Complete a Slack OAuth install',
        description:
          'Verifies the signed state, re-verifies the caller is an org admin/owner, exchanges the ' +
          'code for a bot token, and stores the connection.',
        querystring: slackOAuthCallbackQuerySchema,
      },
    },
    async (request, reply) => {
      if (!request.user) return reply.unauthorized();
      const { code, state, error } = request.query;

      if (error || !code) {
        return reply.badRequest('Slack authorization was not completed');
      }

      const parsedState = verifyOAuthState(env.SESSION_COOKIE_SECRET, state);
      const cookieState = consumeIntegrationOAuthStateCookie(request, reply);
      if (!parsedState || parsedState.provider !== 'slack' || cookieState !== state) {
        return reply.badRequest('Invalid or expired OAuth state');
      }

      const ctx = await resolveOrgContext(
        app.db,
        parsedState.organizationId,
        request.user.id,
        'admin',
      );
      if (!ctx) return reply.forbidden();

      try {
        await completeSlackInstall(
          app.db,
          ctx,
          slackConfig(),
          parseCredentialsKey(env.INTEGRATION_CREDENTIALS_KEY),
          code,
        );
      } catch (thrown) {
        if (thrown instanceof SlackOAuthError) return reply.badGateway(thrown.message);
        throw thrown;
      }

      return reply.redirect(`${env.WEB_APP_URL}/settings/integrations?connected=slack`, 302);
    },
  );
}
