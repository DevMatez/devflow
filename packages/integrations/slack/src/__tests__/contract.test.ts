import { runChatPortContractTests } from '@devflow/integrations-core/contract-tests';
import type { ProviderContext } from '@devflow/integrations-core';
import { createSlackChatAdapter } from '../adapter';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

function fakeFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());

    if (url.pathname === '/api/conversations.list') {
      return jsonResponse({ ok: true, channels: [{ id: 'C1', name: 'general' }] });
    }
    if (url.pathname === '/api/chat.postMessage') {
      return jsonResponse({
        ok: true,
        channel: 'C1',
        ts: '1503435956.000247',
        message: { text: 'contract test message', bot_id: 'B1' },
      });
    }
    throw new Error(`Unhandled fetch in contract test: ${url.pathname}`);
  }) as unknown as typeof fetch;
}

runChatPortContractTests('slack', {
  createPort: () => createSlackChatAdapter({ botToken: 'xoxb-test', fetch: fakeFetch() }),
  ctx: { organizationId: 'org-1' as ProviderContext['organizationId'], connectionId: 'conn-1' },
  channelExternalId: 'C1',
});
