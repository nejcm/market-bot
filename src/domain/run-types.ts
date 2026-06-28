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
  // Eligible for the live web-gather loop (still gated at runtime on --deep,
  // An Exa key, and positive budgets).
  readonly supportsWebGather: boolean;
  // Eligible for the SEC/Tradier evidence-request loop (still gated at runtime
  // On --deep, a US listing, and positive budgets).
  readonly supportsEvidenceRequest: boolean;
}

// Single source of truth for the two CLI capability predicates
// (jobSupportsAsset / jobSupportsDepth) and the instrument-run guard. Keyed by
// Every research job type; an exhaustive Record so a new run type cannot be
// Added without declaring its capabilities here.
export const RUN_TYPE_REGISTRY: Record<ResearchJobType, RunTypeMeta> = {
  "market-overview": {
    supportsAsset: true,
    supportsDepth: true,
    isInstrument: false,
    supportsWebGather: false,
    supportsEvidenceRequest: false,
  },
  daily: {
    supportsAsset: true,
    supportsDepth: true,
    isInstrument: false,
    supportsWebGather: false,
    supportsEvidenceRequest: false,
  },
  weekly: {
    supportsAsset: true,
    supportsDepth: true,
    isInstrument: false,
    supportsWebGather: false,
    supportsEvidenceRequest: false,
  },
  equity: {
    supportsAsset: false,
    supportsDepth: true,
    isInstrument: true,
    supportsWebGather: true,
    supportsEvidenceRequest: true,
  },
  crypto: {
    supportsAsset: false,
    supportsDepth: true,
    isInstrument: true,
    supportsWebGather: true,
    supportsEvidenceRequest: false,
  },
  "alpha-search": {
    supportsAsset: false,
    supportsDepth: true,
    isInstrument: false,
    supportsWebGather: false,
    supportsEvidenceRequest: false,
  },
  research: {
    supportsAsset: false,
    supportsDepth: true,
    isInstrument: false,
    supportsWebGather: true,
    supportsEvidenceRequest: false,
  },
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

export function runTypeSupportsWebGather(jobType: string): boolean {
  return runTypeMeta(jobType)?.supportsWebGather ?? false;
}

export function runTypeSupportsEvidenceRequest(jobType: string): boolean {
  return runTypeMeta(jobType)?.supportsEvidenceRequest ?? false;
}
