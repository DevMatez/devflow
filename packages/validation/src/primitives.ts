import { z } from 'zod';

export const uuidSchema = z.string().uuid();
export const emailSchema = z.string().email();

/** Lowercase kebab-case slug (e.g. an org or project slug). */
export const slugSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Must be a lowercase kebab-case slug');

/** Derives a canonical slug from a name; a client-supplied slug is validated instead, never mutated. */
export function normalizeSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
