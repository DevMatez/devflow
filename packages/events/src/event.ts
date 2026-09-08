import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export type EventId = string;
export type CorrelationId = string;
export type CausationId = string;

export interface DomainEvent<Type extends string = string, Payload = unknown> {
  id: EventId;
  type: Type;
  organizationId: string;
  aggregateId: string;
  correlationId: CorrelationId;
  causationId?: CausationId;
  occurredAt: string; // ISO 8601
  schemaVersion: number;
  aggregateVersion?: number;
  payload: Payload;
}

export type EventOrdering = 'aggregate' | 'none';

export interface EventDefinitionInput<S extends z.ZodType> {
  type: string;
  schemaVersion: number;
  schema: S;
  /** 'aggregate' requires aggregateVersion on every .create(); 'none' (default) does not. */
  ordering?: EventOrdering;
}

export interface CreateEventInput<S extends z.ZodType> {
  organizationId: string;
  aggregateId: string;
  correlationId: CorrelationId;
  causationId?: CausationId;
  aggregateVersion?: number;
  payload: z.infer<S>;
}

export interface EventDefinition<Type extends string, S extends z.ZodType> {
  type: Type;
  schemaVersion: number;
  schema: S;
  ordering: EventOrdering;
  create(input: CreateEventInput<S>): DomainEvent<Type, z.infer<S>>;
}

/** Declares a typed, canonical event definition (name, schema, ordering). */
export function defineEvent<Type extends string, S extends z.ZodType>(
  def: EventDefinitionInput<S> & { type: Type },
): EventDefinition<Type, S> {
  const ordering = def.ordering ?? 'none';

  return {
    type: def.type,
    schemaVersion: def.schemaVersion,
    schema: def.schema,
    ordering,
    create(input) {
      if (ordering === 'aggregate' && input.aggregateVersion === undefined) {
        throw new Error(
          `Event "${def.type}" declares ordering: 'aggregate' and requires aggregateVersion on create()`,
        );
      }

      // Validate at creation time, before the event ever reaches the outbox.
      const payload = def.schema.parse(input.payload);

      return {
        id: randomUUID(),
        type: def.type,
        organizationId: input.organizationId,
        aggregateId: input.aggregateId,
        correlationId: input.correlationId,
        causationId: input.causationId,
        occurredAt: new Date().toISOString(),
        schemaVersion: def.schemaVersion,
        aggregateVersion: input.aggregateVersion,
        payload,
      };
    },
  };
}
