import pino, { type Logger, type LevelWithSilent } from 'pino';
import { getCorrelationId } from './context';

export interface CreateLoggerOptions {
  name?: string;
  level?: LevelWithSilent;
  /** Pretty-print output (dev). The consuming app must provide `pino-pretty`. */
  pretty?: boolean;
}

/**
 * Creates a Pino logger that automatically attaches the current correlation id
 * (see `context`) to every log line.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { name, level = 'info', pretty = false } = options;

  return pino({
    ...(name ? { name } : {}),
    level,
    mixin() {
      const correlationId = getCorrelationId();
      return correlationId ? { correlationId } : {};
    },
    ...(pretty ? { transport: { target: 'pino-pretty' } } : {}),
  });
}

export type { Logger, LevelWithSilent };
