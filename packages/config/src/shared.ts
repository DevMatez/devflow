import { z } from 'zod';

/** Common environment-variable fragments composed into app-specific schemas. */

export const nodeEnv = () => z.enum(['development', 'test', 'production']).default('development');

export const logLevel = () =>
  z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info');

export const host = (fallback = '0.0.0.0') => z.string().min(1).default(fallback);

export const port = (fallback = 3000) => z.coerce.number().int().positive().default(fallback);

/** Required non-empty string (e.g. connection strings). */
export const requiredString = () => z.string().min(1);

/** Optional URL string. */
export const url = () => z.string().url();
