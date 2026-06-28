import type { JobType } from "./types";

// Research/analysis run types. Today this is exactly the JobType set (seven
// Members); the alias names the intent so the capability registry below stays
// A single source of truth even if operational job types are modelled
// Elsewhere. Pure leaf module: no imports from cli/config/research/sources.
export type ResearchJobType = JobType;

export interface RunTypeMeta {
  // Takes --asset equity|crypto.
  readonly supportsAsset: boolean;
  // Takes --deep.
  readonly supportsDepth: boolean;
  // Single-symbol run (equity/crypto).
  readonly isInstrument: boolean;
}

// Single source of truth for the two CLI capability predicates
// (jobSupportsAsset / jobSupportsDepth) and the instrument-run guard. Keyed by
// Every research job type; an exhaustive Record so a new run type cannot be
// Added without declaring its capabilities here.
export const RUN_TYPE_REGISTRY: Record<ResearchJobType, RunTypeMeta> = {
  "market-overview": { supportsAsset: true, supportsDepth: true, isInstrument: false },
  daily: { supportsAsset: true, supportsDepth: true, isInstrument: false },
  weekly: { supportsAsset: true, supportsDepth: true, isInstrument: false },
  equity: { supportsAsset: false, supportsDepth: true, isInstrument: true },
  crypto: { supportsAsset: false, supportsDepth: true, isInstrument: true },
  "alpha-search": { supportsAsset: false, supportsDepth: true, isInstrument: false },
  research: { supportsAsset: false, supportsDepth: true, isInstrument: false },
};

function runTypeMeta(jobType: string): RunTypeMeta | undefined {
  return (RUN_TYPE_REGISTRY as Record<string, RunTypeMeta | undefined>)[jobType];
}

// Capability lookups return false for unknown/operational job types (score,
// Calibration, cache-prune, provider-health, history-*), which carry no entry.
export function runTypeSupportsAsset(jobType: string): boolean {
  return runTypeMeta(jobType)?.supportsAsset ?? false;
}

export function runTypeSupportsDepth(jobType: string): boolean {
  return runTypeMeta(jobType)?.supportsDepth ?? false;
}
