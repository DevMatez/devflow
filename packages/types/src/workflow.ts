/** Stored as jsonb on `projects`; `version` avoids ambiguous reinterpretation of old rows on future shape changes. */
export interface ReviewPolicy {
  requiredApprovals: number;
  requireAiReview: boolean;
}

export interface WorkflowConfig {
  version: 1;
  branchNamingPattern: string;
  prTitleTemplate: string;
  reviewPolicy: ReviewPolicy;
  /** Slack channel the notify-slack consumer posts to; absent = notifications skipped (design §15.3). */
  notificationChannelId?: string;
}
