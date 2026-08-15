import type { InstrumentCommand } from "../cli/args";
import type { ExtendedEvidenceItem, InstrumentIdentity, Source, SourceGap } from "../domain/types";
import { sourceGap } from "../domain/source-gaps";
import {
  droppedModelInputItemEntry,
  sanitizeModelInputField,
  type ModelInputSanitizationAggregateEntry,
} from "./model-input-sanitizer";
import type { FetchTextResult } from "./types";
import { secFilingKey, type SecFiling } from "./sec-filing-selection";
import {
  normalizeFilingText,
  secFilingSectionPacket,
  sectionMissDescription,
  SEC_SECTION_MIN_ALPHA_CHARS,
  substantiveAlphaCount,
  truncateText,
  type SectionMiss,
} from "./sec-filing-text";

const SEC_FILING_SUMMARY_EXCERPT_CHARS = 1200;

export function secPacketGap(symbol: string, form: SecFiling["form"]): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `SEC ${form} section packet for ${symbol} is malformed or too short to extract`,
    provider: "sec-edgar",
    capability: "evidence-request",
    cause: "malformed-response",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

// Distinguishes a partial extraction (packet built, some sections missing) from
// `secPacketGap`'s total failure (no sections extracted at all), so report.json:dataGaps can
// Tell the two apart (see A2.3 in the run-quality remediation plan). Cause is
// `provider-data-missing`, not `malformed-response`: an omitted section is usually the filing
// Legitimately not having that content (e.g. Business in a 10-Q), not a malformed document.
export function secSectionOmissionGap(
  symbol: string,
  form: SecFiling["form"],
  misses: readonly SectionMiss[],
  extractedCount: number,
  totalCount: number,
  normalizedChars: number,
  responseBytes: number,
): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message:
      `SEC ${form} section packet for ${symbol} omitted ${misses.map((miss) => sectionMissDescription(miss)).join(", ")} ` +
      `(${String(extractedCount)} of ${String(totalCount)} sections extracted from ` +
      `${String(normalizedChars)} normalized chars; ${String(responseBytes)} response bytes)`,
    provider: "sec-edgar",
    capability: "evidence-request",
    cause: "provider-data-missing",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

export function secSanitizationGap(symbol: string, droppedItemCount: number): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `SEC filing sanitization dropped ${String(droppedItemCount)} item(s) for ${symbol}`,
    provider: "sec-edgar",
    capability: "evidence-request",
    cause: "validation-failed",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function secIdentity(match: { cik: string; ticker: string; name?: string }): InstrumentIdentity {
  return {
    ...(match.name !== undefined ? { displayName: match.name } : {}),
    providerIds: [{ provider: "sec-edgar", idKind: "cik", value: match.cik }],
    aliases: [{ provider: "sec-edgar", idKind: "ticker", value: match.ticker }],
  };
}

type SecFilingSourceItem =
  | {
      readonly kind: "built";
      readonly source: Source;
      readonly item: ExtendedEvidenceItem;
      readonly sanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
      // Populated only for the 10-K/10-Q section model (empty for 8-K/6-K, which has none).
      readonly misses: readonly SectionMiss[];
      readonly sectionCount: number;
      readonly normalizedChars: number;
      readonly responseBytes: number;
    }
  | {
      readonly kind: "dropped";
      readonly sanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
    }
  | { readonly kind: "missing" };

// Builds a filing evidence item from submissions metadata alone (form, filingDate,
// AccessionNumber, primaryDocument), with no dependency on the filing-text body.
// Used whenever filing-text ingestion fails, is dropped by sanitization, or yields
// Too little substantive content to extract a section packet — the filing-basis
// Date must never be blocked by a filing-text failure (see A1 in the run-quality
// Remediation plan).
export function buildSecFilingMetadataOnlyItem(
  command: InstrumentCommand,
  match: { cik: string; ticker: string; name?: string },
  filing: SecFiling,
  url: string,
  fetchedAt: string,
  rawRef?: string,
  earningsRelease?: EarningsReleaseProvenance,
): {
  readonly source: Source;
  readonly item: ExtendedEvidenceItem;
  readonly sanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
} {
  const formKey = secFilingKey(filing);
  const sanitizedName =
    match.name === undefined
      ? undefined
      : sanitizeModelInputField(match.name, {
          provider: "sec-edgar",
          ingress: "sec-tickers",
          profile: "short-metadata",
          fieldRole: "title",
        });
  const identity = secIdentity({
    cik: match.cik,
    ticker: match.ticker,
    ...(sanitizedName?.text !== undefined ? { name: sanitizedName.text } : {}),
  });
  const title = `${command.symbol} SEC ${filing.form}`;
  const periodLabel = filing.form === "8-K" || filing.form === "6-K" ? "event date" : "period";
  const summary = `${filing.form} filed ${filing.filingDate}${
    filing.reportDate !== undefined ? ` for ${periodLabel} ${filing.reportDate}` : ""
  } (filing text unavailable).`;
  const source: Source = {
    id: `extended-sec-edgar-${command.symbol.toLowerCase()}-${formKey}`,
    title,
    url,
    fetchedAt,
    kind: "extended-evidence",
    assetClass: command.assetClass,
    symbol: command.symbol,
    provider: "sec-edgar",
    ...(rawRef !== undefined ? { rawRef } : {}),
    summary,
    identity,
  };
  const item: ExtendedEvidenceItem = {
    category: "sec-edgar",
    title,
    summary,
    sourceIds: [source.id],
    observedAt: fetchedAt,
    metrics: {
      form: filing.form,
      filingDate: filing.filingDate,
      ...(filing.reportDate !== undefined ? { reportDate: filing.reportDate } : {}),
      accessionNumber: filing.accessionNumber,
      primaryDocument: filing.primaryDocument,
      ...(filing.items === undefined ? {} : { items: filing.items.join(",") }),
      ...(earningsRelease === undefined ? {} : earningsRelease),
      cik: match.cik,
    },
    identity,
  };
  return {
    source,
    item,
    sanitizationEntries: sanitizedName === undefined ? [] : [sanitizedName.entry],
  };
}

// Which document the packet text came from, and what the exhibit lookup found. Persisted so a
// Later reader (and the live invariants) can tell a legitimate cover-document preference from an
// Exhibit-resolution regression — the two are indistinguishable from URL and text alone.
export interface EarningsReleaseProvenance {
  readonly earningsReleaseDocument: "exhibit" | "primary" | "none";
  readonly earningsReleaseExhibit: "substantive" | "not-substantive" | "unresolved";
}

export function buildSecFilingSourceItem(
  command: InstrumentCommand,
  match: { cik: string; ticker: string; name?: string },
  filing: SecFiling,
  url: string,
  filingText: FetchTextResult,
  earningsEventDate?: string,
  earningsRelease?: EarningsReleaseProvenance,
): SecFilingSourceItem {
  const formKey = secFilingKey(filing);
  const normalized = normalizeFilingText(filingText.payload);
  const { packet, misses, sectionCount } = secFilingSectionPacket(
    normalized,
    filing.form,
    earningsEventDate,
  );
  if (packet === undefined) {
    return { kind: "missing" };
  }
  const sanitizedPacket = sanitizeModelInputField(packet, {
    provider: "sec-edgar",
    ingress: "sec-filing-text",
    profile: "sec-filing",
    fieldRole: "prose",
  });
  if (
    sanitizedPacket.text === undefined ||
    substantiveAlphaCount(sanitizedPacket.text) < SEC_SECTION_MIN_ALPHA_CHARS
  ) {
    return {
      kind: "dropped",
      sanitizationEntries: [
        sanitizedPacket.entry,
        droppedModelInputItemEntry({
          provider: "sec-edgar",
          ingress: "sec-filing-text",
          profile: "sec-filing",
          fieldRole: "prose",
        }),
      ],
    };
  }
  const sanitizedName =
    match.name === undefined
      ? undefined
      : sanitizeModelInputField(match.name, {
          provider: "sec-edgar",
          ingress: "sec-tickers",
          profile: "short-metadata",
          fieldRole: "title",
        });
  const identity = secIdentity({
    cik: match.cik,
    ticker: match.ticker,
    ...(sanitizedName?.text !== undefined ? { name: sanitizedName.text } : {}),
  });
  const summaryExcerpt = truncateText(sanitizedPacket.text, SEC_FILING_SUMMARY_EXCERPT_CHARS);
  const title = `${command.symbol} SEC ${filing.form}`;
  const summary =
    filing.form === "8-K" || filing.form === "6-K"
      ? `${filing.form} filed ${filing.filingDate}${filing.reportDate !== undefined ? ` for event date ${filing.reportDate}` : ""} (material current report).`
      : `${filing.form} filed ${filing.filingDate}${filing.reportDate !== undefined ? ` for period ${filing.reportDate}` : ""}.`;
  const source: Source = {
    id: `extended-sec-edgar-${command.symbol.toLowerCase()}-${formKey}`,
    title,
    url,
    fetchedAt: filingText.rawSnapshot.fetchedAt,
    kind: "extended-evidence",
    assetClass: command.assetClass,
    symbol: command.symbol,
    provider: "sec-edgar",
    rawRef: filingText.rawSnapshot.id,
    summary,
    snippet: sanitizedPacket.text,
    identity,
  };
  const item: ExtendedEvidenceItem = {
    category: "sec-edgar",
    title,
    summary: `${source.summary} Filing excerpt: ${summaryExcerpt}`,
    sourceIds: [source.id],
    observedAt: source.fetchedAt,
    metrics: {
      form: filing.form,
      filingDate: filing.filingDate,
      ...(filing.reportDate !== undefined ? { reportDate: filing.reportDate } : {}),
      accessionNumber: filing.accessionNumber,
      primaryDocument: filing.primaryDocument,
      ...(filing.items === undefined ? {} : { items: filing.items.join(",") }),
      ...(earningsRelease === undefined ? {} : earningsRelease),
      cik: match.cik,
    },
    identity,
  };
  return {
    kind: "built",
    source,
    item,
    sanitizationEntries: [
      sanitizedPacket.entry,
      ...(sanitizedName === undefined ? [] : [sanitizedName.entry]),
    ],
    misses,
    sectionCount,
    normalizedChars: normalized.length,
    // Only allocate the whole-document byte count when a gap will actually report it — a
    // Healthy filing (the overwhelming majority) never pays for this encode.
    responseBytes:
      misses.length === 0 ? 0 : new TextEncoder().encode(filingText.payload).byteLength,
  };
}
