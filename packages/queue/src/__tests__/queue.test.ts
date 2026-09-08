import { describe, expect, it } from 'vitest';
import { jobId } from '../ids';
import { withTimeout } from '../timeout';
import { defaultJobOptions } from '../queue';

describe('jobId', () => {
  it('is deterministic and namespace-scoped', () => {
    expect(jobId('ai-review', 'evt-1')).toBe('ai-review.evt-1');
    expect(jobId('ai-review', 'evt-1')).toBe(jobId('ai-review', 'evt-1'));
  });

  it('scopes the same id under different namespaces', () => {
    expect(jobId('slack', 'evt-1')).not.toBe(jobId('github', 'evt-1'));
  });
});

describe('defaultJobOptions', () => {
  it('uses exponential backoff with retries', () => {
    expect(defaultJobOptions.attempts).toBeGreaterThanOrEqual(1);
    expect(defaultJobOptions.backoff).toMatchObject({ type: 'exponential' });
  });
});

describe('withTimeout', () => {
  it('resolves when under the limit', async () => {
    await expect(withTimeout(50, async () => 'ok')).resolves.toBe('ok');
  });

  it('runs without a limit when timeout is undefined', async () => {
    await expect(withTimeout(undefined, async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects when the limit is exceeded', async () => {
    await expect(
      withTimeout(10, () => new Promise((resolve) => setTimeout(resolve, 50))),
    ).rejects.toThrow(/timed out/);
  });
});
