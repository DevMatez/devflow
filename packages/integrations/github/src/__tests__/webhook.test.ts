import { describe, expect, it, vi } from 'vitest';
import { sign } from '@octokit/webhooks-methods';
import { createGithubWebhookHandler } from '../webhook';
import type { RawWebhookRequest } from '@devflow/integrations-core';

const SECRET = 'test-webhook-secret';

function makeRequest(payload: unknown, headers: Record<string, string> = {}): RawWebhookRequest {
  return {
    headers,
    rawBody: Buffer.from(JSON.stringify(payload)),
  };
}

describe('createGithubWebhookHandler: verify', () => {
  it('resolves for a validly signed payload', async () => {
    const payload = { action: 'opened' };
    const signature = await sign(SECRET, JSON.stringify(payload));
    const handler = createGithubWebhookHandler({
      webhookSecret: SECRET,
      findConnectionByInstallationId: vi.fn(),
    });

    await expect(
      handler.verify(makeRequest(payload, { 'x-hub-signature-256': signature })),
    ).resolves.toBeUndefined();
  });

  it('throws when the signature header is missing', async () => {
    const handler = createGithubWebhookHandler({
      webhookSecret: SECRET,
      findConnectionByInstallationId: vi.fn(),
    });

    await expect(handler.verify(makeRequest({ action: 'opened' }))).rejects.toThrow(
      'Missing X-Hub-Signature-256 header',
    );
  });

  it('throws for a signature that does not match', async () => {
    const handler = createGithubWebhookHandler({
      webhookSecret: SECRET,
      findConnectionByInstallationId: vi.fn(),
    });

    await expect(
      handler.verify(
        makeRequest({ action: 'opened' }, { 'x-hub-signature-256': 'sha256=deadbeef' }),
      ),
    ).rejects.toThrow('Invalid GitHub webhook signature');
  });
});

describe('createGithubWebhookHandler: extractDeliveryId', () => {
  it('returns the X-GitHub-Delivery header', () => {
    const handler = createGithubWebhookHandler({
      webhookSecret: SECRET,
      findConnectionByInstallationId: vi.fn(),
    });
    const id = handler.extractDeliveryId(makeRequest({}, { 'x-github-delivery': 'delivery-1' }));
    expect(id).toBe('delivery-1');
  });

  it('throws when the header is missing', () => {
    const handler = createGithubWebhookHandler({
      webhookSecret: SECRET,
      findConnectionByInstallationId: vi.fn(),
    });
    expect(() => handler.extractDeliveryId(makeRequest({}))).toThrow(
      'Missing X-GitHub-Delivery header',
    );
  });
});

describe('createGithubWebhookHandler: resolveConnection', () => {
  it('looks up the connection by installation id', async () => {
    const findConnectionByInstallationId = vi
      .fn()
      .mockResolvedValue({ organizationId: 'org-1', connectionId: 'conn-1' });
    const handler = createGithubWebhookHandler({
      webhookSecret: SECRET,
      findConnectionByInstallationId,
    });

    const resolved = await handler.resolveConnection(makeRequest({ installation: { id: 555 } }));

    expect(findConnectionByInstallationId).toHaveBeenCalledWith('555');
    expect(resolved).toEqual({ organizationId: 'org-1', connectionId: 'conn-1' });
  });

  it('returns null when the payload has no installation', async () => {
    const handler = createGithubWebhookHandler({
      webhookSecret: SECRET,
      findConnectionByInstallationId: vi.fn(),
    });
    const resolved = await handler.resolveConnection(makeRequest({}));
    expect(resolved).toBeNull();
  });
});

describe('createGithubWebhookHandler: normalize', () => {
  const handler = createGithubWebhookHandler({
    webhookSecret: SECRET,
    findConnectionByInstallationId: vi.fn(),
  });

  const pullRequest = {
    id: 100,
    number: 7,
    title: 'Add feature',
    html_url: 'https://github.com/acme/widgets/pull/7',
    head: { ref: 'feature' },
    base: { ref: 'main' },
    user: { id: 42 },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
  };

  it('normalizes a pull_request opened event', async () => {
    const events = await handler.normalize(
      makeRequest(
        {
          action: 'opened',
          pull_request: { ...pullRequest, state: 'open' },
          repository: { full_name: 'acme/widgets' },
        },
        { 'x-github-event': 'pull_request' },
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('sourcecontrol.pull_request.opened');
    expect(events[0]?.aggregateId).toBe('100');
  });

  it('normalizes a pull_request closed+merged event as merged', async () => {
    const events = await handler.normalize(
      makeRequest(
        {
          action: 'closed',
          pull_request: { ...pullRequest, state: 'closed', merged: true },
          repository: { full_name: 'acme/widgets' },
        },
        { 'x-github-event': 'pull_request' },
      ),
    );
    expect(events[0]?.type).toBe('sourcecontrol.pull_request.merged');
  });

  it('normalizes a pull_request closed-without-merge event as closed', async () => {
    const events = await handler.normalize(
      makeRequest(
        {
          action: 'closed',
          pull_request: { ...pullRequest, state: 'closed', merged: false },
          repository: { full_name: 'acme/widgets' },
        },
        { 'x-github-event': 'pull_request' },
      ),
    );
    expect(events[0]?.type).toBe('sourcecontrol.pull_request.closed');
  });

  it('normalizes a pull_request reopened event as updated', async () => {
    const events = await handler.normalize(
      makeRequest(
        {
          action: 'reopened',
          pull_request: { ...pullRequest, state: 'open' },
          repository: { full_name: 'acme/widgets' },
        },
        { 'x-github-event': 'pull_request' },
      ),
    );
    expect(events[0]?.type).toBe('sourcecontrol.pull_request.updated');
  });

  it('ignores pull_request actions with no normalized mapping', async () => {
    const events = await handler.normalize(
      makeRequest(
        { action: 'labeled', pull_request: pullRequest, repository: { full_name: 'acme/widgets' } },
        { 'x-github-event': 'pull_request' },
      ),
    );
    expect(events).toEqual([]);
  });

  it('normalizes a pull_request_review submitted event', async () => {
    const events = await handler.normalize(
      makeRequest(
        { action: 'submitted', review: { id: 9 } },
        { 'x-github-event': 'pull_request_review' },
      ),
    );
    expect(events[0]?.type).toBe('sourcecontrol.pull_request_review.submitted');
  });

  it('normalizes a check_run event', async () => {
    const events = await handler.normalize(
      makeRequest(
        {
          action: 'completed',
          check_run: {
            id: 3,
            name: 'build',
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://x',
          },
        },
        { 'x-github-event': 'check_run' },
      ),
    );
    expect(events[0]?.type).toBe('sourcecontrol.check_run.updated');
  });

  it('normalizes an issue_comment created event on a pull request', async () => {
    const events = await handler.normalize(
      makeRequest(
        {
          action: 'created',
          issue: { pull_request: {} },
          comment: {
            id: 5,
            body: 'hi',
            user: { id: 1 },
            html_url: 'https://x',
            created_at: '2026-01-01T00:00:00Z',
          },
        },
        { 'x-github-event': 'issue_comment' },
      ),
    );
    expect(events[0]?.type).toBe('sourcecontrol.comment.created');
  });

  it('ignores an issue_comment on a plain issue (no pull_request key)', async () => {
    const events = await handler.normalize(
      makeRequest(
        {
          action: 'created',
          issue: {},
          comment: {
            id: 5,
            body: 'hi',
            user: { id: 1 },
            html_url: 'https://x',
            created_at: '2026-01-01T00:00:00Z',
          },
        },
        { 'x-github-event': 'issue_comment' },
      ),
    );
    expect(events).toEqual([]);
  });

  it('returns an empty array for an unrecognized event name', async () => {
    const events = await handler.normalize(makeRequest({}, { 'x-github-event': 'star' }));
    expect(events).toEqual([]);
  });
});
