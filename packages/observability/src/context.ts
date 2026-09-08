import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

interface CorrelationStore {
  correlationId: string;
}

const storage = new AsyncLocalStorage<CorrelationStore>();

export function generateCorrelationId(): string {
  return randomUUID();
}

/** Runs `fn` with the given correlation id available to everything downstream. */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** The correlation id for the current async context, if any. */
export function getCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
