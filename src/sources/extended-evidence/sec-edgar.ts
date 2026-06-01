import type { InstrumentIdentity, SourceGap } from "../../domain/types";
import { isRecord, readNumber, readString } from "../guards";
import { isFetchJsonResult, type CollectContext } from "../types";
import { collectedItem, evidenceSource, type ProviderResult } from "./common";
import { latestNumber, readArray } from "./utils";

function secRequestInit(userAgent: string | undefined): RequestInit | undefined {
  return userAgent === undefined
    ? undefined
    : { headers: { accept: "application/json", "user-agent": userAgent } };
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

export async function collectSec(ctx: CollectContext): Promise<ProviderResult> {
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
  const items = [];

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
