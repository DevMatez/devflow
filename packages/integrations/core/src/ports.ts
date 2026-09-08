import type { OrganizationId } from '@devflow/types';
import type { CheckRunConclusion, CheckRunStatus } from './enums';
import type {
  Branch,
  CalendarEvent,
  ChatChannel,
  ChatMessage,
  CheckRun,
  Comment,
  FreeBusySlot,
  Issue,
  PullRequest,
  Repository,
} from './models';

/** Every port method is org-scoped structurally — same principle as `OrgContext` (Wave 1). */
export interface ProviderContext {
  organizationId: OrganizationId;
  connectionId: string;
}

export interface CreateBranchInput {
  repo: string;
  name: string;
  fromRef: string;
}

export interface CreatePullRequestInput {
  repo: string;
  title: string;
  headRef: string;
  baseRef: string;
  body?: string;
}

export interface CreateCommentInput {
  repo: string;
  targetExternalId: string;
  body: string;
}

export interface UpsertCheckRunInput {
  repo: string;
  headSha: string;
  name: string;
  status: CheckRunStatus;
  conclusion?: CheckRunConclusion;
  detailsUrl?: string;
}

export interface SourceControlPort {
  listRepositories(ctx: ProviderContext): Promise<Repository[]>;
  createBranch(ctx: ProviderContext, input: CreateBranchInput): Promise<Branch>;
  /** Idempotent create: returns the existing branch if one with `name` already exists (design §4.3). */
  findOrCreateBranch(ctx: ProviderContext, input: CreateBranchInput): Promise<Branch>;
  createPullRequest(ctx: ProviderContext, input: CreatePullRequestInput): Promise<PullRequest>;
  /** Idempotent create: returns the existing open PR for `headRef`→`baseRef` if one exists (design §4.3). */
  findOrCreatePullRequest(
    ctx: ProviderContext,
    input: CreatePullRequestInput,
  ): Promise<PullRequest>;
  getPullRequest(
    ctx: ProviderContext,
    input: { repo: string; number: number },
  ): Promise<PullRequest>;
  createComment(ctx: ProviderContext, input: CreateCommentInput): Promise<Comment>;
  getDiff(ctx: ProviderContext, input: { repo: string; number: number }): Promise<string>;
  upsertCheckRun(ctx: ProviderContext, input: UpsertCheckRunInput): Promise<CheckRun>;
}

export interface CreateIssueInput {
  /** The project the issue is created in -- a connection is workspace-scoped, not project-scoped (design doc §6). */
  projectId: string;
  title: string;
  description?: string;
  assigneeExternalId?: string;
}

export interface UpdateIssueInput {
  projectId: string;
  externalId: string;
  title?: string;
  description?: string;
  status?: string;
  assigneeExternalId?: string | null;
}

export interface ProjectManagementPort {
  createIssue(ctx: ProviderContext, input: CreateIssueInput): Promise<Issue>;
  updateIssue(ctx: ProviderContext, input: UpdateIssueInput): Promise<Issue>;
  getIssue(ctx: ProviderContext, input: { projectId: string; externalId: string }): Promise<Issue>;
  createComment(ctx: ProviderContext, input: CreateCommentInput): Promise<Comment>;
}

export interface PostMessageInput {
  channelExternalId: string;
  text: string;
}

export interface ChatPort {
  listChannels(ctx: ProviderContext): Promise<ChatChannel[]>;
  postMessage(ctx: ProviderContext, input: PostMessageInput): Promise<ChatMessage>;
}

export interface CreateCalendarEventInput {
  title: string;
  start: string;
  end: string;
  description?: string;
}

export interface CalendarPort {
  listEvents(ctx: ProviderContext, input: { from: Date; to: Date }): Promise<CalendarEvent[]>;
  getFreeBusy(ctx: ProviderContext, input: { from: Date; to: Date }): Promise<FreeBusySlot[]>;
  createEvent(ctx: ProviderContext, input: CreateCalendarEventInput): Promise<CalendarEvent>;
}
