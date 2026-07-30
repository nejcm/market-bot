import type { SourceGap } from "../domain/types";

export type GapTriage = "material" | "diagnostic";

const DIAGNOSTIC_REASON_CODES = new Set([
  "expectations-provider-credential-missing",
  "expectations-provider-entitlement-blocked",
  "ownership-provider-credential-missing",
  "ownership-provider-entitlement-blocked",
]);

const OPTIONAL_PROVIDER_SOURCE =
  /^(?:finnhub|firecrawl|glassnode|marketaux|massive|tradier)(?:-|$)/u;
const OPTIONAL_PROVIDER_ABSENCE =
  /(?:credential|api[_ -]?token|api[_ -]?key).*(?:missing|not set)|missing.*(?:credential|api[_ -]?token|api[_ -]?key)/iu;
const ENTITLEMENT_FAILURE = /(?:entitlement|status\s*403|\b403\b|access is restricted)/iu;

function sourceName(value: string): string {
  return value.split(":", 1)[0]?.trim().toLowerCase() ?? "";
}

function diagnosticReasonCode(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    DIAGNOSTIC_REASON_CODES.has(normalized) ||
    normalized.startsWith("operating-kpi-") ||
    normalized.includes("registry-unconfigured")
  );
}

export function classifyGap(gap: SourceGap | string): GapTriage {
  if (typeof gap === "string") {
    const source = sourceName(gap);
    if (
      diagnosticReasonCode(gap) ||
      (OPTIONAL_PROVIDER_SOURCE.test(source) &&
        (OPTIONAL_PROVIDER_ABSENCE.test(gap) || ENTITLEMENT_FAILURE.test(gap)))
    ) {
      return "diagnostic";
    }
    return "material";
  }

  const source = sourceName(gap.source);
  const provider = gap.provider?.trim().toLowerCase() ?? "";
  if (diagnosticReasonCode(source) || diagnosticReasonCode(gap.message)) {
    return "diagnostic";
  }
  if (
    (OPTIONAL_PROVIDER_SOURCE.test(source) || OPTIONAL_PROVIDER_SOURCE.test(provider)) &&
    (gap.cause === "missing-credential" || ENTITLEMENT_FAILURE.test(gap.message))
  ) {
    return "diagnostic";
  }
  return "material";
}
