import { schema, type Database, type DatabaseTransaction } from '@devflow/database';
import { and, desc, eq } from 'drizzle-orm';

export type ActivityRow = typeof schema.activity.$inferSelect;

export interface InsertActivityInput {
  organizationId: string;
  workItemId?: string | null;
  actorType: string;
  actorId?: string | null;
  action: string;
  summary: string;
  metadata?: unknown;
  correlationId: string;
  sourceEventId: string;
  occurredAt: Date;
}

/**
 * Idempotent projection write (design §7): a duplicate delivery keyed by the
 * same `source_event_id` is a successful no-op, never a unique-violation throw.
 */
export async function insertActivity(
  db: Database | DatabaseTransaction,
  input: InsertActivityInput,
): Promise<void> {
  await db
    .insert(schema.activity)
    .values({
      organizationId: input.organizationId,
      workItemId: input.workItemId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      action: input.action,
      summary: input.summary,
      metadata: input.metadata ?? null,
      correlationId: input.correlationId,
      sourceEventId: input.sourceEventId,
      occurredAt: input.occurredAt,
    })
    .onConflictDoNothing({ target: schema.activity.sourceEventId });
}

export interface ListActivityFilter {
  workItemId?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Org-scoped, newest first, paginated (design §7, §10). */
export function listActivity(
  db: Database,
  organizationId: string,
  filter: ListActivityFilter = {},
): Promise<ActivityRow[]> {
  const conditions = [eq(schema.activity.organizationId, organizationId)];
  if (filter.workItemId) conditions.push(eq(schema.activity.workItemId, filter.workItemId));

  const limit = Math.min(filter.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  return db.query.activity.findMany({
    where: and(...conditions),
    orderBy: desc(schema.activity.occurredAt),
    limit,
    offset: filter.offset ?? 0,
  });
}
