import type { ResearchCommand } from "../cli/args";
import type {
  EvidenceRequestToolName,
  ExtendedEvidenceItem,
  InstrumentIdentity,
  Source,
  SourceGap,
} from "../domain/types";
import { isRecord, readNumber } from "./guards";
import { findSecTicker, secRequestInit } from "./extended-evidence/sec-edgar";
import { encodeQuery, readArray } from "./extended-evidence/utils";
import { tradierRequestInit } from "./tradier";
import {
  isFetchJsonResult,
  type CollectContext,
  type FetchJsonResult,
  type FetchTextResult,
  type RawSourceSnapshot,
} from "./types";

export const EVIDENCE_REQUEST_TOOL_UNITS: Record<EvidenceRequestToolName, number> = {
  sec_latest_filing: 3,
  tradier_iv_term_structure: 5,
};

export interface EvidenceRequestToolOutput {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
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

type TickerResearchCommand = Extract<ResearchCommand, { readonly jobType: "ticker" }>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TRADIER_TARGET_DTES = [7, 30, 60, 90] as const;

export function availableEvidenceRequestTools(
  ctx: CollectContext,
): readonly EvidenceRequestToolName[] {
  if (ctx.command.jobType !== "ticker" || ctx.command.assetClass !== "equity") {
    return [];
  }
  return [
    "sec_latest_filing",
    ...(ctx.tradierApiToken !== undefined ? (["tradier_iv_term_structure"] as const) : []),
  ];
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

function secTextRequestInit(userAgent: string | undefined): RequestInit | undefined {
  return userAgent === undefined ? undefined : { headers: { "user-agent": userAgent } };
}

function readStringArray(record: Record<string, unknown>, key: string): readonly string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function selectLatestPeriodicFiling(payload: unknown): SecFiling | undefined {
  if (!isRecord(payload) || !isRecord(payload.filings) || !isRecord(payload.filings.recent)) {
    return undefined;
  }

  const { recent } = payload.filings;
  const forms = readStringArray(recent, "form");
  const filingDates = readStringArray(recent, "filingDate");
  const reportDates = readStringArray(recent, "reportDate");
  const accessionNumbers = readStringArray(recent, "accessionNumber");
  const primaryDocuments = readStringArray(recent, "primaryDocument");

  return forms
    .flatMap((form, index): SecFiling[] => {
      if (form !== "10-K" && form !== "10-Q") {
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

async function collectSecLatestFiling(ctx: CollectContext): Promise<EvidenceRequestToolOutput> {
  const {
    command,
    fetchedAt,
    sourceTimeoutMs,
    fetchImpl,
    fetchOrGap,
    fetchTextOrGap,
    retryDelaysMs,
  } = ctx;
  if (command.jobType !== "ticker") {
    return emptyOutput([
      { source: "sec-edgar", message: "SEC filing requests require ticker runs" },
    ]);
  }
  const tickersUrl = "https://www.sec.gov/files/company_tickers.json";
  const tickers = await fetchOrGap(
    tickersUrl,
    "sec-tickers",
    fetchedAt,
    sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
    secRequestInit(ctx.secUserAgent),
  );
  if (!isFetchJsonResult(tickers)) {
    return emptyOutput([tickers]);
  }

  const match = findSecTicker(tickers.payload, command.symbol);
  if (match === undefined) {
    return emptyOutput(
      [{ source: "sec-edgar", message: `No SEC CIK match for ${command.symbol}` }],
      [tickers.rawSnapshot],
    );
  }

  const submissionsUrl = `https://data.sec.gov/submissions/CIK${match.cik}.json`;
  const submissions = await fetchOrGap(
    submissionsUrl,
    "sec-submissions",
    fetchedAt,
    sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
    secRequestInit(ctx.secUserAgent),
  );
  if (!isFetchJsonResult(submissions)) {
    return emptyOutput([submissions], [tickers.rawSnapshot]);
  }

  const filing = selectLatestPeriodicFiling(submissions.payload);
  if (filing === undefined) {
    return emptyOutput(
      [{ source: "sec-edgar", message: `No SEC 10-K or 10-Q filing found for ${command.symbol}` }],
      [tickers.rawSnapshot, submissions.rawSnapshot],
    );
  }

  const url = filingUrl(match.cik, filing);
  const filingText = await fetchTextOrGap(
    url,
    "sec-filing-text",
    fetchedAt,
    sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
    secTextRequestInit(ctx.secUserAgent),
  );
  if (!isFetchJsonResult(filingText)) {
    return emptyOutput([filingText], [tickers.rawSnapshot, submissions.rawSnapshot]);
  }

  return secFilingOutput(
    command,
    fetchedAt,
    match,
    filing,
    url,
    [tickers.rawSnapshot, submissions.rawSnapshot, filingText.rawSnapshot],
    filingText,
  );
}

function secFilingOutput(
  command: TickerResearchCommand,
  fetchedAt: string,
  match: { cik: string; ticker: string; name?: string },
  filing: SecFiling,
  url: string,
  rawSnapshots: readonly RawSourceSnapshot[],
  filingText: FetchTextResult,
): EvidenceRequestToolOutput {
  const identity = secIdentity(match);
  const normalized = normalizeFilingText(filingText.payload);
  const excerpt = normalized.slice(0, 6000);
  const title = `${command.symbol} latest SEC ${filing.form}`;
  const source: Source = {
    id: `extended-sec-edgar-${command.symbol.toLowerCase()}-latest-filing`,
    title,
    url,
    fetchedAt,
    kind: "extended-evidence",
    assetClass: command.assetClass,
    symbol: command.symbol,
    provider: "sec-edgar",
    rawRef: filingText.rawSnapshot.id,
    summary: `${filing.form} filed ${filing.filingDate}${filing.reportDate !== undefined ? ` for period ${filing.reportDate}` : ""}.`,
    snippet: excerpt,
    identity,
  };
  const item: ExtendedEvidenceItem = {
    category: "sec-edgar",
    title,
    summary: `${source.summary} Filing excerpt: ${excerpt}`,
    sourceIds: [source.id],
    observedAt: fetchedAt,
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
  return { rawSnapshots, sources: [source], items: [item], gaps: [] };
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
  return Math.max(0, Math.round(diff / MS_PER_DAY));
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
  const { command, fetchedAt, sourceTimeoutMs, fetchImpl, fetchOrGap, retryDelaysMs } = ctx;
  if (command.jobType !== "ticker") {
    return emptyOutput([
      { source: "tradier-options", message: "Tradier IV requests require ticker runs" },
    ]);
  }
  if (ctx.tradierApiToken === undefined) {
    return emptyOutput([
      { source: "tradier-options", message: "MARKET_BOT_TRADIER_API_TOKEN is not set" },
    ]);
  }

  const init = tradierRequestInit(ctx.tradierApiToken);
  const expirationsUrl = `https://api.tradier.com/v1/markets/options/expirations?${encodeQuery({
    symbol: command.symbol,
    includeAllRoots: "true",
  })}`;
  const expirations = await fetchOrGap(
    expirationsUrl,
    "tradier-expirations",
    fetchedAt,
    sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
    init,
  );
  if (!isFetchJsonResult(expirations)) {
    return emptyOutput([expirations]);
  }

  const buckets = nearestExpirationBuckets(expirations.payload, fetchedAt);
  if (buckets.length === 0) {
    return emptyOutput(
      [{ source: "tradier-options", message: "No Tradier option expirations found" }],
      [expirations.rawSnapshot],
    );
  }

  const chainResults = await Promise.all(
    buckets.map(async (bucket) => {
      const url = tradierChainUrl(command.symbol, bucket.expiration);
      return {
        bucket,
        url,
        result: await fetchOrGap(
          url,
          "tradier-options",
          fetchedAt,
          sourceTimeoutMs,
          fetchImpl,
          retryDelaysMs,
          init,
        ),
      };
    }),
  );
  return tradierTermStructureOutput(command, fetchedAt, expirationsUrl, expirations, chainResults);
}

function tradierTermStructureOutput(
  command: TickerResearchCommand,
  fetchedAt: string,
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
          {
            source: "tradier-options",
            message: `No Tradier IV values found for expiration ${entry.bucket.expiration}`,
          },
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
    fetchedAt,
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
    observedAt: fetchedAt,
    metrics,
  };

  return { rawSnapshots, sources: [source], items: [item], gaps };
}
