import type { InstrumentIdentity } from "./instrument";
import type { AssetClass } from "./job-type";

export const SOURCE_KINDS = [
  "market-data",
  "news",
  "model",
  "extended-evidence",
  "market-context",
  "discussion",
  "reference",
  "web",
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface Source {
  readonly id: string;
  readonly title: string;
  readonly url?: string;
  readonly publisher?: string;
  readonly fetchedAt: string;
  readonly kind: SourceKind;
  readonly assetClass?: AssetClass;
  readonly symbol?: string;
  readonly rawRef?: string;
  readonly provider?: string;
  readonly providerArticleId?: string;
  readonly canonicalUrl?: string;
  readonly summary?: string;
  readonly snippet?: string;
  readonly providerAliases?: readonly SourceProviderAlias[];
  readonly identity?: InstrumentIdentity;
  readonly latestSessionDate?: string;
  readonly latestSessionStatus?: "unverified";
}

export interface SourceProviderAlias {
  readonly provider: string;
  readonly providerArticleId?: string;
  readonly publisher?: string;
  readonly fetchedAt?: string;
  readonly rawRef?: string;
}

export function sourceProvider(source: Source): string | undefined {
  return source.provider ?? source.providerAliases?.[0]?.provider;
}

export interface SourceGap {
  readonly source: string;
  readonly message: string;
  readonly symbol?: string;
  readonly provider?: string;
  readonly capability?: SourceGapCapability;
  readonly cause?: SourceGapCause;
  readonly evidenceQualityImpact?: SourceGapEvidenceQualityImpact;
  readonly triage?: SourceGapTriage;
  // Present for fetch-failed/circuit-open gaps that retried and for size rejections: how the retry
  // Loop unfolded and how each iteration failed, so a reader can tell "timed out after 3
  // Network attempts, then the local circuit breaker refused a 4th" from the artifact
  // Without inferring retry/breaker behavior from source. See `SourceGapAttempts` for what
  // "Count" does and does not mean when the breaker cuts a retry chain short.
  readonly attempts?: SourceGapAttempts;
}

// "circuit-open" is distinct from "non-transient": a non-transient classification means the
// Provider (or network) responded and the response wasn't worth retrying; "circuit-open" means
// No request was sent at all — market-bot's own per-host breaker (source-request.ts) refused
// To send it. A reader must not attribute a "circuit-open" attempt to the remote provider.
export type SourceGapAttemptClassification =
  | "timeout"
  | "server-error"
  | "network"
  | "circuit-open"
  | "response-too-large"
  | "non-transient";

export interface SourceGapAttemptFailure {
  readonly attempt: number;
  readonly classification: SourceGapAttemptClassification;
  readonly message: string;
}

export interface SourceGapAttempts {
  // Total retry-loop iterations, including a final iteration where the local circuit
  // Breaker refused to send a request (see `failures[].classification === "circuit-open"`).
  // Not necessarily the number of requests that reached the network — cross-reference
  // `failures` for that.
  readonly count: number;
  // Wall-clock milliseconds from the first attempt through the final failure, including
  // Any per-host queuing/throttle delay imposed by source-request.ts's resilience layer
  // (shared with other concurrent requests to the same host) and the retry sleeps
  // Themselves — not purely the provider's response latency.
  readonly elapsedMs: number;
  readonly failures: readonly SourceGapAttemptFailure[];
}

export type SourceGapTriage = "material" | "diagnostic";

export type SourceGapCapability =
  | "market-data"
  | "news"
  | "discussion"
  | "extended-evidence"
  | "market-context"
  | "evidence-request"
  | "web-gather"
  | "cache";

export type SourceGapCause =
  | "missing-credential"
  | "fetch-failed"
  | "circuit-open"
  | "stale-fallback"
  | "reused-in-window"
  | "unsupported-coverage"
  | "repeat-fallback"
  | "malformed-response"
  | "validation-failed"
  | "provider-data-missing"
  // The provider returned a bar for a session that had not closed yet at fetch time.
  // Distinct from `provider-data-missing`: the fields were present, the session was not over.
  | "session-in-progress"
  | "suppressed-by-design";

export type SourceGapEvidenceQualityImpact = "core-cap" | "extended-evidence-cap" | "no-cap";
