import { sourceGapScopedReportText } from "../domain/source-gaps";
import type { SourceGap, SourceGapTriage } from "../domain/types";

export type GapTriage = SourceGapTriage;

const DIAGNOSTIC_REASON_CODES = new Set([
  "expectations-provider-credential-missing",
  "expectations-provider-entitlement-blocked",
  "ownership-provider-credential-missing",
  "ownership-provider-entitlement-blocked",
]);

const OPTIONAL_PROVIDER_SOURCE =
  /^(?:finnhub|firecrawl|fred|glassnode|marketaux|massive|tradier)(?:-|$)/u;
// Exa is the primary web-evidence provider, so a missing Exa credential remains material.
const OPTIONAL_PROVIDER_CREDENTIAL =
  /\bMARKET_BOT_(?:FINNHUB_API_TOKEN|FIRECRAWL_API_KEY|FRED_API_KEY|GLASSNODE_API_KEY|MARKETAUX_API_TOKEN|MASSIVE_API_KEY|POLYGON_API_KEY|TRADIER_API_TOKEN)\b/u;
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

// Legacy-read fallback for Source Gaps persisted before `triage`.
// New-run assembly calls the structured overload once to stamp the persisted field.
export function classifyGap(gap: SourceGap | string, reportSymbol?: string): GapTriage {
  if (typeof gap === "string") {
    const source = sourceName(gap);
    const scopedSymbol = SCOPED_SYMBOL.exec(gap)?.[1];
    if (
      diagnosticReasonCode(gap) ||
      source === "valuation-peers" ||
      isPeerSecGap(source, scopedSymbol, reportSymbol) ||
      ((OPTIONAL_PROVIDER_SOURCE.test(source) || OPTIONAL_PROVIDER_CREDENTIAL.test(gap)) &&
        (OPTIONAL_PROVIDER_ABSENCE.test(gap) || ENTITLEMENT_FAILURE.test(gap)))
    ) {
      return "diagnostic";
    }
    return "material";
  }

  const source = sourceName(gap.source);
  const provider = gap.provider?.trim().toLowerCase() ?? "";
  if (diagnosticReasonCode(source)) {
    return "diagnostic";
  }
  if (source === "valuation-peers" || isPeerSecGap(source, gap.symbol, reportSymbol)) {
    return "diagnostic";
  }
  if (
    (OPTIONAL_PROVIDER_SOURCE.test(source) || OPTIONAL_PROVIDER_SOURCE.test(provider)) &&
    (gap.cause === "missing-credential" || gap.cause === "unsupported-coverage")
  ) {
    return "diagnostic";
  }
  return "material";
}

export function readGapTriage(
  text: string,
  sourceGaps: readonly SourceGap[] = [],
  reportSymbol?: string,
): GapTriage {
  const structured = sourceGaps.find((gap) => sourceGapScopedReportText(gap) === text);
  return structured?.triage ?? classifyGap(text, reportSymbol);
}
