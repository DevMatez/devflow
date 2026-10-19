import { schema, type Database, type DatabaseTransaction } from '@devflow/database';
import { and, asc, eq } from 'drizzle-orm';
import type { WorkflowConfig } from '@devflow/types';

export type ProjectRow = typeof schema.projects.$inferSelect;

export interface CreateProjectInput {
  organizationId: string;
  name: string;
  slug: string;
  key?: string | null;
  workflowConfig: WorkflowConfig;
}

export async function createProject(
  tx: DatabaseTransaction,
  input: CreateProjectInput,
): Promise<ProjectRow> {
  const [row] = await tx.insert(schema.projects).values(input).returning();
  if (!row) throw new Error('createProject: insert returned no row');
  return row;
}

export function listProjects(db: Database, organizationId: string) {
  return db.query.projects.findMany({
    where: eq(schema.projects.organizationId, organizationId),
    orderBy: asc(schema.projects.name),
  });
}

/** Compound where — a project id from another org is simply not found (Wave 1 design §3.4). */
export function findProjectById(
  db: Database | DatabaseTransaction,
  organizationId: string,
  id: string,
) {
  return db.query.projects.findFirst({
    where: and(eq(schema.projects.id, id), eq(schema.projects.organizationId, organizationId)),
  });
}

export interface UpdateProjectInput {
  name?: string;
  slug?: string;
  key?: string | null;
  workflowConfig?: WorkflowConfig;
}

export async function updateProject(
  tx: DatabaseTransaction,
  organizationId: string,
  id: string,
  input: UpdateProjectInput,
): Promise<ProjectRow | undefined> {
  const [row] = await tx
    .update(schema.projects)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(schema.projects.id, id), eq(schema.projects.organizationId, organizationId)))
    .returning();
  return row;
}
