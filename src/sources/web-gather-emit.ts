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
import { sanitizeModelInputText, type ModelInputFieldRole } from "./model-input-sanitizer";

// Provider-neutral emit layer for web gather.
// Normalized provider results are validated, sanitized, and turned into low-trust `web` Sources.
// Every provider adapter (Exa, Firecrawl) shares this single model-exposure path.

export const EXA_PROVIDER = "exa";
const MAX_SNIPPET_CHARS = 1200;
const MAX_SUMMARY_CHARS = 1200;
const MAX_TITLE_CHARS = 300;
const MAX_PUBLISHER_CHARS = 200;
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
  readonly freshness?: WebSearchFreshnessAudit;
  readonly fallback?: WebGatherFallbackAudit;
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
  const sources = sanitizedSources.map((result) => result.source);
  if (sources.length === 0) {
    return emptyOutput(
      [webGatherGap(options.emptyMessage, "provider-data-missing", { source: provider })],
      rawSnapshots,
    );
  }
  const gaps = sanitizedSources
    .filter((result) => result.emptyAfterSanitize)
    .map((result) =>
      webGatherGap(
        `${provider} result text was empty after sanitization for ${result.source.url ?? result.source.id}`,
        "provider-data-missing",
        { source: "web-gather", provider },
      ),
    );
  return {
    rawSnapshots,
    sources,
    items: [],
    gaps,
    sanitizer: aggregateSanitizerAudit(sanitizedSources.map((result) => result.sanitizer)),
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
  const title = sanitizeOptionalWebText(result.title, "title", MAX_TITLE_CHARS);
  const publisher = sanitizeOptionalWebText(result.author, "publisher", MAX_PUBLISHER_CHARS);
  const summary = sanitizeOptionalWebText(result.summary, "summary", MAX_SUMMARY_CHARS);
  const snippet = sanitizeOptionalWebText(webSnippetText(result), "snippet", MAX_SNIPPET_CHARS);
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
  return {
    source,
    sanitizer: {
      sourceCount: 1,
      sanitizedSourceCount: hadModelVisibleInput ? 1 : 0,
      emptyAfterSanitizeCount: emptyAfterSanitize ? 1 : 0,
      inputCharCount:
        title.telemetry.inputCharCount +
        publisher.telemetry.inputCharCount +
        summary.telemetry.inputCharCount +
        snippet.telemetry.inputCharCount,
      outputCharCount:
        title.telemetry.outputCharCount +
        publisher.telemetry.outputCharCount +
        summary.telemetry.outputCharCount +
        snippet.telemetry.outputCharCount,
      removedInstructionSpanCount:
        title.telemetry.removedInstructionSpanCount +
        publisher.telemetry.removedInstructionSpanCount +
        summary.telemetry.removedInstructionSpanCount +
        snippet.telemetry.removedInstructionSpanCount,
      removedChromeHtmlCount:
        title.telemetry.removedChromeHtmlCount +
        publisher.telemetry.removedChromeHtmlCount +
        summary.telemetry.removedChromeHtmlCount +
        snippet.telemetry.removedChromeHtmlCount,
    },
    emptyAfterSanitize,
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
  fieldRole: ModelInputFieldRole,
  maxChars: number,
): {
  readonly text?: string;
  readonly inputPresent: boolean;
  readonly telemetry: Pick<
    WebGatherSanitizerAudit,
    "inputCharCount" | "outputCharCount" | "removedInstructionSpanCount" | "removedChromeHtmlCount"
  >;
} {
  if (value === undefined) {
    return {
      inputPresent: false,
      telemetry: {
        inputCharCount: 0,
        outputCharCount: 0,
        removedInstructionSpanCount: 0,
        removedChromeHtmlCount: 0,
      },
    };
  }
  const result = sanitizeModelInputText(value, {
    profile: "open-web",
    fieldRole,
    maxChars,
  });
  const { text, telemetry } = result;
  return {
    ...(text !== undefined ? { text } : {}),
    inputPresent: true,
    telemetry: {
      inputCharCount: telemetry.inputChars,
      outputCharCount: telemetry.outputChars,
      removedInstructionSpanCount: telemetry.removedInstructionSpanCount,
      removedChromeHtmlCount: telemetry.removedMarkupChromeCount,
    },
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
