import type { ChatChannel, ChatMessage } from '@devflow/integrations-core';

export interface SlackConversation {
  id: string;
  name?: string;
}

export interface SlackMessage {
  ts: string;
  text?: string;
  bot_id?: string;
  user?: string;
}

export function toChatChannel(conversation: SlackConversation): ChatChannel {
  return {
    externalId: conversation.id,
    name: conversation.name ?? conversation.id,
  };
}

function tsToIso(ts: string): string {
  return new Date(Number.parseFloat(ts) * 1000).toISOString();
}

export function toChatMessage(message: SlackMessage, channelExternalId: string): ChatMessage {
  return {
    externalId: message.ts,
    channelExternalId,
    text: message.text ?? '',
    authorExternalId: message.bot_id ?? message.user ?? 'unknown',
    postedAt: tsToIso(message.ts),
  };
}
