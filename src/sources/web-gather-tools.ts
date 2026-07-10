import { isInstrumentCommand } from "../cli/args";
import type {
  SourceGap,
  WebGatherFallbackAudit,
  WebGatherToolName,
  WebSearchType,
} from "../domain/types";
import { sourceGapWithContext } from "../domain/source-gaps";
import {
  FIRECRAWL_PROVIDER,
  firecrawlTbsForSearchType,
  parseFirecrawlScrapeResult,
  parseFirecrawlSearchResults,
  requestFirecrawlScrape,
  requestFirecrawlSearch,
} from "./firecrawl-web-tools";
import { isRecord, optionalString, readString, stringArrayValue } from "./guards";
import { encodeQuery } from "./news-utils";
import {
  isFetchJsonResult,
  type CollectContext,
  type FetchJsonResult,
  type FetchLike,
  type RawSourceSnapshot,
} from "./types";
import {
  EXA_PROVIDER,
  emptyOutput,
  isSurfacedUrl,
  outputFromResults,
  rememberSurfacedUrls,
  validatedWebUrl,
  webGatherGap,
  type WebGatherProviderResult,
  type WebGatherResultsParse,
  type WebGatherSubject,
  type WebGatherToolOutput,
  type WebSearchFreshnessAudit,
} from "./web-gather-emit";
import { WEB_GATHER_FETCH_URL_NOT_SURFACED_REASON } from "./web-gather-rejection-reasons";

export const WEB_GATHER_TOOL_UNITS: Record<WebGatherToolName, number> = {
  web_search: 2,
  web_fetch: 1,
};

const EXA_API_URL = "https://api.exa.ai";
const EXA_SEARCH_ADAPTER = "exa-search";
const EXA_CONTENTS_ADAPTER = "exa-contents";
const DEFAULT_SEARCH_RESULTS = 5;
// Narrowed per-query ingestion default applied when a durable Web Subject Profile was reused into the run: fresh gather then exists only for recency, corroboration, or gap coverage, so a full page of results per query is disproportionate. Stays above MIN_USABLE_SEARCH_RESULTS.
export const REUSED_PROFILE_DEFAULT_SEARCH_RESULTS = 3;
const MIN_USABLE_SEARCH_RESULTS = 2;
const RECENT_SEARCH_WINDOW_DAYS = 30;
const CURRENT_SUBJECT_WINDOW_DAYS = 180;
export const MAX_WEB_GATHER_SEARCH_RESULTS = 8;
const MAX_TEXT_CHARS = 5000;

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

interface ParsedSearchArgs {
  readonly query: string;
  readonly searchType: WebSearchType;
  readonly numResults: number;
}

function searchArgs(args: unknown): ParsedSearchArgs | SourceGap {
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

  const spec = searchFallbackSpec(ctx, parsed, surfacedUrls);
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
    return withFirecrawlFallback(ctx, subject, spec, {
      gaps: [exaFailureGap(initial)],
      results: [],
      rawSnapshots: [],
      rawRef: "",
      exaResponded: false,
      freshness: baseFreshness(false),
    });
  }

  const initialParsed = readExaResults(initial.payload);
  if (initialParsed.malformed) {
    return withFirecrawlFallback(ctx, subject, spec, {
      gaps: [webGatherGap("Exa search response was malformed", "malformed-response")],
      results: [],
      rawSnapshots: [initial.rawSnapshot],
      rawRef: "",
      exaResponded: false,
      freshness: baseFreshness(false, initialWindowDays),
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
  const gaps: SourceGap[] = [];
  if (fallback !== undefined && !isFetchJsonResult(fallback)) {
    gaps.push(exaFailureGap(fallback));
  } else if (fallbackParsed?.malformed === true) {
    gaps.push(webGatherGap("Widened Exa search response was malformed", "malformed-response"));
  }
  const effectiveWindowDays = shouldWiden ? fallbackWindowDays : initialWindowDays;

  return withFirecrawlFallback(ctx, subject, spec, {
    gaps,
    results,
    rawSnapshots,
    rawRef,
    exaResponded: true,
    freshness: baseFreshness(shouldWiden, effectiveWindowDays),
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
      webGatherGap(WEB_GATHER_FETCH_URL_NOT_SURFACED_REASON, "validation-failed"),
    ]);
  }

  const spec = fetchFallbackSpec(ctx, parsed.url);
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
    return withFirecrawlFallback(ctx, subject, spec, {
      gaps: [exaFailureGap(fetched)],
      results: [],
      rawSnapshots: [],
      rawRef: "",
      exaResponded: false,
    });
  }
  const { results, malformed } = readExaResults(fetched.payload);
  if (malformed) {
    return withFirecrawlFallback(ctx, subject, spec, {
      gaps: [webGatherGap("Exa contents response was malformed", "malformed-response")],
      results: [],
      rawSnapshots: [fetched.rawSnapshot],
      rawRef: "",
      exaResponded: false,
    });
  }

  return withFirecrawlFallback(ctx, subject, spec, {
    gaps: [],
    results,
    rawSnapshots: [fetched.rawSnapshot],
    rawRef: fetched.rawSnapshot.id,
    exaResponded: true,
  });
}

// What the Exa phase of a web gather tool call produced, independent of which tool ran.
interface ExaWebOutcome {
  readonly gaps: readonly SourceGap[];
  readonly results: readonly WebGatherProviderResult[];
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly rawRef: string;
  // False when Exa produced no well-formed response (hard failure or malformed payload).
  readonly exaResponded: boolean;
  readonly freshness?: WebSearchFreshnessAudit;
}

// Per-tool wiring for the shared Firecrawl fallback.
// Carries the usability threshold, the Firecrawl request/parser, and tool-specific gap messages.
interface FirecrawlFallbackSpec {
  readonly minUsableResults: number;
  readonly exaShortfallGap: (resultCount: number) => SourceGap;
  readonly requestFallback: (apiKey: string) => Promise<FetchJsonResult | SourceGap>;
  readonly parse: (payload: unknown) => WebGatherResultsParse;
  readonly firecrawlMalformedMessage: string;
  readonly firecrawlEmptyMessage: string;
  readonly noUsableMessage: (providerLabel: string) => string;
  readonly surfacedUrls?: Set<string>;
}

function searchFallbackSpec(
  ctx: CollectContext,
  parsed: ParsedSearchArgs,
  surfacedUrls: Set<string>,
): FirecrawlFallbackSpec {
  return {
    minUsableResults: MIN_USABLE_SEARCH_RESULTS,
    exaShortfallGap: (resultCount) =>
      webGatherGap(
        resultCount === 0
          ? `Exa returned no usable web search results for "${parsed.query}"`
          : `Exa returned only ${String(resultCount)} usable web search result(s) for "${parsed.query}"`,
        "provider-data-missing",
      ),
    requestFallback: (apiKey) =>
      requestFirecrawlSearch(
        ctx,
        apiKey,
        parsed.query,
        parsed.numResults,
        firecrawlTbsForSearchType(parsed.searchType),
      ),
    parse: parseFirecrawlSearchResults,
    firecrawlMalformedMessage: "Firecrawl search response was malformed",
    firecrawlEmptyMessage: `Firecrawl returned no usable web search results for "${parsed.query}"`,
    noUsableMessage: (providerLabel) =>
      `${providerLabel} returned no usable web search results for "${parsed.query}"`,
    surfacedUrls,
  };
}

function fetchFallbackSpec(ctx: CollectContext, url: string): FirecrawlFallbackSpec {
  return {
    minUsableResults: 1,
    exaShortfallGap: () =>
      webGatherGap(`Exa returned no usable fetched content for ${url}`, "provider-data-missing"),
    requestFallback: (apiKey) => requestFirecrawlScrape(ctx, apiKey, url),
    parse: (payload) => parseFirecrawlScrapeResult(url, payload),
    firecrawlMalformedMessage: `Firecrawl returned no usable fetched content for ${url}`,
    firecrawlEmptyMessage: `Firecrawl returned no usable fetched content for ${url}`,
    noUsableMessage: (providerLabel) =>
      `${providerLabel} returned no usable fetched content for ${url}`,
  };
}

// Attempts a Firecrawl fallback when MARKET_BOT_FIRECRAWL_API_KEY is set and Exa was unusable.
// Unusable means hard failure, malformed payload, or fewer results than the spec's usable minimum.
// With usable Exa results, or no Firecrawl key, behavior is identical to the Exa-only path.
// Fallback-only policy: Firecrawl never runs in place of a missing Exa key.
// A successful fallback closes the Exa shortfall, so it is not surfaced as a data gap.
// The fallback audit records the attempt, the served provider, and paid credits either way.
async function withFirecrawlFallback(
  ctx: CollectContext,
  subject: WebGatherSubject,
  spec: FirecrawlFallbackSpec,
  exa: ExaWebOutcome,
): Promise<WebGatherToolOutput> {
  const exaUsable = exa.results.length >= spec.minUsableResults;
  if (exaUsable || ctx.firecrawlApiKey === undefined) {
    if (spec.surfacedUrls !== undefined) {
      rememberSurfacedUrls(exa.results, spec.surfacedUrls);
    }
    if (exa.results.length === 0 && exa.gaps.length > 0) {
      return withFreshness(emptyOutput(exa.gaps, exa.rawSnapshots), exa.freshness);
    }
    return withFreshness(
      finishOutput(ctx, subject, spec, exa, EXA_PROVIDER, exa.gaps),
      exa.freshness,
    );
  }

  const exaGaps = exa.gaps.length > 0 ? exa.gaps : [spec.exaShortfallGap(exa.results.length)];
  const resolved = resolveFirecrawlFallback(
    await spec.requestFallback(ctx.firecrawlApiKey),
    spec,
    exa,
  );
  const gaps =
    resolved.servedProvider === FIRECRAWL_PROVIDER ? resolved.gaps : [...exaGaps, ...resolved.gaps];
  if (spec.surfacedUrls !== undefined) {
    rememberSurfacedUrls(resolved.results, spec.surfacedUrls);
  }
  const fallback: WebGatherFallbackAudit = {
    attemptedProviders: [EXA_PROVIDER, FIRECRAWL_PROVIDER],
    ...(resolved.servedProvider !== undefined ? { servedProvider: resolved.servedProvider } : {}),
    fallbackReason: fallbackReasonFor(exa),
    ...(resolved.creditsUsed !== undefined ? { firecrawlCreditsUsed: resolved.creditsUsed } : {}),
  };
  const output =
    resolved.results.length === 0
      ? emptyOutput(gaps, resolved.rawSnapshots)
      : finishOutput(ctx, subject, spec, resolved, resolved.servedProvider ?? EXA_PROVIDER, gaps);
  return { ...withFreshness(output, exa.freshness), fallback };
}

function fallbackReasonFor(exa: ExaWebOutcome): WebGatherFallbackAudit["fallbackReason"] {
  if (!exa.exaResponded) {
    return "hard-failure";
  }
  return exa.results.length === 0 ? "empty" : "thin";
}

interface ResolvedFirecrawlFallback {
  readonly results: readonly WebGatherProviderResult[];
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly rawRef: string;
  // Omitted when neither provider produced a usable result.
  readonly servedProvider?: string;
  readonly gaps: readonly SourceGap[];
  readonly creditsUsed?: number;
}

// Folds a Firecrawl response into a fallback outcome; usable content becomes the served provider.
// Failure, malformed, or empty preserves the Exa results and adds a provider-tagged gap.
function resolveFirecrawlFallback(
  firecrawlFetch: FetchJsonResult | SourceGap,
  spec: FirecrawlFallbackSpec,
  exa: ExaWebOutcome,
): ResolvedFirecrawlFallback {
  const exaOutcome: ResolvedFirecrawlFallback = {
    results: exa.results,
    rawSnapshots: exa.rawSnapshots,
    rawRef: exa.rawRef,
    ...(exa.results.length > 0 ? { servedProvider: EXA_PROVIDER } : {}),
    gaps: [],
  };
  if (!isFetchJsonResult(firecrawlFetch)) {
    return { ...exaOutcome, gaps: [firecrawlFailureGap(firecrawlFetch)] };
  }
  const rawSnapshots = [...exa.rawSnapshots, firecrawlFetch.rawSnapshot];
  const parsed = spec.parse(firecrawlFetch.payload);
  const { creditsUsed } = parsed;
  const withCredits = creditsUsed !== undefined ? { creditsUsed } : {};
  if (parsed.malformed) {
    return {
      ...exaOutcome,
      rawSnapshots,
      ...withCredits,
      gaps: [
        webGatherGap(spec.firecrawlMalformedMessage, "malformed-response", {
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
        webGatherGap(spec.firecrawlEmptyMessage, "provider-data-missing", {
          source: FIRECRAWL_PROVIDER,
        }),
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

function finishOutput(
  ctx: CollectContext,
  subject: WebGatherSubject,
  spec: FirecrawlFallbackSpec,
  served: {
    readonly results: readonly WebGatherProviderResult[];
    readonly rawSnapshots: readonly RawSourceSnapshot[];
    readonly rawRef: string;
  },
  provider: string,
  gaps: readonly SourceGap[],
): WebGatherToolOutput {
  const output = outputFromResults(
    ctx,
    subject,
    served.results,
    served.rawSnapshots,
    served.rawRef,
    {
      emptyMessage: spec.noUsableMessage(provider === FIRECRAWL_PROVIDER ? "Firecrawl" : "Exa"),
      provider,
    },
  );
  return { ...output, gaps: [...output.gaps, ...gaps] };
}

function withFreshness(
  output: WebGatherToolOutput,
  freshness: WebSearchFreshnessAudit | undefined,
): WebGatherToolOutput {
  return freshness === undefined ? output : { ...output, freshness };
}

function exaFailureGap(gap: SourceGap): SourceGap {
  return sourceGapWithContext(gap, {
    provider: EXA_PROVIDER,
    capability: "web-gather",
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
  parsed: ParsedSearchArgs,
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
