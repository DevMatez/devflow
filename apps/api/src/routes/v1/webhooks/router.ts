import { type FastifyInstance } from 'fastify';
import { type ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  webhookHandlers,
  getEventTypeHeader,
} from '../../../modules/integrations/webhook-handlers';
import {
  insertWebhookEvent,
  attachConnection,
} from '../../../modules/integrations/dal/webhook-events.dal';
import { webhookProviderParamsSchema } from './schema';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export async function webhooksRouter(app: FastifyInstance): Promise<void> {
  // Scoped to this plugin's encapsulation context only — captures the exact
  // bytes signature verification needs, without affecting other JSON routes.
  app.addContentTypeParser<Buffer>(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      request.rawBody = body;
      if (body.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/webhooks/:provider',
    {
      schema: {
        tags: ['Webhooks'],
        summary: 'Receive a provider webhook',
        description:
          "Unauthenticated; verified via the provider's signature. Fast-acks 200 and nudges " +
          'processing best-effort — the periodic relay is the authoritative path (design doc §4).',
        params: webhookProviderParamsSchema,
      },
    },
    async (request, reply) => {
      const { provider } = request.params;
      const handler = webhookHandlers[provider];
      if (!handler) return reply.notFound(`No webhook handler registered for "${provider}"`);

      const rawRequest = { headers: request.headers, rawBody: request.rawBody ?? Buffer.alloc(0) };

      try {
        await handler.verify(rawRequest);
      } catch {
        return reply.unauthorized();
      }

      // Slack's Events API one-time handshake when a request URL is first configured — must
      // echo the challenge synchronously, before dedupe/persistence even begins (no dedupe key
      // or connection to resolve for this payload shape).
      const body = request.body as { type?: string; challenge?: string } | undefined;
      if (provider === 'slack' && body?.type === 'url_verification' && body.challenge) {
        return reply.code(200).send({ challenge: body.challenge });
      }

      const deliveryId = handler.extractDeliveryId(rawRequest);
      const eventTypeHeader = request.headers[getEventTypeHeader(provider)];
      const eventType = Array.isArray(eventTypeHeader)
        ? (eventTypeHeader[0] ?? 'unknown')
        : (eventTypeHeader ?? 'unknown');

      const row = await insertWebhookEvent(app.db, {
        provider,
        providerDeliveryId: deliveryId,
        eventType,
        payload: request.body,
      });

      // Duplicate delivery: already recorded (and processed, or in flight) — no-op ack.
      if (!row) return reply.code(200).send();

      const resolved = await handler.resolveConnection(rawRequest);
      if (resolved) {
        await attachConnection(app.db, row.id, resolved);
      }

      reply.code(200).send();

      // Fast-path optimization only — never the only path to processing (§4).
      app.runWebhookRelayOnce().catch((error: unknown) => {
        app.log.warn({ err: error }, 'fast-path webhook relay nudge failed');
      });
    },
  );
}
