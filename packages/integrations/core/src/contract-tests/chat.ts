import { describe, expect, it } from 'vitest';
import type { ChatPort } from '../ports';
import type { ProviderContext } from '../ports';

export interface ChatContractFixtures {
  createPort(): ChatPort;
  ctx: ProviderContext;
  channelExternalId: string;
}

/**
 * Shared contract suite every `ChatPort` adapter runs against its own
 * fixtures (design doc §14), mirroring the SourceControl/ProjectManagement suites.
 */
export function runChatPortContractTests(
  adapterName: string,
  fixtures: ChatContractFixtures,
): void {
  describe(`ChatPort contract: ${adapterName}`, () => {
    it('listChannels returns normalized ChatChannel[] shape', async () => {
      const channels = await fixtures.createPort().listChannels(fixtures.ctx);
      expect(Array.isArray(channels)).toBe(true);
      for (const channel of channels) {
        expect(channel).toMatchObject({ externalId: expect.any(String), name: expect.any(String) });
      }
    });

    it('postMessage returns a normalized ChatMessage', async () => {
      const message = await fixtures.createPort().postMessage(fixtures.ctx, {
        channelExternalId: fixtures.channelExternalId,
        text: 'contract test message',
      });
      expect(message).toMatchObject({
        externalId: expect.any(String),
        channelExternalId: expect.any(String),
        text: expect.any(String),
        authorExternalId: expect.any(String),
        postedAt: expect.any(String),
      });
    });
  });
}
