import { REPORT_SEARCH_SECTIONS } from "../report-search-entries";

// Section vocabulary lives in its own leaf so browser consumers (the Research
// Console client, via the CLI arg parser) can read it without loading
// ./artifacts, which does file I/O.
export const HISTORY_SECTIONS = [...REPORT_SEARCH_SECTIONS, "fundamentals", "validation"] as const;

export type HistorySection = (typeof HISTORY_SECTIONS)[number];
