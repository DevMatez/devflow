import { schema, type Database } from '@devflow/database';
import { and, eq } from 'drizzle-orm';
import type { OrganizationId, UserId } from '@devflow/types';

/** The only membership query the `access` module needs — full CRUD lives in `organizations/dal`. */
export function findMembership(db: Database, organizationId: OrganizationId, userId: UserId) {
  return db.query.organizationMembers.findFirst({
    where: and(
      eq(schema.organizationMembers.organizationId, organizationId),
      eq(schema.organizationMembers.userId, userId),
    ),
  });
}
