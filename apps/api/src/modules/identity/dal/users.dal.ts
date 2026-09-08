import { schema, type Database } from '@devflow/database';
import { eq } from 'drizzle-orm';
import type { UserId } from '@devflow/types';

export type UserRow = typeof schema.users.$inferSelect;

export function findUserByGithubId(db: Database, githubId: string) {
  return db.query.users.findFirst({ where: eq(schema.users.githubId, githubId) });
}

export function findUserById(db: Database, id: UserId) {
  return db.query.users.findFirst({ where: eq(schema.users.id, id) });
}

export interface CreateUserInput {
  githubId: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
}

export async function createUser(db: Database, input: CreateUserInput): Promise<UserRow> {
  const [user] = await db.insert(schema.users).values(input).returning();
  if (!user) throw new Error('createUser: insert returned no row');
  return user;
}

export async function touchLastLogin(db: Database, id: UserId): Promise<UserRow> {
  const [user] = await db
    .update(schema.users)
    .set({ lastLoginAt: new Date() })
    .where(eq(schema.users.id, id))
    .returning();
  if (!user) throw new Error('touchLastLogin: update returned no row');
  return user;
}
