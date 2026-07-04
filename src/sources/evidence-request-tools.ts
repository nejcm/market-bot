import { isInstrumentCommand, type InstrumentCommand } from "../cli/args";
import { DAY_MS } from "../config/shared";
import type {
  EvidenceRequestToolName,
  ExtendedEvidenceItem,
  InstrumentIdentity,
  Source,
  SourceGap,
} from "../domain/types";
import { sourceGap } from "../domain/source-gaps";
import { isRecord, readNumber, stringArrayValue } from "./guards";
import { isUsListing } from "./instrument-capability";
import { findSecTicker, secRequestInit } from "./extended-evidence/sec-edgar";
import { encodeQuery, readArray } from "./extended-evidence/utils";
import { tradierRequestInit } from "./tradier";
import {
  aggregateModelInputSanitization,
  droppedModelInputItemEntry,
  sanitizeModelInputField,
  type ModelInputSanitizationAggregate,
  type ModelInputSanitizationAggregateEntry,
} from "./model-input-sanitizer";
import {
  isFetchJsonResult,
  isFetchTextResult,
  latestRawSnapshotFetchedAt,
  type CollectContext,
  type FetchJsonResult,
  type FetchTextResult,
  type RawSourceSnapshot,
} from "./types";

export const EVIDENCE_REQUEST_TOOL_UNITS: Record<EvidenceRequestToolName, number> = {
  sec_latest_filing: 5,
  tradier_iv_term_structure: 5,
};

export interface EvidenceRequestToolOutput {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
  readonly modelInputSanitization?: ModelInputSanitizationAggregate;
}

interface SecFiling {
  readonly form: "10-K" | "10-Q";
  readonly filingDate: string;
  readonly reportDate?: string;
  readonly accessionNumber: string;
  readonly primaryDocument: string;
}

interface TradierBucket {
  readonly targetDte: number;
  readonly expiration: string;
  readonly dte: number;
}

interface TradierBucketIv extends TradierBucket {
  readonly medianIv: number;
}

const TRADIER_TARGET_DTES = [7, 30, 60, 90] as const;
const SEC_FILING_SUMMARY_EXCERPT_CHARS = 1200;
const SEC_PACKET_MIN_CHARS = 50;
const SEC_SECTION_MIN_ALPHA_CHARS = 40;

export function availableEvidenceRequestTools(
  ctx: CollectContext,
  identity?: InstrumentIdentity,
): readonly EvidenceRequestToolName[] {
  if (!isInstrumentCommand(ctx.command) || ctx.command.assetClass !== "equity") {
    return [];
  }
  if (!isUsListing(ctx.command.symbol, identity)) {
    return [];
  }
  // SEC latest filing is retrieved deterministically (see runEvidenceRequestLoop);
  // Only optional tools remain at model discretion.
  return ctx.tradierApiToken !== undefined ? ["tradier_iv_term_structure"] : [];
}

export async function executeEvidenceRequestTool(
  tool: EvidenceRequestToolName,
  ctx: CollectContext,
): Promise<EvidenceRequestToolOutput> {
  if (tool === "sec_latest_filing") {
    return collectSecLatestFiling(ctx);
  }
  return collectTradierIvTermStructure(ctx);
}

function emptyOutput(
  gaps: readonly SourceGap[],
  rawSnapshots: readonly RawSourceSnapshot[] = [],
): EvidenceRequestToolOutput {
  return { rawSnapshots, sources: [], items: [], gaps };
}

function unsupportedInstrumentGap(source: string, provider: string, symbol: string): SourceGap {
  return sourceGap({
    source,
    message: `${provider} does not support ${symbol} (non-US listing)`,
    provider,
    capability: "evidence-request",
    cause: "unsupported-coverage",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function secPacketGap(symbol: string, form: SecFiling["form"]): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `SEC ${form} section packet for ${symbol} is malformed or too short to extract`,
    provider: "sec-edgar",
    capability: "evidence-request",
    cause: "malformed-response",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function secSanitizationGap(symbol: string, droppedItemCount: number): SourceGap {
  return sourceGap({
    source: "sec-edgar",
    message: `SEC filing sanitization dropped ${String(droppedItemCount)} item(s) for ${symbol}`,
    provider: "sec-edgar",
    capability: "evidence-request",
    cause: "validation-failed",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}

function secTextRequestInit(userAgent: string | undefined): RequestInit | undefined {
  return userAgent === undefined ? undefined : { headers: { "user-agent": userAgent } };
}

function selectLatestFilingByForm(
  payload: unknown,
  form: SecFiling["form"],
): SecFiling | undefined {
  if (!isRecord(payload) || !isRecord(payload.filings) || !isRecord(payload.filings.recent)) {
    return undefined;
  }

  const { recent } = payload.filings;
  const forms = stringArrayValue(recent.form);
  const filingDates = stringArrayValue(recent.filingDate);
  const reportDates = stringArrayValue(recent.reportDate);
  const accessionNumbers = stringArrayValue(recent.accessionNumber);
  const primaryDocuments = stringArrayValue(recent.primaryDocument);

  return forms
    .flatMap((f, index): SecFiling[] => {
      if (f !== form) {
        return [];
      }
      const filingDate = filingDates[index];
      const accessionNumber = accessionNumbers[index];
      const primaryDocument = primaryDocuments[index];
      if (
        filingDate === undefined ||
        accessionNumber === undefined ||
        primaryDocument === undefined
      ) {
        return [];
      }
      const reportDate = reportDates[index];
      return [
        {
          form,
          filingDate,
          ...(reportDate !== undefined ? { reportDate } : {}),
          accessionNumber,
          primaryDocument,
        },
      ];
    })
    .toSorted((a, b) => b.filingDate.localeCompare(a.filingDate))[0];
}

function filingBasisDate(filing: SecFiling): string {
  return filing.reportDate ?? filing.filingDate;
}

function selectCurrentQuarterlyFiling(payload: unknown, annual?: SecFiling): SecFiling | undefined {
  const latestQuarterly = selectLatestFilingByForm(payload, "10-Q");
  if (latestQuarterly === undefined || annual === undefined) {
    return latestQuarterly;
  }
  return filingBasisDate(latestQuarterly) > filingBasisDate(annual) ? latestQuarterly : undefined;
}

function filingUrl(cik: string, filing: SecFiling): string {
  const primaryDocument = encodeURIComponent(filing.primaryDocument);
  return `https://www.sec.gov/Archives/edgar/data/${String(Number(cik))}/${filing.accessionNumber.replaceAll("-", "")}/${primaryDocument}`;
}

function decodeCodePoint(value: string, radix: number): string {
  const codePoint = Number.parseInt(value, radix);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 1_114_111
    ? String.fromCodePoint(codePoint)
    : " ";
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll(/&#(\d+);/gu, (_, code: string) => decodeCodePoint(code, 10))
    .replaceAll(/&#x([\da-f]+);/giu, (_, code: string) => decodeCodePoint(code, 16));
}

export function normalizeFilingText(payload: string): string {
  return decodeHtmlEntities(
    payload
      .replaceAll(/<ix:hidden[\s\S]*?<\/ix:hidden>/giu, " ")
      .replaceAll(/<ix:header[\s\S]*?<\/ix:header>/giu, " ")
      .replaceAll(/<script[\s\S]*?<\/script>/giu, " ")
      .replaceAll(/<style[\s\S]*?<\/style>/giu, " ")
      .replaceAll(/<[^>]+>/gu, " "),
  )
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function secIdentity(match: { cik: string; ticker: string; name?: string }): InstrumentIdentity {
  return {
    ...(match.name !== undefined ? { displayName: match.name } : {}),
    providerIds: [{ provider: "sec-edgar", idKind: "cik", value: match.cik }],
    aliases: [{ provider: "sec-edgar", idKind: "ticker", value: match.ticker }],
  };
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const trimmed = value.slice(0, maxChars).trimEnd();
  return `${trimmed}...`;
}

// Per-section char budgets for the bounded SEC section packet. The sum bounds
// The total text projected to the model for profile extraction.
const SEC_SECTION_BUDGETS = {
  business: 2000,
  riskFactors: 1500,
  mdna: 3000,
  segments: 1000,
  notes: 500,
} as const;

// Extracts a bounded slice of `text` starting at `start`, stopping at the next
// ITEM header (to avoid bleeding into the following section) or `maxChars`.
function boundedSection(text: string, start: number, maxChars: number): string {
  const afterStart = text.slice(start);
  const nextItem = /ITEM\s+\d+[A-Z]?\b[.\u2010-\u2015:-]/iu.exec(afterStart.slice(1));
  const endOffset = nextItem !== null ? 1 + nextItem.index : afterStart.length;
  return truncateText(afterStart.slice(0, Math.min(endOffset, maxChars)), maxChars);
}

function substantiveAlphaCount(value: string): number {
  return [...value.matchAll(/\p{L}/gu)].length;
}

function selectSection(text: string, pattern: RegExp, maxChars: number): string | undefined {
  const matches = [...text.matchAll(pattern)];
  return matches
    .map((match) => boundedSection(text, match.index ?? 0, maxChars))
    .filter((section) => substantiveAlphaCount(section) >= SEC_SECTION_MIN_ALPHA_CHARS)
    .toSorted((a, b) => b.length - a.length)[0];
}

// Builds a deterministic bounded section packet from a normalized SEC HTML filing.
function secFilingSectionPacket(normalized: string, form: SecFiling["form"]): string | undefined {
  if (normalized.length < SEC_PACKET_MIN_CHARS) {
    return undefined;
  }
  const parts: string[] = [];
  const business = selectSection(
    normalized,
    /ITEM\s+1\b[.\u2010-\u2015:-]?\s*BUSINESS/giu,
    SEC_SECTION_BUDGETS.business,
  );
  if (business !== undefined) {
    parts.push(`[Business] ${business}`);
  }
  const riskFactors = selectSection(
    normalized,
    /ITEM\s+1A\b[.\u2010-\u2015:-]?\s*RISK\s+FACTORS/giu,
    SEC_SECTION_BUDGETS.riskFactors,
  );
  if (riskFactors !== undefined) {
    parts.push(`[Risk Factors] ${riskFactors}`);
  }
  const mdnaPattern =
    form === "10-K"
      ? /ITEM\s+7\b[.\u2010-\u2015:-]?\s*MANAGEMENT/giu
      : /ITEM\s+2\b[.\u2010-\u2015:-]?\s*MANAGEMENT/giu;
  const mdna = selectSection(normalized, mdnaPattern, SEC_SECTION_BUDGETS.mdna);
  if (mdna !== undefined) {
    parts.push(`[MD&A] ${mdna}`);
  }
  const segments = selectSection(
    normalized,
    /SEGMENT\s+(INFORMATION|REPORTING|DATA|RESULTS|REVENUE)|GEOGRAPH(IC|IES|Y)\s+(REVENUE|SALES|DISCLOSURE|INFORMATION|DATA|BREAKDOWN)/giu,
    SEC_SECTION_BUDGETS.segments,
  );
  if (segments !== undefined) {
    parts.push(`[Segments] ${segments}`);
  }
  const notes = selectSection(
    normalized,
    /NOTES?\s+TO\s+(CONSOLIDATED\s+)?FINANCIAL\s+STATEMENTS/giu,
    SEC_SECTION_BUDGETS.notes,
  );
  if (notes !== undefined) {
    parts.push(`[Notes] ${notes}`);
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n\n");
}

type SecFilingSourceItem =
  | {
      readonly kind: "built";
      readonly source: Source;
      readonly item: ExtendedEvidenceItem;
      readonly sanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
    }
  | {
      readonly kind: "dropped";
      readonly sanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
    }
  | { readonly kind: "missing" };

function buildSecFilingSourceItem(
  command: InstrumentCommand,
  match: { cik: string; ticker: string; name?: string },
  filing: SecFiling,
  url: string,
  filingText: FetchTextResult,
): SecFilingSourceItem {
  const formKey = filing.form === "10-K" ? "10k" : "10q";
  const normalized = normalizeFilingText(filingText.payload);
  const packet = secFilingSectionPacket(normalized, filing.form);
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
    summary: `${filing.form} filed ${filing.filingDate}${filing.reportDate !== undefined ? ` for period ${filing.reportDate}` : ""}.`,
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
  };
}

async function fetchFilingText(
  ctx: CollectContext,
  filing: SecFiling,
  cik: string,
): Promise<{ result: FetchTextResult | SourceGap; url: string }> {
  const url = filingUrl(cik, filing);
  const result = await ctx.request.text({
    url,
    adapter: "sec-filing-text",
    init: secTextRequestInit(ctx.secUserAgent),
  });
  return { result, url };
}

async function collectSecFiling(
  ctx: CollectContext,
  command: InstrumentCommand,
  match: { cik: string; ticker: string; name?: string },
  filing: SecFiling,
): Promise<{
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
  readonly sanitizationEntries: readonly ModelInputSanitizationAggregateEntry[];
  readonly droppedItemCount: number;
}> {
  const { result, url } = await fetchFilingText(ctx, filing, match.cik);
  if (!isFetchTextResult(result)) {
    return {
      rawSnapshots: [],
      sources: [],
      items: [],
      gaps: [result],
      sanitizationEntries: [],
      droppedItemCount: 0,
    };
  }
  const built = buildSecFilingSourceItem(command, match, filing, url, result);
  if (built.kind === "missing") {
    return {
      rawSnapshots: [result.rawSnapshot],
      sources: [],
      items: [],
      gaps: [secPacketGap(command.symbol, filing.form)],
      sanitizationEntries: [],
      droppedItemCount: 0,
    };
  }
  if (built.kind === "dropped") {
    return {
      rawSnapshots: [result.rawSnapshot],
      sources: [],
      items: [],
      gaps: [],
      sanitizationEntries: built.sanitizationEntries,
      droppedItemCount: 1,
    };
  }
  return {
    rawSnapshots: [result.rawSnapshot],
    sources: [built.source],
    items: [built.item],
    gaps: [],
    sanitizationEntries: built.sanitizationEntries,
    droppedItemCount: 0,
  };
}

async function collectSecLatestFiling(ctx: CollectContext): Promise<EvidenceRequestToolOutput> {
  const { command } = ctx;
  if (!isInstrumentCommand(command)) {
    return emptyOutput([
      sourceGap({
        source: "sec-edgar",
        message: "SEC filing requests require ticker runs",
        provider: "sec-edgar",
        capability: "evidence-request",
        cause: "unsupported-coverage",
        evidenceQualityImpact: "extended-evidence-cap",
      }),
    ]);
  }
  if (!isUsListing(command.symbol, ctx.instrumentIdentity)) {
    return emptyOutput([unsupportedInstrumentGap("sec-edgar", "SEC EDGAR", command.symbol)]);
  }
  const tickersUrl = "https://www.sec.gov/files/company_tickers.json";
  const tickers = await ctx.request.json({
    url: tickersUrl,
    adapter: "sec-tickers",
    init: secRequestInit(ctx.secUserAgent),
  });
  if (!isFetchJsonResult(tickers)) {
    return emptyOutput([tickers]);
  }

  const match = findSecTicker(tickers.payload, command.symbol);
  if (match === undefined) {
    return emptyOutput(
      [
        sourceGap({
          source: "sec-edgar",
          message: `No SEC CIK match for ${command.symbol}`,
          provider: "sec-edgar",
          capability: "evidence-request",
          cause: "unsupported-coverage",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
      [tickers.rawSnapshot],
    );
  }

  const submissionsUrl = `https://data.sec.gov/submissions/CIK${match.cik}.json`;
  const submissions = await ctx.request.json({
    url: submissionsUrl,
    adapter: "sec-submissions",
    init: secRequestInit(ctx.secUserAgent),
  });
  if (!isFetchJsonResult(submissions)) {
    return emptyOutput([submissions], [tickers.rawSnapshot]);
  }

  const tenK = selectLatestFilingByForm(submissions.payload, "10-K");
  const tenQ = selectCurrentQuarterlyFiling(submissions.payload, tenK);

  if (tenK === undefined && tenQ === undefined) {
    return emptyOutput(
      [
        sourceGap({
          source: "sec-edgar",
          message: `No SEC 10-K or 10-Q filing found for ${command.symbol}`,
          provider: "sec-edgar",
          capability: "evidence-request",
          cause: "provider-data-missing",
          evidenceQualityImpact: "core-cap",
        }),
      ],
      [tickers.rawSnapshot, submissions.rawSnapshot],
    );
  }

  const sharedRawSnapshots: readonly RawSourceSnapshot[] = [
    tickers.rawSnapshot,
    submissions.rawSnapshot,
  ];
  const sources: Source[] = [];
  const items: ExtendedEvidenceItem[] = [];
  const gaps: SourceGap[] = [];
  const rawSnapshots: RawSourceSnapshot[] = [...sharedRawSnapshots];
  const sanitizationEntries: ModelInputSanitizationAggregateEntry[] = [];
  let droppedItemCount = 0;

  const filingResults = await Promise.all(
    [tenK, tenQ].flatMap((filing) =>
      filing === undefined ? [] : [collectSecFiling(ctx, command, match, filing)],
    ),
  );
  for (const result of filingResults) {
    rawSnapshots.push(...result.rawSnapshots);
    sources.push(...result.sources);
    items.push(...result.items);
    gaps.push(...result.gaps);
    sanitizationEntries.push(...result.sanitizationEntries);
    droppedItemCount += result.droppedItemCount;
  }
  // When the latest 10-K is present but metadata lists no 10-Q after it, quarterly coverage is not-applicable (not a missing gap): the issuer has not filed an interim report since its annual.
  // A missing annual 10-K is an explicit core-cap gap even when a 10-Q exists.
  if (tenK === undefined && tenQ !== undefined) {
    gaps.push(
      sourceGap({
        source: "sec-edgar",
        message: `No SEC 10-K filing found for ${command.symbol}; only quarterly 10-Q available`,
        provider: "sec-edgar",
        capability: "evidence-request",
        cause: "provider-data-missing",
        evidenceQualityImpact: "core-cap",
      }),
    );
  }
  if (droppedItemCount > 0) {
    gaps.push(secSanitizationGap(command.symbol, droppedItemCount));
  }

  return {
    rawSnapshots,
    sources,
    items,
    gaps,
    modelInputSanitization: aggregateModelInputSanitization(sanitizationEntries),
  };
}

function readTradierExpirations(payload: unknown): readonly string[] {
  const expirations = isRecord(payload) ? payload.expirations : undefined;
  return readArray(expirations, "date")
    .filter((date): date is string => typeof date === "string")
    .toSorted();
}

function dteFrom(fetchedAt: string, expiration: string): number | undefined {
  const diff = new Date(`${expiration}T00:00:00.000Z`).getTime() - new Date(fetchedAt).getTime();
  if (!Number.isFinite(diff)) {
    return undefined;
  }
  return Math.max(0, Math.round(diff / DAY_MS));
}

function nearestExpirationBuckets(payload: unknown, fetchedAt: string): readonly TradierBucket[] {
  const expirations = readTradierExpirations(payload);
  const used = new Set<string>();
  return TRADIER_TARGET_DTES.flatMap((targetDte) => {
    const candidates = expirations
      .map((expiration) => {
        const dte = dteFrom(fetchedAt, expiration);
        return dte === undefined ? undefined : { expiration, dte };
      })
      .filter(
        (candidate): candidate is { expiration: string; dte: number } => candidate !== undefined,
      )
      .filter((candidate) => !used.has(candidate.expiration))
      .toSorted((a, b) => Math.abs(a.dte - targetDte) - Math.abs(b.dte - targetDte));
    const [selected] = candidates;
    if (selected === undefined) {
      return [];
    }
    used.add(selected.expiration);
    return [{ targetDte, expiration: selected.expiration, dte: selected.dte }];
  });
}

function readTradierIvValues(payload: unknown): readonly number[] {
  const options =
    isRecord(payload) && isRecord(payload.options) ? readArray(payload.options, "option") : [];
  return options
    .filter((option) => isRecord(option))
    .map((option) => {
      const greeks = isRecord(option.greeks) ? option.greeks : undefined;
      return greeks !== undefined
        ? (readNumber(greeks, "mid_iv") ?? readNumber(greeks, "iv"))
        : undefined;
    })
    .filter((value): value is number => value !== undefined)
    .toSorted((a, b) => a - b);
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? ((values[mid - 1] as number) + (values[mid] as number)) / 2
    : (values[mid] as number);
}

function tradierChainUrl(symbol: string, expiration: string): string {
  return `https://api.tradier.com/v1/markets/options/chains?${encodeQuery({
    symbol,
    expiration,
    greeks: "true",
  })}`;
}

async function collectTradierIvTermStructure(
  ctx: CollectContext,
): Promise<EvidenceRequestToolOutput> {
  const { command } = ctx;
  if (!isInstrumentCommand(command)) {
    return emptyOutput([
      sourceGap({
        source: "tradier-options",
        message: "Tradier IV requests require ticker runs",
        provider: "tradier",
        capability: "evidence-request",
        cause: "unsupported-coverage",
        evidenceQualityImpact: "extended-evidence-cap",
      }),
    ]);
  }
  if (!isUsListing(command.symbol, ctx.instrumentIdentity)) {
    return emptyOutput([unsupportedInstrumentGap("tradier-options", "Tradier", command.symbol)]);
  }
  if (ctx.tradierApiToken === undefined) {
    return emptyOutput([
      sourceGap({
        source: "tradier-options",
        message: "MARKET_BOT_TRADIER_API_TOKEN is not set",
        provider: "tradier",
        capability: "evidence-request",
        cause: "missing-credential",
        evidenceQualityImpact: "extended-evidence-cap",
      }),
    ]);
  }

  const init = tradierRequestInit(ctx.tradierApiToken);
  const expirationsUrl = `https://api.tradier.com/v1/markets/options/expirations?${encodeQuery({
    symbol: command.symbol,
    includeAllRoots: "true",
  })}`;
  const expirations = await ctx.request.json({
    url: expirationsUrl,
    adapter: "tradier-expirations",
    init,
  });
  if (!isFetchJsonResult(expirations)) {
    return emptyOutput([expirations]);
  }

  const buckets = nearestExpirationBuckets(expirations.payload, expirations.rawSnapshot.fetchedAt);
  if (buckets.length === 0) {
    return emptyOutput(
      [
        sourceGap({
          source: "tradier-options",
          message: "No Tradier option expirations found",
          provider: "tradier",
          capability: "evidence-request",
          cause: "provider-data-missing",
          evidenceQualityImpact: "extended-evidence-cap",
        }),
      ],
      [expirations.rawSnapshot],
    );
  }

  const chainResults = await Promise.all(
    buckets.map(async (bucket) => {
      const url = tradierChainUrl(command.symbol, bucket.expiration);
      return {
        bucket,
        url,
        result: await ctx.request.json({
          url,
          adapter: "tradier-options",
          init,
        }),
      };
    }),
  );
  return tradierTermStructureOutput(command, expirationsUrl, expirations, chainResults);
}

function tradierTermStructureOutput(
  command: InstrumentCommand,
  expirationsUrl: string,
  expirations: FetchJsonResult,
  chainResults: readonly {
    readonly bucket: TradierBucket;
    readonly url: string;
    readonly result: FetchJsonResult | SourceGap;
  }[],
): EvidenceRequestToolOutput {
  const rawSnapshots = [
    expirations.rawSnapshot,
    ...chainResults.flatMap((entry) =>
      isFetchJsonResult(entry.result) ? [entry.result.rawSnapshot] : [],
    ),
  ];
  const gaps: SourceGap[] = chainResults.flatMap((entry) => {
    if (!isFetchJsonResult(entry.result)) {
      return [entry.result];
    }
    return median(readTradierIvValues(entry.result.payload)) === undefined
      ? [
          sourceGap({
            source: "tradier-options",
            message: `No Tradier IV values found for expiration ${entry.bucket.expiration}`,
            provider: "tradier",
            capability: "evidence-request",
            cause: "provider-data-missing",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ]
      : [];
  });
  const bucketIvs: readonly TradierBucketIv[] = chainResults.flatMap((entry) => {
    if (!isFetchJsonResult(entry.result)) {
      return [];
    }
    const medianIv = median(readTradierIvValues(entry.result.payload));
    return medianIv === undefined ? [] : [{ ...entry.bucket, medianIv }];
  });

  if (bucketIvs.length === 0) {
    return { rawSnapshots, sources: [], items: [], gaps };
  }
  const outputFetchedAt = latestRawSnapshotFetchedAt(
    chainResults.flatMap((entry) =>
      isFetchJsonResult(entry.result) ? [entry.result.rawSnapshot] : [],
    ),
    expirations.rawSnapshot.fetchedAt,
  );

  const metrics: Record<string, number | string> = {};
  for (const bucket of bucketIvs) {
    metrics[`medianIv${String(bucket.targetDte)}Dte`] = bucket.medianIv;
    metrics[`expiration${String(bucket.targetDte)}Dte`] = bucket.expiration;
    metrics[`actualDte${String(bucket.targetDte)}Dte`] = bucket.dte;
  }
  const byTarget = new Map(bucketIvs.map((bucket) => [bucket.targetDte, bucket.medianIv]));
  const iv7 = byTarget.get(7);
  const iv30 = byTarget.get(30);
  const iv60 = byTarget.get(60);
  const iv90 = byTarget.get(90);
  if (iv7 !== undefined && iv30 !== undefined) {
    metrics.iv30Minus7 = iv30 - iv7;
  }
  if (iv30 !== undefined && iv60 !== undefined) {
    metrics.iv60Minus30 = iv60 - iv30;
  }
  if (iv30 !== undefined && iv90 !== undefined) {
    metrics.iv90Minus30 = iv90 - iv30;
  }

  const summary = [
    "Tradier IV term structure:",
    bucketIvs
      .map(
        (bucket) =>
          `${String(bucket.targetDte)}D ${bucket.medianIv.toFixed(3)} (${bucket.expiration})`,
      )
      .join(", "),
    iv7 !== undefined && iv30 !== undefined ? `30D-7D slope ${(iv30 - iv7).toFixed(3)}.` : "",
    iv30 !== undefined && iv90 !== undefined ? `90D-30D slope ${(iv90 - iv30).toFixed(3)}.` : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
  const rawRef = rawSnapshots.at(-1)?.id;
  const source: Source = {
    id: `extended-tradier-iv-term-${command.symbol.toLowerCase()}`,
    title: `${command.symbol} IV term structure`,
    url: expirationsUrl,
    fetchedAt: outputFetchedAt,
    kind: "extended-evidence",
    assetClass: command.assetClass,
    symbol: command.symbol,
    provider: "tradier",
    ...(rawRef !== undefined ? { rawRef } : {}),
    summary,
  };
  const item: ExtendedEvidenceItem = {
    category: "options-iv",
    title: `${command.symbol} IV term structure`,
    summary,
    sourceIds: [source.id],
    observedAt: outputFetchedAt,
    metrics,
  };

  return { rawSnapshots, sources: [source], items: [item], gaps };
}
