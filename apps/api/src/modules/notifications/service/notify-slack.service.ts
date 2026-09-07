import { schema, type Database } from '@devflow/database';
import { and, eq } from 'drizzle-orm';
import { decryptCredentials, type ChatPort } from '@devflow/integrations-core';
import { createSlackChatAdapter } from '@devflow/integrations-slack';
import type { OrganizationId } from '@devflow/types';
import { findConnection } from '../../integrations/dal/connections.dal';
import type { SlackCredentials } from '../../integrations/service/slack-connect.service';
import { findWorkItemById } from '../../work-items/dal/work-items.dal';

export interface ResolvedChat {
  adapter: ChatPort;
  connectionId: string;
}

/** Resolve -> decrypt -> build a live Slack adapter. Injectable so tests can stub it. */
export type ResolveChat = (
  db: Database,
  organizationId: string,
  credentialsKey: Buffer,
) => Promise<ResolvedChat | null>;

export const resolveSlackChat: ResolveChat = async (db, organizationId, credentialsKey) => {
  const connection = await findConnection(db, organizationId, 'chat');
  if (!connection) return null;

  const decrypted = decryptCredentials(credentialsKey, {
    ciphertext: connection.encryptedCredentials,
    iv: connection.credentialsIv,
  });
  const { botAccessToken } = JSON.parse(decrypted) as SlackCredentials;

  return {
    adapter: createSlackChatAdapter({ botToken: botAccessToken }),
    connectionId: connection.id,
  };
};

/** The DevFlow event shape the notifier needs (design §8, subset consumed per §1/§15.3). */
export interface NotifiableEvent {
  organizationId: string;
  type: string;
  payload: unknown;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return (payload ?? {}) as Record<string, unknown>;
}

/** A short, human-readable line for the key workflow events; `null` for anything not worth notifying on. */
function messageFor(event: NotifiableEvent, title: string): string | null {
  const p = asRecord(event.payload);
  switch (event.type) {
    case 'devworkflow.work_started':
      return `:rocket: Work started on *${title}*`;
    case 'devworkflow.pull_request_opened':
      return `:twisted_rightwards_arrows: Pull request opened for *${title}*: ${String(p.url ?? '')}`;
    case 'workitem.state_changed':
      return p.to === 'done' ? `:white_check_mark: *${title}* is done` : null;
    default:
      return null;
  }
}

/**
 * Thin notification consumer (design §1, §5, §11, §13, §15.3): posts a short
 * line to the project's configured Slack channel on the key workflow events.
 * No preferences/UI this wave -- absent `notificationChannelId` just skips.
 */
export async function notifySlack(
  db: Database,
  event: NotifiableEvent,
  credentialsKey: Buffer,
  resolve: ResolveChat = resolveSlackChat,
): Promise<void> {
  const p = asRecord(event.payload);
  const workItemId = p.workItemId as string | undefined;
  if (!workItemId) return;

  const workItem = await findWorkItemById(db, event.organizationId, workItemId);
  if (!workItem) return;

  const project = await db.query.projects.findFirst({
    where: and(
      eq(schema.projects.organizationId, event.organizationId),
      eq(schema.projects.id, workItem.projectId),
    ),
  });
  const channelId = project?.workflowConfig.notificationChannelId;
  if (!channelId) return;

  const title = workItem.externalIssueKey ?? workItem.title;
  const text = messageFor(event, title);
  if (!text) return;

  const chat = await resolve(db, event.organizationId, credentialsKey);
  if (!chat) return;

  await chat.adapter.postMessage(
    { organizationId: event.organizationId as OrganizationId, connectionId: chat.connectionId },
    { channelExternalId: channelId, text },
  );
}
