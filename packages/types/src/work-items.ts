import type { BranchRefStatus, PrRefState } from './enums';

/** Cached pointer to the GitHub branch a work item is bound to (Wave 3 design §9). */
export interface BranchRef {
  repo: string;
  name: string;
  /** The branch this was cut from / the PR merges into (saga input, §4.3, §4.4). */
  base?: string;
  url?: string;
  status: BranchRefStatus;
}

/** Cached pointer to the GitHub PR a work item is bound to (Wave 3 design §9). */
export interface PrRef {
  repo: string;
  number: number;
  url?: string;
  state: PrRefState;
}
