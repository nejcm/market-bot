import type { SourceGap } from "../domain/types";

export type GapTriage = "material" | "diagnostic";

const DIAGNOSTIC_REASON_CODES = new Set([
  "expectations-provider-credential-missing",
  "expectations-provider-entitlement-blocked",
  "ownership-provider-credential-missing",
  "ownership-provider-entitlement-blocked",
]);

const OPTIONAL_PROVIDER_SOURCE =
  /^(?:finnhub|firecrawl|fred|glassnode|marketaux|massive|tradier)(?:-|$)/u;
const OPTIONAL_PROVIDER_ABSENCE =
  /(?:credential|api[_ -]?token|api[_ -]?key).*(?:missing|not set)|missing.*(?:credential|api[_ -]?token|api[_ -]?key)/iu;
const ENTITLEMENT_FAILURE = /(?:entitlement|status\s*403|\b403\b|access is restricted)/iu;
const SCOPED_SYMBOL = /\[([A-Z][A-Z0-9.-]*)\]\s*$/u;

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

function isPeerSecGap(source: string, symbol: string | undefined, reportSymbol?: string): boolean {
  return (
    reportSymbol !== undefined &&
    source === "sec-edgar" &&
    symbol !== undefined &&
    symbol.toUpperCase() !== reportSymbol.toUpperCase()
  );
}

export function classifyGap(gap: SourceGap | string, reportSymbol?: string): GapTriage {
  if (typeof gap === "string") {
    const source = sourceName(gap);
    const scopedSymbol = SCOPED_SYMBOL.exec(gap)?.[1];
    if (
      diagnosticReasonCode(gap) ||
      source === "valuation-peers" ||
      isPeerSecGap(source, scopedSymbol, reportSymbol) ||
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
  if (source === "valuation-peers" || isPeerSecGap(source, gap.symbol, reportSymbol)) {
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
