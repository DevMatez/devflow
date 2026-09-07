import { z } from 'zod';
import type { BranchRef, PrRef } from '@devflow/types';
import { branchRefStatusSchema, prRefStateSchema } from './enums';

/** Mirrors `BranchRef` in `@devflow/types` — keep both in sync. */
export const branchRefSchema = z.object({
  repo: z.string().min(1),
  name: z.string().min(1),
  base: z.string().min(1).optional(),
  url: z.string().url().optional(),
  status: branchRefStatusSchema,
});

/** Mirrors `PrRef` in `@devflow/types` — keep both in sync. */
export const prRefSchema = z.object({
  repo: z.string().min(1),
  number: z.number().int().positive(),
  url: z.string().url().optional(),
  state: prRefStateSchema,
});

// Fail to compile if the schemas and the types drift apart.
type _BranchRefMatches =
  z.infer<typeof branchRefSchema> extends BranchRef
    ? BranchRef extends z.infer<typeof branchRefSchema>
      ? true
      : never
    : never;
const _branchRefTypeCheck: _BranchRefMatches = true;
void _branchRefTypeCheck;

type _PrRefMatches =
  z.infer<typeof prRefSchema> extends PrRef
    ? PrRef extends z.infer<typeof prRefSchema>
      ? true
      : never
    : never;
const _prRefTypeCheck: _PrRefMatches = true;
void _prRefTypeCheck;
