import type { ResearchCommand } from "../cli/args";
import type {
  AssetClass,
  ExtendedEvidence,
  ExtendedEvidenceCategory,
  ExtendedEvidenceItem,
  InstrumentIdentity,
  Source,
  SourceGap,
} from "../domain/types";
import {
  isFetchJsonResult,
  type CollectContext,
  type ExtendedEvidenceAdapter,
  type ExtendedEvidenceCollectionResult,
  type RawSourceSnapshot,
} from "./types";
import {
  buildFredMacroMetrics,
  FRED_SERIES,
  fredObservationsUrl,
  isFredBaseMetricKey,
} from "./fred";
import { isRecord, readNumber, readString } from "./guards";
import { selectTradierExpiration, summarizeTradierIv, tradierRequestInit } from "./tradier";

const GLASSNODE_METRICS = [
  "addresses/active_count",
  "transactions/count",
  "transactions/transfers_volume_exchanges_net",
  "market/mvrv",
  "fees/volume_sum",
];

interface CollectedItem {
  readonly item: ExtendedEvidenceItem;
  readonly source: Source;
}

interface ProviderResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly items: readonly CollectedItem[];
  readonly gaps: readonly SourceGap[];
}

type ProviderCollector = (ctx: CollectContext) => Promise<ProviderResult>;

function encodeQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

function daysFrom(fetchedAt: string, days: number): string {
  const date = new Date(fetchedAt);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function secRequestInit(userAgent: string | undefined): RequestInit | undefined {
  return userAgent === undefined
    ? undefined
    : { headers: { accept: "application/json", "user-agent": userAgent } };
}

function evidenceSource(
  id: string,
  title: string,
  provider: string,
  command: ResearchCommand,
  fetchedAt: string,
  url?: string,
  identity?: InstrumentIdentity,
): Source {
  return {
    id,
    title,
    ...(url !== undefined ? { url } : {}),
    fetchedAt,
    kind: "extended-evidence",
    assetClass: command.assetClass,
    ...(command.jobType === "ticker" ? { symbol: command.symbol } : {}),
    provider,
    ...(identity !== undefined ? { identity } : {}),
  };
}

function collectedItem(
  category: ExtendedEvidenceCategory,
  title: string,
  summary: string,
  source: Source,
  metrics?: Record<string, number | string>,
): CollectedItem {
  return {
    source,
    item: {
      category,
      title,
      summary,
      sourceIds: [source.id],
      observedAt: source.fetchedAt,
      ...(metrics !== undefined ? { metrics } : {}),
      ...(source.identity !== undefined ? { identity: source.identity } : {}),
    },
  };
}

function latestNumber(values: readonly unknown[], keys: readonly string[]): number | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (!isRecord(value)) {
      continue;
    }
    for (const key of keys) {
      const n = readNumber(value, key);
      if (n !== undefined) {
        return n;
      }
      const s = readString(value, key);
      if (s !== undefined) {
        const parsed = Number(s);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
  }
  return undefined;
}

function readArray(value: unknown, key: string): readonly unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function findSecTicker(
  payload: unknown,
  symbol: string,
): { cik: string; ticker: string; name?: string } | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const normalizedSymbol = symbol.toUpperCase();
  const entries = Object.values(payload).filter((value) => isRecord(value));
  const match = entries.find(
    (entry) => readString(entry, "ticker")?.toUpperCase() === normalizedSymbol,
  );
  if (match === undefined) {
    return undefined;
  }
  const ticker = readString(match, "ticker")?.trim().toUpperCase();
  const cikNumber = readNumber(match, "cik_str");
  if (ticker === undefined || cikNumber === undefined) {
    return undefined;
  }
  const name = readString(match, "title");
  return {
    cik: String(cikNumber).padStart(10, "0"),
    ticker,
    ...(name !== undefined ? { name } : {}),
  };
}

function summarizeSecFilings(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.filings) || !isRecord(payload.filings.recent)) {
    return undefined;
  }
  const forms = Array.isArray(payload.filings.recent.form) ? payload.filings.recent.form : [];
  const dates = Array.isArray(payload.filings.recent.filingDate)
    ? payload.filings.recent.filingDate
    : [];
  const filings = forms
    .map((form, index) =>
      typeof form === "string" && typeof dates[index] === "string" ? `${form} ${dates[index]}` : "",
    )
    .filter(
      (value) => value.startsWith("10-K ") || value.startsWith("10-Q ") || value.startsWith("8-K "),
    );
  return filings.length > 0 ? `Recent SEC filings: ${filings.slice(0, 5).join(", ")}.` : undefined;
}

function summarizeSecFacts(
  payload: unknown,
): { summary: string; metrics: Record<string, number> } | undefined {
  if (!isRecord(payload) || !isRecord(payload.facts) || !isRecord(payload.facts["us-gaap"])) {
    return undefined;
  }
  const gaap = payload.facts["us-gaap"];
  const keys = {
    revenue: "Revenues",
    netIncome: "NetIncomeLoss",
    cash: "CashAndCashEquivalentsAtCarryingValue",
    debt: "LongTermDebt",
  };
  const metrics: Record<string, number> = {};
  for (const [label, factKey] of Object.entries(keys)) {
    const fact = isRecord(gaap) && isRecord(gaap[factKey]) ? gaap[factKey] : undefined;
    const units = fact !== undefined && isRecord(fact.units) ? fact.units : undefined;
    const usd = units !== undefined ? readArray(units, "USD") : [];
    const value = latestNumber(usd, ["val"]);
    if (value !== undefined) {
      metrics[label] = value;
    }
  }
  const parts = Object.entries(metrics).map(([key, value]) => `${key} ${String(value)}`);
  return parts.length > 0
    ? { summary: `Latest SEC company facts include ${parts.join(", ")}.`, metrics }
    : undefined;
}

async function collectSec(ctx: CollectContext): Promise<ProviderResult> {
  const { command, fetchedAt, sourceTimeoutMs, fetchImpl, fetchOrGap, retryDelaysMs } = ctx;
  if (command.jobType !== "ticker") {
    return { rawSnapshots: [], items: [], gaps: [] };
  }

  const secInit = secRequestInit(ctx.secUserAgent);
  const tickersUrl = "https://www.sec.gov/files/company_tickers.json";
  const tickers = await fetchOrGap(
    tickersUrl,
    "sec-tickers",
    fetchedAt,
    sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
    secInit,
  );
  if (!isFetchJsonResult(tickers)) {
    return { rawSnapshots: [], items: [], gaps: [tickers] };
  }
  const match = findSecTicker(tickers.payload, command.symbol);
  if (match === undefined) {
    return {
      rawSnapshots: [tickers.rawSnapshot],
      items: [],
      gaps: [{ source: "sec-edgar", message: `No SEC CIK match for ${command.symbol}` }],
    };
  }

  const submissionsUrl = `https://data.sec.gov/submissions/CIK${match.cik}.json`;
  const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${match.cik}.json`;
  const identity: InstrumentIdentity = {
    ...(match.name !== undefined ? { displayName: match.name } : {}),
    providerIds: [{ provider: "sec-edgar", idKind: "cik", value: match.cik }],
    aliases: [{ provider: "sec-edgar", idKind: "ticker", value: match.ticker }],
  };
  const [submissions, facts] = await Promise.all([
    fetchOrGap(
      submissionsUrl,
      "sec-submissions",
      fetchedAt,
      sourceTimeoutMs,
      fetchImpl,
      retryDelaysMs,
      secInit,
    ),
    fetchOrGap(
      factsUrl,
      "sec-companyfacts",
      fetchedAt,
      sourceTimeoutMs,
      fetchImpl,
      retryDelaysMs,
      secInit,
    ),
  ]);

  const rawSnapshots = [
    tickers.rawSnapshot,
    ...(isFetchJsonResult(submissions) ? [submissions.rawSnapshot] : []),
    ...(isFetchJsonResult(facts) ? [facts.rawSnapshot] : []),
  ];
  const gaps = [submissions, facts].filter(
    (value): value is SourceGap => !isFetchJsonResult(value),
  );
  const items: CollectedItem[] = [];

  if (isFetchJsonResult(submissions)) {
    const summary = summarizeSecFilings(submissions.payload);
    if (summary !== undefined) {
      const source = evidenceSource(
        `extended-sec-edgar-${command.symbol.toLowerCase()}-filings`,
        `${command.symbol} SEC filings`,
        "sec-edgar",
        command,
        fetchedAt,
        submissionsUrl,
        identity,
      );
      items.push(collectedItem("sec-edgar", source.title, summary, source, { cik: match.cik }));
    }
  }

  if (isFetchJsonResult(facts)) {
    const factsSummary = summarizeSecFacts(facts.payload);
    if (factsSummary !== undefined) {
      const source = evidenceSource(
        `extended-sec-edgar-${command.symbol.toLowerCase()}-facts`,
        `${command.symbol} SEC company facts`,
        "sec-edgar",
        command,
        fetchedAt,
        factsUrl,
        identity,
      );
      items.push(
        collectedItem(
          "sec-edgar",
          source.title,
          factsSummary.summary,
          source,
          factsSummary.metrics,
        ),
      );
    }
  }

  return { rawSnapshots, items, gaps };
}

function summarizeFinnhubEvents(payloads: readonly unknown[]): string | undefined {
  const counts = payloads.map((payload) =>
    Array.isArray(payload) ? payload.length : readArray(payload, "earningsCalendar").length,
  );
  const total = counts.reduce((sum, count) => sum + count, 0);
  return total > 0
    ? `Finnhub returned ${String(total)} recent or upcoming earnings, dividend, and split records.`
    : undefined;
}

async function collectFinnhubEvents(ctx: CollectContext): Promise<ProviderResult> {
  const { command, fetchedAt, sourceTimeoutMs, fetchImpl, fetchOrGap, retryDelaysMs } = ctx;
  if (command.jobType !== "ticker") {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (ctx.finnhubApiToken === undefined) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [{ source: "finnhub-events", message: "MARKET_BOT_FINNHUB_API_TOKEN is not set" }],
    };
  }
  const from = daysFrom(fetchedAt, -90);
  const to = daysFrom(fetchedAt, 90);
  const urls = [
    `https://finnhub.io/api/v1/calendar/earnings?${encodeQuery({ symbol: command.symbol, from, to, token: ctx.finnhubApiToken })}`,
    `https://finnhub.io/api/v1/stock/dividend?${encodeQuery({ symbol: command.symbol, from, to, token: ctx.finnhubApiToken })}`,
    `https://finnhub.io/api/v1/stock/split?${encodeQuery({ symbol: command.symbol, from, to, token: ctx.finnhubApiToken })}`,
  ];
  const results = await Promise.all(
    urls.map((url, index) =>
      fetchOrGap(
        url,
        `finnhub-events-${String(index + 1)}`,
        fetchedAt,
        sourceTimeoutMs,
        fetchImpl,
        retryDelaysMs,
      ),
    ),
  );
  const fetched = results.filter((result) => isFetchJsonResult(result));
  const gaps = results.filter((value): value is SourceGap => !isFetchJsonResult(value));
  const summary = summarizeFinnhubEvents(fetched.map((result) => result.payload));
  const items =
    summary === undefined
      ? []
      : [
          collectedItem(
            "equity-events",
            `${command.symbol} equity events`,
            summary,
            evidenceSource(
              `extended-finnhub-events-${command.symbol.toLowerCase()}`,
              `${command.symbol} equity events`,
              "finnhub",
              command,
              fetchedAt,
            ),
          ),
        ];
  return { rawSnapshots: fetched.map((result) => result.rawSnapshot), items, gaps };
}

async function collectFred(ctx: CollectContext): Promise<ProviderResult> {
  const { command, fetchedAt, sourceTimeoutMs, fetchImpl, fetchOrGap, retryDelaysMs } = ctx;
  if (command.jobType !== "ticker") {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (ctx.fredApiKey === undefined) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [{ source: "fred-macro", message: "MARKET_BOT_FRED_API_KEY is not set" }],
    };
  }
  const { fredApiKey } = ctx;
  const urls = FRED_SERIES.map((seriesId) => fredObservationsUrl(seriesId, fredApiKey, 2));
  const results = await Promise.all(
    urls.map((url, index) =>
      fetchOrGap(
        url,
        `fred-${FRED_SERIES[index]}`,
        fetchedAt,
        sourceTimeoutMs,
        fetchImpl,
        retryDelaysMs,
      ),
    ),
  );
  const fetched = results.filter((result) => isFetchJsonResult(result));
  const gaps = results.filter((value): value is SourceGap => !isFetchJsonResult(value));
  const metrics = buildFredMacroMetrics(
    fetched.map((result) => ({
      seriesId: result.rawSnapshot.adapter.replace("fred-", ""),
      payload: result.payload,
    })),
  );
  const items =
    Object.keys(metrics).length === 0
      ? []
      : [
          collectedItem(
            "fred-macro",
            "FRED macro pack",
            `Latest FRED macro observations captured for ${Object.keys(metrics)
              .filter((key) => isFredBaseMetricKey(key))
              .join(", ")}.`,
            evidenceSource("extended-fred-macro", "FRED macro pack", "fred", command, fetchedAt),
            metrics,
          ),
        ];
  return { rawSnapshots: fetched.map((result) => result.rawSnapshot), items, gaps };
}

async function collectTradierIv(ctx: CollectContext): Promise<ProviderResult> {
  const { command, fetchedAt, sourceTimeoutMs, fetchImpl, fetchOrGap, retryDelaysMs } = ctx;
  if (command.jobType !== "ticker") {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (ctx.tradierApiToken === undefined) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [{ source: "tradier-options", message: "MARKET_BOT_TRADIER_API_TOKEN is not set" }],
    };
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
    return { rawSnapshots: [], items: [], gaps: [expirations] };
  }
  const expiration = selectTradierExpiration(expirations.payload, daysFrom(fetchedAt, 30));
  if (expiration === undefined) {
    return {
      rawSnapshots: [expirations.rawSnapshot],
      items: [],
      gaps: [{ source: "tradier-options", message: "No Tradier option expiration found" }],
    };
  }

  const url = `https://api.tradier.com/v1/markets/options/chains?${encodeQuery({
    symbol: command.symbol,
    expiration,
    greeks: "true",
  })}`;
  const result = await fetchOrGap(
    url,
    "tradier-options",
    fetchedAt,
    sourceTimeoutMs,
    fetchImpl,
    retryDelaysMs,
    init,
  );
  if (!isFetchJsonResult(result)) {
    return { rawSnapshots: [expirations.rawSnapshot], items: [], gaps: [result] };
  }
  const summary = summarizeTradierIv(result.payload);
  const items =
    summary === undefined
      ? []
      : [
          collectedItem(
            "options-iv",
            `${command.symbol} options IV`,
            summary.summary,
            evidenceSource(
              `extended-tradier-iv-${command.symbol.toLowerCase()}`,
              `${command.symbol} options IV`,
              "tradier",
              command,
              fetchedAt,
              url,
            ),
            summary.metrics,
          ),
        ];
  return { rawSnapshots: [expirations.rawSnapshot, result.rawSnapshot], items, gaps: [] };
}

async function collectGlassnode(ctx: CollectContext): Promise<ProviderResult> {
  const { command, fetchedAt, sourceTimeoutMs, fetchImpl, fetchOrGap, retryDelaysMs } = ctx;
  if (command.jobType !== "ticker") {
    return { rawSnapshots: [], items: [], gaps: [] };
  }
  if (ctx.glassnodeApiKey === undefined) {
    return {
      rawSnapshots: [],
      items: [],
      gaps: [{ source: "glassnode-on-chain", message: "MARKET_BOT_GLASSNODE_API_KEY is not set" }],
    };
  }
  const { glassnodeApiKey } = ctx;
  const urls = GLASSNODE_METRICS.map(
    (metric) =>
      `https://api.glassnode.com/v1/metrics/${metric}?${encodeQuery({
        a: command.symbol,
        api_key: glassnodeApiKey,
      })}`,
  );
  const results = await Promise.all(
    urls.map((url, index) =>
      fetchOrGap(
        url,
        `glassnode-${String(index + 1)}`,
        fetchedAt,
        sourceTimeoutMs,
        fetchImpl,
        retryDelaysMs,
      ),
    ),
  );
  const fetched = results.filter((result) => isFetchJsonResult(result));
  const gaps = results.filter((value): value is SourceGap => !isFetchJsonResult(value));
  const metrics: Record<string, number> = {};
  for (const [index, result] of results.entries()) {
    if (isFetchJsonResult(result)) {
      const value = latestNumber(Array.isArray(result.payload) ? result.payload : [], ["v"]);
      if (value !== undefined) {
        metrics[GLASSNODE_METRICS[index]?.replaceAll("/", ".") ?? `metric${String(index)}`] = value;
      }
    }
  }
  const items =
    Object.keys(metrics).length === 0
      ? []
      : [
          collectedItem(
            "on-chain",
            `${command.symbol} on-chain metrics`,
            `Glassnode on-chain observations captured for ${Object.keys(metrics).join(", ")}.`,
            evidenceSource(
              `extended-glassnode-${command.symbol.toLowerCase()}`,
              `${command.symbol} on-chain metrics`,
              "glassnode",
              command,
              fetchedAt,
            ),
            metrics,
          ),
        ];
  return { rawSnapshots: fetched.map((result) => result.rawSnapshot), items, gaps };
}

async function collectExtendedEvidence(
  ctx: CollectContext,
  assetClass: AssetClass,
  providers: readonly ProviderCollector[],
): Promise<ExtendedEvidenceCollectionResult> {
  if (ctx.command.jobType !== "ticker") {
    return { rawSnapshots: [], sources: [], sourceGaps: [] };
  }

  const providerResults = await Promise.all(providers.map((provider) => provider(ctx)));
  const collectedItems = providerResults.flatMap((result) => result.items);
  const gaps = providerResults.flatMap((result) => result.gaps);
  const extendedEvidence: ExtendedEvidence = {
    instrument: { symbol: ctx.command.symbol, assetClass },
    items: collectedItems.map((item) => item.item),
    gaps,
  };
  return {
    rawSnapshots: providerResults.flatMap((result) => result.rawSnapshots),
    sources: collectedItems.map((item) => item.source),
    extendedEvidence,
    sourceGaps: gaps,
  };
}

export const equityExtendedEvidenceAdapter: ExtendedEvidenceAdapter = {
  name: "extended-evidence-equity",
  collect: (ctx) =>
    collectExtendedEvidence(ctx, "equity", [
      collectSec,
      collectFinnhubEvents,
      collectFred,
      collectTradierIv,
    ]),
};

export const cryptoExtendedEvidenceAdapter: ExtendedEvidenceAdapter = {
  name: "extended-evidence-crypto",
  collect: (ctx) => collectExtendedEvidence(ctx, "crypto", [collectFred, collectGlassnode]),
};
