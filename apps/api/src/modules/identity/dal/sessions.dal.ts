import { schema, type Database } from '@devflow/database';
import { eq } from 'drizzle-orm';
import type { SessionId, UserId } from '@devflow/types';

export type SessionRow = typeof schema.sessions.$inferSelect;

export interface CreateSessionInput {
  userId: UserId;
  tokenHash: string;
  expiresAt: Date;
  ip?: string | null;
  userAgent?: string | null;
}

export async function createSession(db: Database, input: CreateSessionInput): Promise<SessionRow> {
  const [session] = await db.insert(schema.sessions).values(input).returning();
  if (!session) throw new Error('createSession: insert returned no row');
  return session;
}

/** Session lookup is always by token hash — the cookie never carries the row id. */
export function findSessionByTokenHash(db: Database, tokenHash: string) {
  return db.query.sessions.findFirst({ where: eq(schema.sessions.tokenHash, tokenHash) });
}

export async function refreshSessionExpiry(
  db: Database,
  id: SessionId,
  expiresAt: Date,
): Promise<void> {
  await db.update(schema.sessions).set({ expiresAt }).where(eq(schema.sessions.id, id));
}

export async function deleteSession(db: Database, id: SessionId): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.id, id));
}
