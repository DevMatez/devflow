import { z } from 'zod';
import {
  ROLES,
  WORKFLOW_STATES,
  WORKFLOW_EXECUTION_STATUSES,
  BRANCH_REF_STATUSES,
  PR_REF_STATES,
  PRIORITIES,
  INTEGRATION_CATEGORIES,
  INVITATION_STATUSES,
  CONNECTION_STATUSES,
} from '@devflow/types';

/** Zod schemas built from the canonical enum arrays in `@devflow/types`. */

export const roleSchema = z.enum(ROLES);
export const workflowStateSchema = z.enum(WORKFLOW_STATES);
export const workflowExecutionStatusSchema = z.enum(WORKFLOW_EXECUTION_STATUSES);
export const branchRefStatusSchema = z.enum(BRANCH_REF_STATUSES);
export const prRefStateSchema = z.enum(PR_REF_STATES);
export const prioritySchema = z.enum(PRIORITIES);
export const integrationCategorySchema = z.enum(INTEGRATION_CATEGORIES);
export const invitationStatusSchema = z.enum(INVITATION_STATUSES);
export const connectionStatusSchema = z.enum(CONNECTION_STATUSES);
