import type {
  ChatPort,
  PostMessageInput,
  ChatChannel,
  ChatMessage,
} from '@devflow/integrations-core';
import { createSlackClient, type SlackClientOptions } from './client';
import { toChatChannel, toChatMessage, type SlackConversation, type SlackMessage } from './mappers';

export type SlackAdapterOptions = SlackClientOptions;

interface ConversationsListResponse {
  ok: boolean;
  channels: SlackConversation[];
}

interface ChatPostMessageResponse {
  ok: boolean;
  channel: string;
  ts: string;
  message: SlackMessage;
}

/** One instance per resolved connection (built by the registry's createAdapter callback) — already bot-token-scoped. */
export function createSlackChatAdapter(options: SlackAdapterOptions): ChatPort {
  const client = createSlackClient(options);

  return {
    async listChannels(): Promise<ChatChannel[]> {
      const data = await client.call<ConversationsListResponse>('conversations.list', {
        types: 'public_channel,private_channel',
      });
      return data.channels.map(toChatChannel);
    },

    async postMessage(_ctx, input: PostMessageInput): Promise<ChatMessage> {
      const data = await client.call<ChatPostMessageResponse>('chat.postMessage', {
        channel: input.channelExternalId,
        text: input.text,
      });
      return toChatMessage({ ...data.message, ts: data.ts }, data.channel);
    },
  };
}
