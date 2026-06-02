import type {
  SourceGap,
  SourceGapCapability,
  SourceGapCause,
  SourceGapEvidenceQualityImpact,
} from "./types";

export type SourceGapAnalyticsClass = "missingCredential" | "fetchFailed" | "other";
type FetchFailureSourceGapCause = Extract<SourceGapCause, "fetch-failed" | "circuit-open">;

export interface SourceGapInput {
  readonly source: string;
  readonly message: string;
  readonly provider?: string;
  readonly capability?: SourceGapCapability;
  readonly cause?: SourceGapCause;
  readonly evidenceQualityImpact?: SourceGapEvidenceQualityImpact;
}

export function sourceGap(input: SourceGapInput): SourceGap {
  return {
    source: input.source,
    message: input.message,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.capability !== undefined ? { capability: input.capability } : {}),
    ...(input.cause !== undefined ? { cause: input.cause } : {}),
    ...(input.evidenceQualityImpact !== undefined
      ? { evidenceQualityImpact: input.evidenceQualityImpact }
      : {}),
  };
}

export function sourceGapReportText(gap: SourceGap): string {
  return `${gap.source}: ${gap.message}`;
}

export function sourceGapStatusCode(message: string): string | undefined {
  return message.match(/status\s+(\d{3})/iu)?.[1];
}

export function sourceGapWithContext(
  gap: SourceGap,
  context: {
    readonly provider?: string;
    readonly capability?: SourceGapCapability;
    readonly cause?: SourceGapCause;
    readonly evidenceQualityImpact?: SourceGapEvidenceQualityImpact;
  },
): SourceGap {
  const provider = context.provider ?? gap.provider;
  const capability = context.capability ?? gap.capability;
  const cause = context.cause ?? gap.cause;
  const evidenceQualityImpact = context.evidenceQualityImpact ?? gap.evidenceQualityImpact;

  return sourceGap({
    source: gap.source,
    message: gap.message,
    ...(provider !== undefined ? { provider } : {}),
    ...(capability !== undefined ? { capability } : {}),
    ...(cause !== undefined ? { cause } : {}),
    ...(evidenceQualityImpact !== undefined ? { evidenceQualityImpact } : {}),
  });
}

export function fetchFailureSourceGap(
  source: string,
  message: string,
  cause: FetchFailureSourceGapCause = "fetch-failed",
): SourceGap {
  return sourceGap({
    source,
    message,
    cause,
    evidenceQualityImpact: "core-cap",
  });
}

export function sourceGapAnalyticsClass(gap: SourceGap): SourceGapAnalyticsClass {
  const { cause } = gap;
  switch (cause) {
    case "missing-credential": {
      return "missingCredential";
    }
    case "fetch-failed":
    case "circuit-open": {
      return "fetchFailed";
    }
    case "stale-fallback":
    case "unsupported-coverage":
    case "repeat-fallback":
    case "malformed-response":
    case "validation-failed":
    case "provider-data-missing":
    case undefined: {
      return "other";
    }
    default: {
      return assertNever(cause);
    }
  }
}

export function isRepeatFallbackGap(gap: SourceGap): boolean {
  return gap.cause === "repeat-fallback";
}

export function isCoreEvidenceQualityGap(gap: SourceGap): boolean {
  // Legacy untyped gaps are core evidence gaps until their producers opt into a narrower impact.
  return gap.evidenceQualityImpact === "core-cap" || gap.evidenceQualityImpact === undefined;
}

export function isExtendedEvidenceQualityGap(gap: SourceGap): boolean {
  return gap.evidenceQualityImpact === "extended-evidence-cap";
}

export function extendedEvidenceGap(gap: SourceGap): SourceGap {
  return sourceGapWithContext(gap, {
    capability: "extended-evidence",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

export function marketContextGap(gap: SourceGap): SourceGap {
  return sourceGapWithContext(gap, {
    capability: "market-context",
    evidenceQualityImpact: "no-cap",
  });
}

function assertNever(value: never): never {
  throw new Error(`Unhandled source gap cause: ${String(value)}`);
}
