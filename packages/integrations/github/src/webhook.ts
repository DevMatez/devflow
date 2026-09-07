import { verify } from '@octokit/webhooks-methods';
import type {
  WebhookHandler,
  RawWebhookRequest,
  ResolvedConnection,
  NormalizedWebhookEvent,
} from '@devflow/integrations-core';
import {
  toPullRequest,
  toComment,
  toCheckRun,
  type GithubPullRequest,
  type GithubCheckRun,
  type GithubComment,
} from './mappers';

export interface GithubWebhookHandlerOptions {
  webhookSecret: string;
  /** Injected by the composition root — this package never touches a database directly. */
  findConnectionByInstallationId(installationId: string): Promise<ResolvedConnection | null>;
}

function header(request: RawWebhookRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function parsePayload(request: RawWebhookRequest): Record<string, unknown> {
  return JSON.parse(request.rawBody.toString('utf8'));
}

/** Implements `WebhookHandler` for GitHub (design doc §5). */
export function createGithubWebhookHandler(options: GithubWebhookHandlerOptions): WebhookHandler {
  return {
    async verify(request: RawWebhookRequest): Promise<void> {
      const signature = header(request, 'x-hub-signature-256');
      if (!signature) throw new Error('Missing X-Hub-Signature-256 header');

      const valid = await verify(
        options.webhookSecret,
        request.rawBody.toString('utf8'),
        signature,
      );
      if (!valid) throw new Error('Invalid GitHub webhook signature');
    },

    extractDeliveryId(request: RawWebhookRequest): string {
      const id = header(request, 'x-github-delivery');
      if (!id) throw new Error('Missing X-GitHub-Delivery header');
      return id;
    },

    async resolveConnection(request: RawWebhookRequest): Promise<ResolvedConnection | null> {
      const payload = parsePayload(request);
      const installation = payload.installation as { id?: number | string } | undefined;
      if (installation?.id === undefined) return null;
      return options.findConnectionByInstallationId(String(installation.id));
    },

    async normalize(request: RawWebhookRequest): Promise<NormalizedWebhookEvent[]> {
      const eventName = header(request, 'x-github-event');
      const payload = parsePayload(request);
      if (!eventName) return [];
      return normalizeEvent(eventName, payload);
    },
  };
}

function normalizeEvent(
  eventName: string,
  payload: Record<string, unknown>,
): NormalizedWebhookEvent[] {
  switch (eventName) {
    case 'pull_request':
      return normalizePullRequestEvent(payload);
    case 'pull_request_review':
      return normalizePullRequestReviewEvent(payload);
    case 'check_run':
      return normalizeCheckRunEvent(payload);
    case 'issue_comment':
      return normalizeIssueCommentEvent(payload);
    default:
      return [];
  }
}

function repoFullName(payload: Record<string, unknown>): string {
  const repository = payload.repository as { full_name: string };
  return repository.full_name;
}

function normalizePullRequestEvent(payload: Record<string, unknown>): NormalizedWebhookEvent[] {
  const action = payload.action as string;
  const pr = toPullRequest(payload.pull_request as GithubPullRequest, repoFullName(payload));

  const typeByAction: Record<string, string> = {
    opened: 'sourcecontrol.pull_request.opened',
    synchronize: 'sourcecontrol.pull_request.updated',
    edited: 'sourcecontrol.pull_request.updated',
    // GitHub has no distinct "reopened" canonical type (design §6.3) — the
    // reconciler derives a reopen from an `updated` event whose PR is open
    // again against a work item it had already marked terminal.
    reopened: 'sourcecontrol.pull_request.updated',
    closed:
      pr.state === 'merged'
        ? 'sourcecontrol.pull_request.merged'
        : 'sourcecontrol.pull_request.closed',
  };

  const type = typeByAction[action];
  if (!type) return [];

  return [{ type, aggregateId: pr.externalId, payload: pr }];
}

function normalizePullRequestReviewEvent(
  payload: Record<string, unknown>,
): NormalizedWebhookEvent[] {
  if (payload.action !== 'submitted') return [];
  const review = payload.review as { id: number | string };
  return [
    {
      type: 'sourcecontrol.pull_request_review.submitted',
      aggregateId: String(review.id),
      payload: review,
    },
  ];
}

function normalizeCheckRunEvent(payload: Record<string, unknown>): NormalizedWebhookEvent[] {
  const checkRun = toCheckRun(payload.check_run as GithubCheckRun);
  return [
    {
      type: 'sourcecontrol.check_run.updated',
      aggregateId: checkRun.externalId,
      payload: checkRun,
    },
  ];
}

function normalizeIssueCommentEvent(payload: Record<string, unknown>): NormalizedWebhookEvent[] {
  if (payload.action !== 'created') return [];
  // Comments on PRs arrive as `issue_comment` (PRs are issues under the hood) — inline diff
  // comments (`pull_request_review_comment`) are a follow-up, not blocking this wave.
  if (!('pull_request' in (payload.issue as Record<string, unknown>))) return [];

  const comment = toComment(payload.comment as GithubComment);
  return [
    { type: 'sourcecontrol.comment.created', aggregateId: comment.externalId, payload: comment },
  ];
}
