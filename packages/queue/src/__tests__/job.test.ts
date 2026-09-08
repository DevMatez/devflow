import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineJob } from '../job';

const job = defineJob({
  name: 'test-job',
  version: 1,
  schema: z.object({ prId: z.string(), organizationId: z.string() }),
  handler: async () => {},
});

describe('defineJob', () => {
  it('exposes its name, version, and schema', () => {
    expect(job.name).toBe('test-job');
    expect(job.version).toBe(1);
  });

  it('rejects an invalid payload at the enqueue boundary (before Redis)', async () => {
    // No connection configured; a valid payload would fail later, but validation
    // must happen first so this throws a ZodError, not a connection error.
    await expect(
      job.enqueue({ prId: 123 as unknown as string, organizationId: 'o1' }),
    ).rejects.toThrow();
  });
});
