import type { AssetClass, JobType } from "./types";

// Research/analysis run types. Today this is exactly the JobType set (seven
// Members); the alias names the intent so the capability registry below stays
// A single source of truth even if operational job types are modelled
// Elsewhere. Pure leaf module: no imports from cli/config/research/sources.
export type ResearchJobType = JobType;
export type RunTypeAssetArg = "none" | "required" | { readonly fixed: AssetClass };

export interface RunTypeMeta {
  // CLI asset argument mode.
  readonly assetArg: RunTypeAssetArg;
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
  // Output shape: emits a full synthesis ResearchReport (key findings, cases,
  // Scenarios, predictions) rather than a screening candidate list. False only
  // For alpha-search, whose pipeline produces ranked candidates.
  readonly producesSynthesisReport: boolean;
}

// Single source of truth for the two CLI capability predicates
// (jobSupportsAsset / jobSupportsDepth) and the instrument-run guard. Keyed by
// Every research job type; an exhaustive Record so a new run type cannot be
// Added without declaring its capabilities here.
export const RUN_TYPE_REGISTRY: Record<ResearchJobType, RunTypeMeta> = {
  "market-overview": {
    assetArg: "required",
    supportsDepth: true,
    isInstrument: false,
    supportsWebGather: false,
    supportsEvidenceRequest: false,
    producesSynthesisReport: true,
  },
  daily: {
    assetArg: "required",
    supportsDepth: true,
    isInstrument: false,
    supportsWebGather: false,
    supportsEvidenceRequest: false,
    producesSynthesisReport: true,
  },
  weekly: {
    assetArg: "required",
    supportsDepth: true,
    isInstrument: false,
    supportsWebGather: false,
    supportsEvidenceRequest: false,
    producesSynthesisReport: true,
  },
  equity: {
    assetArg: "none",
    supportsDepth: true,
    isInstrument: true,
    supportsWebGather: true,
    supportsEvidenceRequest: true,
    producesSynthesisReport: true,
  },
  crypto: {
    assetArg: "none",
    supportsDepth: true,
    isInstrument: true,
    supportsWebGather: true,
    supportsEvidenceRequest: false,
    producesSynthesisReport: true,
  },
  "alpha-search": {
    assetArg: { fixed: "equity" },
    supportsDepth: true,
    isInstrument: false,
    supportsWebGather: false,
    supportsEvidenceRequest: false,
    producesSynthesisReport: false,
  },
  research: {
    assetArg: "none",
    supportsDepth: true,
    isInstrument: false,
    supportsWebGather: true,
    supportsEvidenceRequest: false,
    producesSynthesisReport: true,
  },
};

// Membership guard for the seven research job types. Returns false for
// Operational job types (score, calibration, cache-prune, provider-health,
// History-*) and any other string, narrowing to ResearchJobType when true.
export function isResearchJobType(value: string): value is ResearchJobType {
  return runTypeMeta(value) !== undefined;
}

function runTypeMeta(jobType: string): RunTypeMeta | undefined {
  return (RUN_TYPE_REGISTRY as Record<string, RunTypeMeta | undefined>)[jobType];
}

// Capability lookups return false for unknown/operational job types (score,
// Calibration, cache-prune, provider-health, history-*), which carry no entry.
export function runTypeSupportsAsset(jobType: string): boolean {
  return runTypeMeta(jobType)?.assetArg === "required";
}

export function runTypeFixedAssetClass(jobType: string): AssetClass | undefined {
  const assetArg = runTypeMeta(jobType)?.assetArg;
  return typeof assetArg === "object" ? assetArg.fixed : undefined;
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

export function runTypeProducesSynthesisReport(jobType: string): boolean {
  return runTypeMeta(jobType)?.producesSynthesisReport ?? false;
}
