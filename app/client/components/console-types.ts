export const VIEWS = [
  "dashboard",
  "run",
  "instrument",
  "search",
  "jobs",
  "calibration",
  "health",
] as const;

export type View = (typeof VIEWS)[number];

export const TABS = ["report", "sources", "data", "files"] as const;

export type Tab = (typeof TABS)[number];

export const DATA_SEGMENTS = ["analytics", "trace", "score", "missAutopsy"] as const;

export type DataSegment = (typeof DATA_SEGMENTS)[number];

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
