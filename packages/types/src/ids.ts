declare const brand: unique symbol;

/** Nominal typing helper — prevents mixing up structurally identical ids. */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type OrganizationId = Brand<string, 'OrganizationId'>;
export type UserId = Brand<string, 'UserId'>;
export type ProjectId = Brand<string, 'ProjectId'>;
export type WorkItemId = Brand<string, 'WorkItemId'>;
export type SessionId = Brand<string, 'SessionId'>;
export type TeamId = Brand<string, 'TeamId'>;
export type InvitationId = Brand<string, 'InvitationId'>;
