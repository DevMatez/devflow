import { randomBytes, createHash } from 'node:crypto';
import type { Database } from '@devflow/database';
import type { UserId, SessionId } from '@devflow/types';
import {
  createSession,
  findSessionByTokenHash,
  refreshSessionExpiry,
  deleteSession,
  type SessionRow,
} from '../dal/sessions.dal';

export interface SessionConfig {
  ttlDays: number;
  refreshThresholdDays: number;
}

export interface CreateUserSessionInput {
  userId: UserId;
  ip?: string | null;
  userAgent?: string | null;
}

export interface CreateUserSessionResult {
  token: string;
  session: SessionRow;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createUserSession(
  db: Database,
  config: SessionConfig,
  input: CreateUserSessionInput,
): Promise<CreateUserSessionResult> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + config.ttlDays * DAY_MS);

  const session = await createSession(db, {
    userId: input.userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  return { token, session };
}

/** Refreshes back to a full TTL only once under refreshThresholdDays remain; null if missing/expired. */
export async function verifySessionToken(
  db: Database,
  config: SessionConfig,
  token: string,
): Promise<SessionRow | null> {
  const session = await findSessionByTokenHash(db, hashSessionToken(token));
  if (!session || session.expiresAt.getTime() <= Date.now()) return null;

  const remainingMs = session.expiresAt.getTime() - Date.now();
  if (remainingMs >= config.refreshThresholdDays * DAY_MS) return session;

  const expiresAt = new Date(Date.now() + config.ttlDays * DAY_MS);
  await refreshSessionExpiry(db, session.id as SessionId, expiresAt);
  return { ...session, expiresAt };
}

export async function revokeSessionToken(db: Database, token: string): Promise<void> {
  const session = await findSessionByTokenHash(db, hashSessionToken(token));
  if (session) await deleteSession(db, session.id as SessionId);
}
