export const TABS = [
  "report",
  "sources",
  "analytics",
  "trace",
  "files",
  "score",
  "search",
  "health",
  "jobs",
] as const;

export type Tab = (typeof TABS)[number];

export interface SearchFormState {
  readonly query: string;
  readonly symbol: string;
  readonly assetClass: string;
  readonly jobType: string;
  readonly from: string;
  readonly to: string;
}

export type SearchFormField = keyof SearchFormState;

export interface JobFormState {
  readonly jobType: string;
  readonly assetClass: string;
  readonly symbol: string;
  readonly depth: string;
}

export type JobFormField = keyof JobFormState;
