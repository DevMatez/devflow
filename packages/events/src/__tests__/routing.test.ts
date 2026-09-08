import { describe, expect, it, vi } from 'vitest';
import { defineRoute } from '../routing';
import { defineEvent } from '../event';
import { z } from 'zod';

const AiReviewRequested = defineEvent({
  type: 'ai-review.requested',
  schemaVersion: 1,
  schema: z.object({ prId: z.string() }),
});

describe('defineRoute', () => {
  it('enqueues onto the job with a namespaced jobId and mapped payload', async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const jobSchema = z.object({ organizationId: z.string(), pullRequestId: z.string() });

    const route = defineRoute({
      name: 'ai-review',
      event: AiReviewRequested,
      job: { name: 'ai-review', version: 1, schema: jobSchema, enqueue } as never,
      toJobPayload: (payload: { prId: string }) => ({ pullRequestId: payload.prId }),
    });

    const event = AiReviewRequested.create({
      organizationId: 'org-1',
      aggregateId: 'pr-1',
      correlationId: 'corr-1',
      payload: { prId: 'pr-1' },
    });

    await route.enqueue(event);

    expect(enqueue).toHaveBeenCalledWith(
      { pullRequestId: 'pr-1', organizationId: 'org-1' },
      { jobId: `ai-review.${event.id}`, correlationId: 'corr-1' },
    );
  });

  it('exposes the source event type for relay routing lookups', () => {
    const route = defineRoute({
      name: 'ai-review',
      event: AiReviewRequested,
      job: { enqueue: vi.fn() } as never,
      toJobPayload: (payload: { prId: string }) => ({ pullRequestId: payload.prId }),
    });

    expect(route.eventType).toBe('ai-review.requested');
    expect(route.name).toBe('ai-review');
  });
});
