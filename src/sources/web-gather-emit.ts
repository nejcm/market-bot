import { createHash } from "node:crypto";
import type {
  AssetClass,
  ExtendedEvidenceItem,
  Source,
  SourceGap,
  SubjectKind,
  WebGatherFallbackAudit,
  WebGatherSanitizerAudit,
  WebSearchType,
} from "../domain/types";
import { sourceGap } from "../domain/source-gaps";
import { canonicalizeUrl } from "./news-utils";
import type { CollectContext, RawSourceSnapshot } from "./types";
import {
  aggregateModelInputSanitization,
  droppedModelInputItemEntry,
  sanitizeModelInputField,
  type ModelInputFieldRole,
  type ModelInputSanitizationAggregate,
  type ModelInputSanitizationAggregateEntry,
  type ModelInputSanitizerTelemetry,
} from "./model-input-sanitizer";

// Provider-neutral emit layer for web gather.
// Normalized provider results are validated, sanitized, and turned into low-trust `web` Sources.
// Every provider adapter (Exa, Firecrawl) shares this single model-exposure path.

export const EXA_PROVIDER = "exa";
const MAX_WEB_URL_CHARS = 2048;
const ISO_DATE_OR_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u;
const ZERO_SANITIZER_AUDIT: WebGatherSanitizerAudit = {
  sourceCount: 0,
  sanitizedSourceCount: 0,
  emptyAfterSanitizeCount: 0,
  inputCharCount: 0,
  outputCharCount: 0,
  removedInstructionSpanCount: 0,
  removedChromeHtmlCount: 0,
};

export interface WebGatherToolOutput {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
  readonly sanitizer: WebGatherSanitizerAudit;
  readonly modelInputSanitization?: ModelInputSanitizationAggregate;
  readonly freshness?: WebSearchFreshnessAudit;
  readonly fallback?: WebGatherFallbackAudit;
  readonly failedExaRequest?: {
    readonly reason: string;
    readonly cause: "fetch-failed" | "circuit-open";
  };
}

export interface WebSearchFreshnessAudit {
  readonly searchType: WebSearchType;
  readonly initialWindowDays?: number;
  readonly effectiveWindowDays?: number;
  readonly endPublishedDate: string;
  readonly livecrawl: boolean;
  readonly widened: boolean;
}

export interface WebGatherSubject {
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly subjectLabel?: string;
  readonly assetClass?: AssetClass;
  readonly symbol?: string;
}

// Shared shape every provider's results are normalized into before sanitize/emit.
export interface WebGatherProviderResult {
  readonly id?: string;
  readonly url: string;
  readonly title?: string;
  readonly publishedDate?: string;
  readonly author?: string;
  readonly text?: string;
  readonly summary?: string;
  readonly highlights: readonly string[];
}

export interface WebGatherResultsParse {
  readonly results: readonly WebGatherProviderResult[];
  readonly malformed: boolean;
  readonly creditsUsed?: number;
}

interface SanitizedWebResult {
  readonly source: Source;
  readonly sanitizer: WebGatherSanitizerAudit;
  readonly emptyAfterSanitize: boolean;
  readonly dropped: boolean;
  readonly modelInputSanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
}

export function emptyOutput(
  gaps: readonly SourceGap[],
  rawSnapshots: readonly RawSourceSnapshot[] = [],
): WebGatherToolOutput {
  return { rawSnapshots, sources: [], items: [], gaps, sanitizer: ZERO_SANITIZER_AUDIT };
}

export function webGatherGap(
  message: string,
  cause: NonNullable<SourceGap["cause"]>,
  options: { readonly source?: string; readonly provider?: string } = {},
): SourceGap {
  const source = options.source ?? EXA_PROVIDER;
  return sourceGap({
    source,
    message,
    provider: options.provider ?? source,
    capability: "web-gather",
    cause,
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

// Accepts only bounded-length http(s) URLs without embedded credentials.
export function validatedWebUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "" || trimmed.length > MAX_WEB_URL_CHARS) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      return undefined;
    }
    const normalized = parsed.toString();
    return normalized.length <= MAX_WEB_URL_CHARS ? normalized : undefined;
  } catch {
    return undefined;
  }
}

export function rememberSurfacedUrls(
  results: readonly WebGatherProviderResult[],
  surfacedUrls: Set<string>,
): void {
  for (const result of results) {
    surfacedUrls.add(result.url);
    const canonicalUrl = canonicalizeUrl(result.url);
    if (canonicalUrl !== undefined) {
      surfacedUrls.add(canonicalUrl);
    }
  }
}

export function isSurfacedUrl(url: string, surfacedUrls: ReadonlySet<string>): boolean {
  return surfacedUrls.has(url) || surfacedUrls.has(canonicalizeUrl(url) ?? "");
}

export function outputFromResults(
  ctx: CollectContext,
  subject: WebGatherSubject,
  results: readonly WebGatherProviderResult[],
  rawSnapshots: readonly RawSourceSnapshot[],
  rawRef: string,
  options: { readonly emptyMessage: string; readonly provider?: string },
): WebGatherToolOutput {
  const provider = options.provider ?? EXA_PROVIDER;
  const sanitizedSources = results.map((result) =>
    webResultSource(subject, ctx.fetchedAt, result, rawRef, provider),
  );
  const sources = sanitizedSources
    .filter((result) => !result.dropped)
    .map((result) => result.source);
  const droppedCount = sanitizedSources.filter((result) => result.dropped).length;
  const emptiedContentCount = sanitizedSources.filter(
    (result) => !result.dropped && result.emptyAfterSanitize,
  ).length;
  let gaps: SourceGap[] = [];
  if (droppedCount > 0) {
    gaps = [
      webGatherGap(
        `${provider} dropped ${String(droppedCount)} result(s) with no safe model-visible prose`,
        "validation-failed",
        { source: "web-gather", provider },
      ),
    ];
  } else if (emptiedContentCount > 0) {
    gaps = [
      webGatherGap(
        `${provider} result content was empty after sanitization for ${String(emptiedContentCount)} result(s)`,
        "provider-data-missing",
        { source: "web-gather", provider },
      ),
    ];
  } else if (sources.length === 0) {
    gaps = [webGatherGap(options.emptyMessage, "provider-data-missing", { source: provider })];
  }
  return {
    rawSnapshots,
    sources,
    items: [],
    gaps,
    sanitizer: aggregateSanitizerAudit(sanitizedSources.map((result) => result.sanitizer)),
    modelInputSanitization: aggregateModelInputSanitization(
      sanitizedSources.flatMap((result) => result.modelInputSanitizationEntries),
    ),
  };
}

function webResultSource(
  subject: WebGatherSubject,
  fallbackFetchedAt: string,
  result: WebGatherProviderResult,
  rawRef: string,
  provider: string,
): SanitizedWebResult {
  const canonicalUrl = canonicalizeUrl(result.url);
  const fetchedAt = normalizedPublishedDate(result.publishedDate) ?? fallbackFetchedAt;
  const title = sanitizeOptionalWebText(result.title, provider, "title");
  const publisher = sanitizeOptionalWebText(result.author, provider, "publisher");
  const summary = sanitizeOptionalWebText(result.summary, provider, "summary");
  const snippet = sanitizeOptionalWebText(webSnippetText(result), provider, "snippet");
  const source: Source = {
    id: webSourceId(subject.subjectId, canonicalUrl ?? result.url),
    title: title.text ?? webSourceFallbackTitle(result.url),
    url: result.url,
    ...(publisher.text !== undefined ? { publisher: publisher.text } : {}),
    fetchedAt,
    kind: "web",
    ...(subject.assetClass !== undefined ? { assetClass: subject.assetClass } : {}),
    ...(subject.symbol !== undefined ? { symbol: subject.symbol } : {}),
    provider,
    ...(result.id !== undefined ? { providerArticleId: result.id } : {}),
    ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
    rawRef,
    ...(summary.text !== undefined ? { summary: summary.text } : {}),
    ...(snippet.text !== undefined ? { snippet: snippet.text } : {}),
  };
  const hadModelVisibleInput =
    title.inputPresent || publisher.inputPresent || summary.inputPresent || snippet.inputPresent;
  const hadContentInput = summary.inputPresent || snippet.inputPresent;
  const emptyAfterSanitize =
    hadContentInput && summary.text === undefined && snippet.text === undefined;
  const dropped =
    title.text === undefined && summary.text === undefined && snippet.text === undefined;
  const droppedTelemetry: ModelInputSanitizationAggregateEntry[] = dropped
    ? [
        droppedModelInputItemEntry({
          provider,
          ingress: "web-gather",
          profile: "open-web",
          fieldRole: "prose",
        }),
      ]
    : [];
  return {
    source,
    sanitizer: {
      sourceCount: 1,
      sanitizedSourceCount: hadModelVisibleInput ? 1 : 0,
      emptyAfterSanitizeCount: emptyAfterSanitize ? 1 : 0,
      inputCharCount:
        title.telemetry.inputChars +
        publisher.telemetry.inputChars +
        summary.telemetry.inputChars +
        snippet.telemetry.inputChars,
      outputCharCount:
        title.telemetry.outputChars +
        publisher.telemetry.outputChars +
        summary.telemetry.outputChars +
        snippet.telemetry.outputChars,
      removedInstructionSpanCount:
        title.telemetry.removedInstructionSpanCount +
        publisher.telemetry.removedInstructionSpanCount +
        summary.telemetry.removedInstructionSpanCount +
        snippet.telemetry.removedInstructionSpanCount,
      removedChromeHtmlCount:
        title.telemetry.removedMarkupChromeCount +
        publisher.telemetry.removedMarkupChromeCount +
        summary.telemetry.removedMarkupChromeCount +
        snippet.telemetry.removedMarkupChromeCount,
    },
    emptyAfterSanitize,
    dropped,
    modelInputSanitizationEntries: [
      ...[title, publisher, summary, snippet].flatMap((field) =>
        field.entry === undefined ? [] : [field.entry],
      ),
      ...droppedTelemetry,
    ],
  };
}

function normalizedPublishedDate(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 64 || !ISO_DATE_OR_TIMESTAMP_RE.test(value)) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function webSourceFallbackTitle(url: string): string {
  return new URL(url).hostname;
}

function webSnippetText(result: WebGatherProviderResult): string | undefined {
  const highlighted = result.highlights.join("\n");
  return highlighted.trim() !== "" ? highlighted : result.text;
}

function sanitizeOptionalWebText(
  value: string | undefined,
  provider: string,
  fieldRole: ModelInputFieldRole,
): {
  readonly text?: string;
  readonly inputPresent: boolean;
  readonly entry?: ModelInputSanitizationAggregateEntry;
  readonly telemetry: ModelInputSanitizerTelemetry;
} {
  if (value === undefined) {
    return {
      inputPresent: false,
      telemetry: {
        inputChars: 0,
        outputChars: 0,
        removedInstructionSpanCount: 0,
        removedMarkupChromeCount: 0,
        truncatedFieldCount: 0,
        truncatedCharCount: 0,
        emptyAfterSanitizeFieldCount: 0,
      },
    };
  }
  const result = sanitizeModelInputField(value, {
    provider,
    ingress: "web-gather",
    profile: "open-web",
    fieldRole,
  });
  const { text, entry } = result;
  return {
    ...(text !== undefined ? { text } : {}),
    inputPresent: true,
    entry,
    telemetry: entry,
  };
}

export function aggregateSanitizerAudit(
  entries: readonly WebGatherSanitizerAudit[],
): WebGatherSanitizerAudit {
  return entries.reduce<WebGatherSanitizerAudit>(
    (total, entry) => ({
      sourceCount: total.sourceCount + entry.sourceCount,
      sanitizedSourceCount: total.sanitizedSourceCount + entry.sanitizedSourceCount,
      emptyAfterSanitizeCount: total.emptyAfterSanitizeCount + entry.emptyAfterSanitizeCount,
      inputCharCount: total.inputCharCount + entry.inputCharCount,
      outputCharCount: total.outputCharCount + entry.outputCharCount,
      removedInstructionSpanCount:
        total.removedInstructionSpanCount + entry.removedInstructionSpanCount,
      removedChromeHtmlCount: total.removedChromeHtmlCount + entry.removedChromeHtmlCount,
    }),
    ZERO_SANITIZER_AUDIT,
  );
}

function webSourceId(subjectId: string, url: string): string {
  const digest = createHash("sha256").update(url).digest("hex").slice(0, 8);
  return `web-${subjectId.toLowerCase()}-${digest}`;
}
