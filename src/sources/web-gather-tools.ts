import { createHash } from "node:crypto";
import { isInstrumentCommand } from "../cli/args";
import type {
  AssetClass,
  ExtendedEvidenceItem,
  Source,
  SourceGap,
  SubjectKind,
  WebGatherSanitizerAudit,
  WebGatherToolName,
} from "../domain/types";
import { sourceGap, sourceGapWithContext } from "../domain/source-gaps";
import { isRecord, optionalString, readString, stringArrayValue } from "./guards";
import { canonicalizeUrl, encodeQuery } from "./news-utils";
import {
  isFetchJsonResult,
  type CollectContext,
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
export const MAX_WEB_GATHER_SEARCH_RESULTS = 8;
const MAX_TEXT_CHARS = 5000;
const MAX_SNIPPET_CHARS = 1200;
const MAX_SUMMARY_CHARS = 1200;
const ZERO_SANITIZER_AUDIT: WebGatherSanitizerAudit = {
  sourceCount: 0,
  sanitizedSourceCount: 0,
  emptyAfterSanitizeCount: 0,
  inputCharCount: 0,
  outputCharCount: 0,
  removedInstructionSpanCount: 0,
  removedChromeHtmlCount: 0,
};

interface ExaResult {
  readonly id?: string;
  readonly url: string;
  readonly title?: string;
  readonly publishedDate?: string;
  readonly author?: string;
  readonly text?: string;
  readonly summary?: string;
  readonly highlights: readonly string[];
}

interface ExaResultsParse {
  readonly results: readonly ExaResult[];
  readonly malformed: boolean;
}

interface SanitizedExaSource {
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
  source = EXA_PROVIDER,
): SourceGap {
  return sourceGap({
    source,
    message,
    provider: EXA_PROVIDER,
    capability: "evidence-request",
    cause,
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
): { readonly query: string; readonly numResults: number } | SourceGap {
  if (!isRecord(args)) {
    return webGatherGap("web_search args must be an object", "validation-failed");
  }
  const query = readString(args, "query");
  if (query === undefined) {
    return webGatherGap("web_search requires a non-empty query", "validation-failed");
  }
  const requested = readPositiveInteger(args.numResults);
  return {
    query,
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

  const body = {
    query: parsed.query,
    type: "auto",
    numResults: parsed.numResults,
    contents: {
      text: { maxCharacters: MAX_TEXT_CHARS },
      summary: { query: parsed.query },
      highlights: { numSentences: 2, highlightsPerUrl: 2, query: parsed.query },
    },
  };
  const fetched = await ctx.request.json({
    url: `${EXA_API_URL}/search?${encodeQuery({
      query: parsed.query,
      numResults: String(parsed.numResults),
    })}`,
    adapter: EXA_SEARCH_ADAPTER,
    init: exaRequestInit(apiKey, body),
    fetch: exaEndpointFetch,
  });
  if (!isFetchJsonResult(fetched)) {
    return emptyOutput([exaFailureGap(fetched)]);
  }

  const { results, malformed } = readExaResults(fetched.payload);
  if (malformed) {
    return emptyOutput(
      [webGatherGap("Exa search response was malformed", "malformed-response")],
      [fetched.rawSnapshot],
    );
  }
  rememberSurfacedUrls(results, surfacedUrls);
  return outputFromResults(ctx, subject, results, [fetched.rawSnapshot], fetched.rawSnapshot.id, {
    emptyMessage: `Exa returned no usable web search results for "${parsed.query}"`,
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
    return emptyOutput([exaFailureGap(fetched)]);
  }
  const { results, malformed } = readExaResults(fetched.payload);
  if (malformed) {
    return emptyOutput(
      [webGatherGap("Exa contents response was malformed", "malformed-response")],
      [fetched.rawSnapshot],
    );
  }

  return outputFromResults(ctx, subject, results, [fetched.rawSnapshot], fetched.rawSnapshot.id, {
    emptyMessage: `Exa returned no usable fetched content for ${parsed.url}`,
  });
}

function exaFailureGap(gap: SourceGap): SourceGap {
  return sourceGapWithContext(gap, {
    provider: EXA_PROVIDER,
    capability: "evidence-request",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function readExaResults(payload: unknown): ExaResultsParse {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return { results: [], malformed: true };
  }
  const results = payload.results.flatMap((value): ExaResult[] => {
    if (!isRecord(value)) {
      return [];
    }
    const url = readString(value, "url");
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

function rememberSurfacedUrls(results: readonly ExaResult[], surfacedUrls: Set<string>): void {
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
  results: readonly ExaResult[],
  rawSnapshots: readonly RawSourceSnapshot[],
  rawRef: string,
  options: { readonly emptyMessage: string },
): WebGatherToolOutput {
  const sanitizedSources = results.map((result) =>
    exaSource(subject, ctx.fetchedAt, result, rawRef),
  );
  const sources = sanitizedSources.map((result) => result.source);
  if (sources.length === 0) {
    return emptyOutput([webGatherGap(options.emptyMessage, "provider-data-missing")], rawSnapshots);
  }
  const gaps = sanitizedSources
    .filter((result) => result.emptyAfterSanitize)
    .map((result) =>
      webGatherGap(
        `Exa result text was empty after sanitization for ${result.source.url ?? result.source.id}`,
        "provider-data-missing",
        "web-gather",
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

function exaSource(
  subject: WebGatherSubject,
  fallbackFetchedAt: string,
  result: ExaResult,
  rawRef: string,
): SanitizedExaSource {
  const canonicalUrl = canonicalizeUrl(result.url);
  const fetchedAt = result.publishedDate ?? fallbackFetchedAt;
  const summary = sanitizeOptionalWebText(result.summary, MAX_SUMMARY_CHARS);
  const snippet = sanitizeOptionalWebText(webSnippetText(result), MAX_SNIPPET_CHARS);
  const source: Source = {
    id: webSourceId(subject.subjectId, canonicalUrl ?? result.url),
    title: result.title ?? result.url,
    url: result.url,
    ...(result.author !== undefined ? { publisher: result.author } : {}),
    fetchedAt,
    kind: "web",
    ...(subject.assetClass !== undefined ? { assetClass: subject.assetClass } : {}),
    ...(subject.symbol !== undefined ? { symbol: subject.symbol } : {}),
    provider: EXA_PROVIDER,
    ...(result.id !== undefined ? { providerArticleId: result.id } : {}),
    ...(canonicalUrl !== undefined ? { canonicalUrl } : {}),
    rawRef,
    ...(summary.text !== undefined ? { summary: summary.text } : {}),
    ...(snippet.text !== undefined ? { snippet: snippet.text } : {}),
  };
  const hadModelVisibleInput = summary.inputPresent || snippet.inputPresent;
  return {
    source,
    sanitizer: {
      sourceCount: 1,
      sanitizedSourceCount: hadModelVisibleInput ? 1 : 0,
      emptyAfterSanitizeCount:
        hadModelVisibleInput && summary.text === undefined && snippet.text === undefined ? 1 : 0,
      inputCharCount: summary.telemetry.inputCharCount + snippet.telemetry.inputCharCount,
      outputCharCount: summary.telemetry.outputCharCount + snippet.telemetry.outputCharCount,
      removedInstructionSpanCount:
        summary.telemetry.removedInstructionSpanCount +
        snippet.telemetry.removedInstructionSpanCount,
      removedChromeHtmlCount:
        summary.telemetry.removedChromeHtmlCount + snippet.telemetry.removedChromeHtmlCount,
    },
    emptyAfterSanitize:
      hadModelVisibleInput && summary.text === undefined && snippet.text === undefined,
  };
}

function webSnippetText(result: ExaResult): string | undefined {
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
      outputCharCount: text?.length ?? 0,
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
