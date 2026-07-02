import { createHash } from "node:crypto";
import { isInstrumentCommand } from "../cli/args";
import type {
  AssetClass,
  ExtendedEvidenceItem,
  Source,
  SourceGap,
  SubjectKind,
  WebGatherFetchFallbackAudit,
  WebGatherSanitizerAudit,
  WebGatherToolName,
  WebSearchType,
} from "../domain/types";
import { sourceGap, sourceGapWithContext } from "../domain/source-gaps";
import {
  FIRECRAWL_PROVIDER,
  firecrawlTbsForSearchType,
  parseFirecrawlScrapeResult,
  parseFirecrawlSearchResults,
  requestFirecrawlScrape,
  requestFirecrawlSearch,
  type FirecrawlResultsParse,
} from "./firecrawl-web-tools";
import { isRecord, optionalString, readString, stringArrayValue } from "./guards";
import { canonicalizeUrl, encodeQuery } from "./news-utils";
import {
  isFetchJsonResult,
  type CollectContext,
  type FetchJsonResult,
  type FetchLike,
  type RawSourceSnapshot,
} from "./types";
import { sanitizeModelVisibleWebText } from "./web-text-sanitizer";

export const WEB_GATHER_TOOL_UNITS: Record<WebGatherToolName, number> = {
  web_search: 2,
  web_fetch: 1,
};

export interface WebGatherToolOutput {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
  readonly sanitizer: WebGatherSanitizerAudit;
  readonly freshness?: WebSearchFreshnessAudit;
  readonly fetchFallback?: WebGatherFetchFallbackAudit;
}

export interface WebSearchFreshnessAudit {
  readonly searchType: WebSearchType;
  readonly initialWindowDays?: number;
  readonly effectiveWindowDays?: number;
  readonly endPublishedDate: string;
  readonly livecrawl: boolean;
  readonly widened: boolean;
  // Present only when the configured Exa call hard-failed or returned empty/thin results and
  // MARKET_BOT_FIRECRAWL_API_KEY was set, triggering a Firecrawl fallback attempt.
  readonly attemptedProviders?: readonly string[];
  readonly servedProvider?: string;
  readonly fallbackReason?: "hard-failure" | "empty" | "thin";
  readonly firecrawlCreditsUsed?: number;
}

export interface WebGatherSubject {
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly subjectLabel?: string;
  readonly assetClass?: AssetClass;
  readonly symbol?: string;
}

const EXA_API_URL = "https://api.exa.ai";
const EXA_PROVIDER = "exa";
const EXA_SEARCH_ADAPTER = "exa-search";
const EXA_CONTENTS_ADAPTER = "exa-contents";
const DEFAULT_SEARCH_RESULTS = 5;
const MIN_USABLE_SEARCH_RESULTS = 2;
const RECENT_SEARCH_WINDOW_DAYS = 30;
const CURRENT_SUBJECT_WINDOW_DAYS = 180;
export const MAX_WEB_GATHER_SEARCH_RESULTS = 8;
const MAX_TEXT_CHARS = 5000;
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

// Shared shape both Exa and Firecrawl results are normalized into before sanitize/emit, so `outputFromResults` and `webResultSource` reuse the same path regardless of which provider served the request.
interface WebGatherProviderResult {
  readonly id?: string;
  readonly url: string;
  readonly title?: string;
  readonly publishedDate?: string;
  readonly author?: string;
  readonly text?: string;
  readonly summary?: string;
  readonly highlights: readonly string[];
}

interface WebGatherResultsParse {
  readonly results: readonly WebGatherProviderResult[];
  readonly malformed: boolean;
}

interface SanitizedWebResult {
  readonly source: Source;
  readonly sanitizer: WebGatherSanitizerAudit;
  readonly emptyAfterSanitize: boolean;
}

export async function executeWebGatherTool(
  tool: WebGatherToolName,
  args: unknown,
  ctx: CollectContext,
  surfacedUrls: Set<string>,
  subject = webGatherSubjectFromContext(ctx),
): Promise<WebGatherToolOutput> {
  if (subject === undefined) {
    return emptyOutput([webGatherGap("Web gather tools require a subject", "validation-failed")]);
  }
  if (ctx.exaApiKey === undefined) {
    return emptyOutput([webGatherGap("MARKET_BOT_EXA_API_KEY is not set", "missing-credential")]);
  }

  const apiKey = ctx.exaApiKey;
  return tool === "web_search"
    ? executeWebSearch(args, ctx, surfacedUrls, apiKey, subject)
    : executeWebFetch(args, ctx, surfacedUrls, apiKey, subject);
}

function webGatherSubjectFromContext(ctx: CollectContext): WebGatherSubject | undefined {
  if (!isInstrumentCommand(ctx.command)) {
    return undefined;
  }
  return {
    subjectKind: ctx.command.assetClass === "equity" ? "company" : "crypto-asset",
    subjectId: ctx.command.symbol,
    symbol: ctx.command.symbol,
    assetClass: ctx.command.assetClass,
  };
}

function emptyOutput(
  gaps: readonly SourceGap[],
  rawSnapshots: readonly RawSourceSnapshot[] = [],
): WebGatherToolOutput {
  return { rawSnapshots, sources: [], items: [], gaps, sanitizer: ZERO_SANITIZER_AUDIT };
}

function webGatherGap(
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

function firecrawlFailureGap(gap: SourceGap): SourceGap {
  return sourceGapWithContext(gap, {
    provider: FIRECRAWL_PROVIDER,
    capability: "web-gather",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function exaRequestInit(apiKey: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
  };
}

function exaEndpointFetch(baseFetch: FetchLike): FetchLike {
  return (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    url.search = "";
    return baseFetch(url, init);
  };
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isSourceGap(value: SourceGap | object): value is SourceGap {
  return "source" in value && "message" in value;
}

function searchArgs(
  args: unknown,
):
  | { readonly query: string; readonly searchType: WebSearchType; readonly numResults: number }
  | SourceGap {
  if (!isRecord(args)) {
    return webGatherGap("web_search args must be an object", "validation-failed");
  }
  const query = readString(args, "query");
  if (query === undefined) {
    return webGatherGap("web_search requires a non-empty query", "validation-failed");
  }
  const searchType = readString(args, "searchType");
  if (
    searchType !== "news" &&
    searchType !== "market" &&
    searchType !== "current-subject" &&
    searchType !== "background"
  ) {
    return webGatherGap(
      "web_search searchType must be news, market, current-subject, or background",
      "validation-failed",
    );
  }
  const requested = readPositiveInteger(args.numResults);
  return {
    query,
    searchType,
    numResults: Math.min(requested ?? DEFAULT_SEARCH_RESULTS, MAX_WEB_GATHER_SEARCH_RESULTS),
  };
}

function fetchArgs(args: unknown): { readonly url: string } | SourceGap {
  if (!isRecord(args)) {
    return webGatherGap("web_fetch args must be an object", "validation-failed");
  }
  const url = readString(args, "url");
  if (url === undefined) {
    return webGatherGap("web_fetch requires a non-empty url", "validation-failed");
  }
  return { url };
}

async function executeWebSearch(
  args: unknown,
  ctx: CollectContext,
  surfacedUrls: Set<string>,
  apiKey: string,
  subject: WebGatherSubject,
): Promise<WebGatherToolOutput> {
  const parsed = searchArgs(args);
  if (isSourceGap(parsed)) {
    return emptyOutput([parsed]);
  }

  const initialWindowDays = searchWindowDays(parsed.searchType);
  const initial = await requestExaSearch(
    parsed,
    ctx,
    apiKey,
    initialWindowDays,
    parsed.searchType !== "background",
  );
  const baseFreshness = (
    widened: boolean,
    effectiveWindowDays?: number,
  ): WebSearchFreshnessAudit => ({
    searchType: parsed.searchType,
    ...(initialWindowDays !== undefined ? { initialWindowDays } : {}),
    ...(effectiveWindowDays !== undefined ? { effectiveWindowDays } : {}),
    endPublishedDate: ctx.fetchedAt,
    livecrawl: parsed.searchType !== "background",
    widened,
  });
  if (!isFetchJsonResult(initial)) {
    return maybeFirecrawlSearchFallback(ctx, subject, surfacedUrls, parsed, {
      exaGaps: [exaFailureGap(initial)],
      exaResults: [],
      exaRawSnapshots: [],
      exaRawRef: "",
      freshness: baseFreshness(false),
      fallbackReason: "hard-failure",
    });
  }

  const initialParsed = readExaResults(initial.payload);
  if (initialParsed.malformed) {
    return maybeFirecrawlSearchFallback(ctx, subject, surfacedUrls, parsed, {
      exaGaps: [webGatherGap("Exa search response was malformed", "malformed-response")],
      exaResults: [],
      exaRawSnapshots: [initial.rawSnapshot],
      exaRawRef: "",
      freshness: baseFreshness(false, initialWindowDays),
      fallbackReason: "hard-failure",
    });
  }

  const shouldWiden =
    initialParsed.results.length < MIN_USABLE_SEARCH_RESULTS && parsed.searchType !== "background";
  const fallbackWindowDays = widenedSearchWindowDays(parsed.searchType);
  const fallback = shouldWiden
    ? await requestExaSearch(parsed, ctx, apiKey, fallbackWindowDays, true)
    : undefined;
  const fallbackResult =
    fallback !== undefined && isFetchJsonResult(fallback) ? fallback : undefined;
  const fallbackParsed =
    fallbackResult !== undefined ? readExaResults(fallbackResult.payload) : undefined;
  const useFallback =
    fallbackParsed !== undefined &&
    !fallbackParsed.malformed &&
    fallbackParsed.results.length >= initialParsed.results.length;
  const results = useFallback ? fallbackParsed.results : initialParsed.results;
  const rawSnapshots = [
    initial.rawSnapshot,
    ...(fallbackResult !== undefined ? [fallbackResult.rawSnapshot] : []),
  ];
  const rawRef =
    useFallback && fallbackResult !== undefined
      ? fallbackResult.rawSnapshot.id
      : initial.rawSnapshot.id;
  const exaGaps: SourceGap[] = [];
  if (fallback !== undefined && !isFetchJsonResult(fallback)) {
    exaGaps.push(exaFailureGap(fallback));
  } else if (fallbackParsed?.malformed === true) {
    exaGaps.push(webGatherGap("Widened Exa search response was malformed", "malformed-response"));
  }
  const effectiveWindowDays = shouldWiden ? fallbackWindowDays : initialWindowDays;

  return maybeFirecrawlSearchFallback(ctx, subject, surfacedUrls, parsed, {
    exaGaps,
    exaResults: results,
    exaRawSnapshots: rawSnapshots,
    exaRawRef: rawRef,
    freshness: baseFreshness(shouldWiden, effectiveWindowDays),
    fallbackReason: results.length === 0 ? "empty" : "thin",
  });
}

interface ExaSearchOutcome {
  readonly exaGaps: readonly SourceGap[];
  readonly exaResults: readonly WebGatherProviderResult[];
  readonly exaRawSnapshots: readonly RawSourceSnapshot[];
  readonly exaRawRef: string;
  readonly freshness: WebSearchFreshnessAudit;
  readonly fallbackReason: "hard-failure" | "empty" | "thin";
}

// Attempts a Firecrawl fallback when Exa is unusable (hard failure, malformed, or fewer than MIN_USABLE_SEARCH_RESULTS results) and MARKET_BOT_FIRECRAWL_API_KEY is configured. When Exa is usable, or no Firecrawl key is set, behavior is identical to the pre-fallback Exa-only path (fallback-only policy: Firecrawl never runs in place of a missing Exa key).
async function maybeFirecrawlSearchFallback(
  ctx: CollectContext,
  subject: WebGatherSubject,
  surfacedUrls: Set<string>,
  parsed: {
    readonly query: string;
    readonly searchType: WebSearchType;
    readonly numResults: number;
  },
  exa: ExaSearchOutcome,
): Promise<WebGatherToolOutput> {
  const exaUsable = exa.exaResults.length >= MIN_USABLE_SEARCH_RESULTS;
  if (exaUsable || ctx.firecrawlApiKey === undefined) {
    rememberSurfacedUrls(exa.exaResults, surfacedUrls);
    if (exa.exaResults.length === 0 && exa.exaGaps.length > 0) {
      return { ...emptyOutput(exa.exaGaps, exa.exaRawSnapshots), freshness: exa.freshness };
    }
    return finishWebSearchOutput(
      ctx,
      subject,
      exa.exaResults,
      exa.exaRawSnapshots,
      exa.exaRawRef,
      EXA_PROVIDER,
      exa.exaGaps,
      exa.freshness,
      parsed.query,
    );
  }

  const exaGaps =
    exa.exaGaps.length > 0
      ? exa.exaGaps
      : [
          webGatherGap(
            exa.exaResults.length === 0
              ? `Exa returned no usable web search results for "${parsed.query}"`
              : `Exa returned only ${String(exa.exaResults.length)} usable web search result(s) for "${parsed.query}"`,
            "provider-data-missing",
          ),
        ];
  const tbs = firecrawlTbsForSearchType(parsed.searchType);
  const firecrawlFetch = await requestFirecrawlSearch(
    ctx,
    ctx.firecrawlApiKey,
    parsed.query,
    parsed.numResults,
    tbs,
  );
  const resolved = resolveFirecrawlFallback(firecrawlFetch, exa, {
    malformedMessage: "Firecrawl search response was malformed",
    emptyMessage: `Firecrawl returned no usable web search results for "${parsed.query}"`,
    parse: (payload) => parseFirecrawlSearchResults(payload),
  });
  // When Firecrawl recovered the request, the Exa shortfall is closed, so it is not surfaced as a
  // Data gap; the freshness audit still records the attempt. When the fallback also fails, the Exa
  // Shortfall plus the Firecrawl failure gap are both disclosed.
  const fallbackServed = resolved.servedProvider === FIRECRAWL_PROVIDER;
  const gaps = fallbackServed ? [...resolved.gaps] : [...exaGaps, ...resolved.gaps];
  rememberSurfacedUrls(resolved.results, surfacedUrls);
  const servedProvider = resolved.results.length > 0 ? resolved.servedProvider : undefined;
  const freshness: WebSearchFreshnessAudit = {
    ...exa.freshness,
    attemptedProviders: [EXA_PROVIDER, FIRECRAWL_PROVIDER],
    ...(servedProvider !== undefined ? { servedProvider } : {}),
    fallbackReason: exa.fallbackReason,
    ...(resolved.creditsUsed !== undefined ? { firecrawlCreditsUsed: resolved.creditsUsed } : {}),
  };
  if (resolved.results.length === 0) {
    return { ...emptyOutput(gaps, resolved.rawSnapshots), freshness };
  }
  return finishWebSearchOutput(
    ctx,
    subject,
    resolved.results,
    resolved.rawSnapshots,
    resolved.rawRef,
    resolved.servedProvider,
    gaps,
    freshness,
    parsed.query,
  );
}

interface ResolvedFirecrawlFallback {
  readonly results: readonly WebGatherProviderResult[];
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly rawRef: string;
  readonly servedProvider: string;
  readonly gaps: readonly SourceGap[];
  readonly creditsUsed?: number;
}

// Folds a Firecrawl fetch into a fallback outcome; usable content becomes the served provider.
// Failure, malformed, or empty preserves the Exa results and adds a provider-tagged gap.
function resolveFirecrawlFallback(
  firecrawlFetch: FetchJsonResult | SourceGap,
  exa: {
    readonly exaResults: readonly WebGatherProviderResult[];
    readonly exaRawSnapshots: readonly RawSourceSnapshot[];
    readonly exaRawRef: string;
  },
  options: {
    readonly malformedMessage: string;
    readonly emptyMessage: string;
    readonly parse: (payload: unknown) => FirecrawlResultsParse;
  },
): ResolvedFirecrawlFallback {
  const exaOutcome: ResolvedFirecrawlFallback = {
    results: exa.exaResults,
    rawSnapshots: exa.exaRawSnapshots,
    rawRef: exa.exaRawRef,
    servedProvider: EXA_PROVIDER,
    gaps: [],
  };
  if (!isFetchJsonResult(firecrawlFetch)) {
    return { ...exaOutcome, gaps: [firecrawlFailureGap(firecrawlFetch)] };
  }
  const rawSnapshots = [...exa.exaRawSnapshots, firecrawlFetch.rawSnapshot];
  const parsed = options.parse(firecrawlFetch.payload);
  const { creditsUsed } = parsed;
  const withCredits = creditsUsed !== undefined ? { creditsUsed } : {};
  if (parsed.malformed) {
    return {
      ...exaOutcome,
      rawSnapshots,
      ...withCredits,
      gaps: [
        webGatherGap(options.malformedMessage, "malformed-response", {
          source: FIRECRAWL_PROVIDER,
        }),
      ],
    };
  }
  if (parsed.results.length === 0) {
    return {
      ...exaOutcome,
      rawSnapshots,
      ...withCredits,
      gaps: [
        webGatherGap(options.emptyMessage, "provider-data-missing", { source: FIRECRAWL_PROVIDER }),
      ],
    };
  }
  return {
    results: parsed.results,
    rawSnapshots,
    rawRef: firecrawlFetch.rawSnapshot.id,
    servedProvider: FIRECRAWL_PROVIDER,
    gaps: [],
    ...withCredits,
  };
}

function finishWebSearchOutput(
  ctx: CollectContext,
  subject: WebGatherSubject,
  results: readonly WebGatherProviderResult[],
  rawSnapshots: readonly RawSourceSnapshot[],
  rawRef: string,
  provider: string,
  gaps: readonly SourceGap[],
  freshness: WebSearchFreshnessAudit,
  query: string,
): WebGatherToolOutput {
  const output = outputFromResults(ctx, subject, results, rawSnapshots, rawRef, {
    emptyMessage: `${provider === FIRECRAWL_PROVIDER ? "Firecrawl" : "Exa"} returned no usable web search results for "${query}"`,
    provider,
  });
  return { ...output, gaps: [...output.gaps, ...gaps], freshness };
}

function searchWindowDays(searchType: WebSearchType): number | undefined {
  if (searchType === "news" || searchType === "market") {
    return RECENT_SEARCH_WINDOW_DAYS;
  }
  return searchType === "current-subject" ? CURRENT_SUBJECT_WINDOW_DAYS : undefined;
}

function widenedSearchWindowDays(searchType: WebSearchType): number | undefined {
  return searchType === "news" || searchType === "market" ? CURRENT_SUBJECT_WINDOW_DAYS : undefined;
}

function publishedDateBefore(isoTimestamp: string, days: number): string {
  const date = new Date(isoTimestamp);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

async function requestExaSearch(
  parsed: {
    readonly query: string;
    readonly searchType: WebSearchType;
    readonly numResults: number;
  },
  ctx: CollectContext,
  apiKey: string,
  windowDays: number | undefined,
  livecrawl: boolean,
) {
  const body = {
    query: parsed.query,
    type: "auto",
    numResults: parsed.numResults,
    ...(windowDays !== undefined
      ? { startPublishedDate: publishedDateBefore(ctx.fetchedAt, windowDays) }
      : {}),
    endPublishedDate: ctx.fetchedAt,
    contents: {
      text: { maxCharacters: MAX_TEXT_CHARS },
      summary: { query: parsed.query },
      highlights: { numSentences: 2, highlightsPerUrl: 2, query: parsed.query },
      ...(livecrawl ? { livecrawl: "always" } : {}),
    },
  };
  return ctx.request.json({
    url: `${EXA_API_URL}/search?${encodeQuery({
      query: parsed.query,
      numResults: String(parsed.numResults),
      searchType: parsed.searchType,
      startPublishedDate:
        windowDays === undefined ? "unbounded" : publishedDateBefore(ctx.fetchedAt, windowDays),
      endPublishedDate: ctx.fetchedAt,
      livecrawl: livecrawl ? "always" : "never",
    })}`,
    adapter: EXA_SEARCH_ADAPTER,
    init: exaRequestInit(apiKey, body),
    fetch: exaEndpointFetch,
  });
}

async function executeWebFetch(
  args: unknown,
  ctx: CollectContext,
  surfacedUrls: Set<string>,
  apiKey: string,
  subject: WebGatherSubject,
): Promise<WebGatherToolOutput> {
  const parsed = fetchArgs(args);
  if (isSourceGap(parsed)) {
    return emptyOutput([parsed]);
  }
  if (!isSurfacedUrl(parsed.url, surfacedUrls)) {
    return emptyOutput([
      webGatherGap("web_fetch url was not returned by web_search in this run", "validation-failed"),
    ]);
  }

  const body = {
    urls: [parsed.url],
    text: { maxCharacters: MAX_TEXT_CHARS },
    summary: true,
    highlights: { numSentences: 2, highlightsPerUrl: 2 },
  };
  const fetched = await ctx.request.json({
    url: `${EXA_API_URL}/contents?${encodeQuery({ url: parsed.url })}`,
    adapter: EXA_CONTENTS_ADAPTER,
    init: exaRequestInit(apiKey, body),
    fetch: exaEndpointFetch,
  });
  if (!isFetchJsonResult(fetched)) {
    return maybeFirecrawlFetchFallback(ctx, subject, parsed.url, {
      exaGaps: [exaFailureGap(fetched)],
      exaResults: [],
      exaRawSnapshots: [],
      exaRawRef: "",
      fallbackReason: "hard-failure",
    });
  }
  const { results, malformed } = readExaResults(fetched.payload);
  if (malformed) {
    return maybeFirecrawlFetchFallback(ctx, subject, parsed.url, {
      exaGaps: [webGatherGap("Exa contents response was malformed", "malformed-response")],
      exaResults: [],
      exaRawSnapshots: [fetched.rawSnapshot],
      exaRawRef: "",
      fallbackReason: "hard-failure",
    });
  }

  return maybeFirecrawlFetchFallback(ctx, subject, parsed.url, {
    exaGaps: [],
    exaResults: results,
    exaRawSnapshots: [fetched.rawSnapshot],
    exaRawRef: fetched.rawSnapshot.id,
    fallbackReason: "empty",
  });
}

interface ExaFetchOutcome {
  readonly exaGaps: readonly SourceGap[];
  readonly exaResults: readonly WebGatherProviderResult[];
  readonly exaRawSnapshots: readonly RawSourceSnapshot[];
  readonly exaRawRef: string;
  readonly fallbackReason: "hard-failure" | "empty";
}

// Attempts a Firecrawl scrape when Exa's /contents call hard-fails, is malformed, or returns no usable content, and MARKET_BOT_FIRECRAWL_API_KEY is configured. Mirrors maybeFirecrawlSearchFallback's fallback-only policy for web_fetch.
async function maybeFirecrawlFetchFallback(
  ctx: CollectContext,
  subject: WebGatherSubject,
  url: string,
  exa: ExaFetchOutcome,
): Promise<WebGatherToolOutput> {
  const exaUsable = exa.exaResults.length > 0;
  if (exaUsable || ctx.firecrawlApiKey === undefined) {
    if (!exaUsable && exa.exaGaps.length > 0) {
      return emptyOutput(exa.exaGaps, exa.exaRawSnapshots);
    }
    return finishWebFetchOutput(
      ctx,
      subject,
      exa.exaResults,
      exa.exaRawSnapshots,
      exa.exaRawRef,
      EXA_PROVIDER,
      exa.exaGaps,
      url,
    );
  }

  const exaGaps =
    exa.exaGaps.length > 0
      ? exa.exaGaps
      : [
          webGatherGap(
            `Exa returned no usable fetched content for ${url}`,
            "provider-data-missing",
          ),
        ];
  const firecrawlFetch = await requestFirecrawlScrape(ctx, ctx.firecrawlApiKey, url);
  const resolved = resolveFirecrawlFallback(firecrawlFetch, exa, {
    malformedMessage: `Firecrawl returned no usable fetched content for ${url}`,
    emptyMessage: `Firecrawl returned no usable fetched content for ${url}`,
    parse: (payload) => parseFirecrawlScrapeResult(url, payload),
  });
  // As in the search fallback, a successful Firecrawl scrape closes the Exa shortfall, so it is not
  // Surfaced as a data gap; the fetchFallback audit still records the attempt and paid credits.
  const fallbackServed = resolved.servedProvider === FIRECRAWL_PROVIDER;
  const gaps = fallbackServed ? [...resolved.gaps] : [...exaGaps, ...resolved.gaps];
  const servedProvider = resolved.results.length > 0 ? resolved.servedProvider : undefined;
  const fetchFallback: WebGatherFetchFallbackAudit = {
    attemptedProviders: [EXA_PROVIDER, FIRECRAWL_PROVIDER],
    ...(servedProvider !== undefined ? { servedProvider } : {}),
    fallbackReason: exa.fallbackReason,
    ...(resolved.creditsUsed !== undefined ? { firecrawlCreditsUsed: resolved.creditsUsed } : {}),
  };
  if (resolved.results.length === 0) {
    return { ...emptyOutput(gaps, resolved.rawSnapshots), fetchFallback };
  }
  return {
    ...finishWebFetchOutput(
      ctx,
      subject,
      resolved.results,
      resolved.rawSnapshots,
      resolved.rawRef,
      resolved.servedProvider,
      gaps,
      url,
    ),
    fetchFallback,
  };
}

function finishWebFetchOutput(
  ctx: CollectContext,
  subject: WebGatherSubject,
  results: readonly WebGatherProviderResult[],
  rawSnapshots: readonly RawSourceSnapshot[],
  rawRef: string,
  provider: string,
  gaps: readonly SourceGap[],
  url: string,
): WebGatherToolOutput {
  const output = outputFromResults(ctx, subject, results, rawSnapshots, rawRef, {
    emptyMessage: `${provider === FIRECRAWL_PROVIDER ? "Firecrawl" : "Exa"} returned no usable fetched content for ${url}`,
    provider,
  });
  return { ...output, gaps: [...output.gaps, ...gaps] };
}

function exaFailureGap(gap: SourceGap): SourceGap {
  return sourceGapWithContext(gap, {
    provider: EXA_PROVIDER,
    capability: "web-gather",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function readExaResults(payload: unknown): WebGatherResultsParse {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return { results: [], malformed: true };
  }
  const results = payload.results.flatMap((value): WebGatherProviderResult[] => {
    if (!isRecord(value)) {
      return [];
    }
    const url = validatedWebUrl(readString(value, "url"));
    if (url === undefined) {
      return [];
    }
    const id = optionalString(value, "id");
    const title = optionalString(value, "title");
    const publishedDate = optionalString(value, "publishedDate");
    const author = optionalString(value, "author");
    const text = optionalString(value, "text");
    const summary = optionalString(value, "summary");
    return [
      {
        url,
        ...(id !== undefined ? { id } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(publishedDate !== undefined ? { publishedDate } : {}),
        ...(author !== undefined ? { author } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(summary !== undefined ? { summary } : {}),
        highlights: stringArrayValue(value.highlights),
      },
    ];
  });
  return { results, malformed: payload.results.length > 0 && results.length === 0 };
}

function validatedWebUrl(value: string | undefined): string | undefined {
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

function rememberSurfacedUrls(
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

function isSurfacedUrl(url: string, surfacedUrls: ReadonlySet<string>): boolean {
  return surfacedUrls.has(url) || surfacedUrls.has(canonicalizeUrl(url) ?? "");
}

function outputFromResults(
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
  const title = sanitizeOptionalWebText(result.title, MAX_TITLE_CHARS);
  const publisher = sanitizeOptionalWebText(result.author, MAX_PUBLISHER_CHARS);
  const summary = sanitizeOptionalWebText(result.summary, MAX_SUMMARY_CHARS);
  const snippet = sanitizeOptionalWebText(webSnippetText(result), MAX_SNIPPET_CHARS);
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

function webSnippetText(result: WebGatherProviderResult): string | undefined {
  const highlighted = result.highlights.join("\n");
  return highlighted.trim() !== "" ? highlighted : result.text;
}

function truncate(value: string, maxChars: number): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars).trimEnd()}...`;
}

function sanitizeOptionalWebText(
  value: string | undefined,
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
  const result = sanitizeModelVisibleWebText(value);
  const text = result.text === undefined ? undefined : truncate(result.text, maxChars);
  return {
    ...(text !== undefined ? { text } : {}),
    inputPresent: true,
    telemetry: {
      inputCharCount: result.telemetry.inputChars,
      outputCharCount: result.telemetry.outputChars,
      removedInstructionSpanCount: result.telemetry.removedInstructionSpanCount,
      removedChromeHtmlCount: result.telemetry.removedChromeHtmlCount,
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
