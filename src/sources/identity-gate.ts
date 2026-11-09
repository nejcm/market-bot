import {
  isInstrumentCommand,
  type InstrumentCommand,
  type ResearchCommand,
} from "../cli/job-registry";
import { exchangeProfileFor } from "../domain/exchange-profile";
import type { InstrumentIdentity } from "../domain/instrument";
import { sourceGap } from "../domain/source-gaps";
import type { SourceGap } from "../domain/sources";
import { hasNonUsSuffix, isUsListing } from "./instrument-capability";
import { isFetchJsonResult, type CollectContext, type MarketCollectionResult } from "./types";
import {
  listedStockRejection,
  readQuoteInfo,
  readYahooQuoteResults,
  type YahooQuoteInfo,
} from "./yahoo-quote-info";

const YAHOO_SYMBOL_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search";
const MAX_LISTED_CANDIDATES = 8;

export interface ListingCandidate {
  readonly symbol: string;
  readonly name?: string;
  readonly exchange?: string;
}

export type IdentityGateStopReason =
  | "unresolved"
  | "ambiguous"
  | "missing-web-credential"
  | "web-gather-disabled";

// Thrown before any model stage, so a stopped run spends no model tokens.
export class IdentityGateStopError extends Error {
  readonly reason: IdentityGateStopReason;
  readonly inputSymbol: string;
  readonly candidates: readonly ListingCandidate[];

  constructor(
    reason: IdentityGateStopReason,
    inputSymbol: string,
    detail: string,
    candidates: readonly ListingCandidate[] = [],
  ) {
    super(
      `Identity gate stopped ${inputSymbol} before any model stage: ${detail}${candidates.length === 0 ? "" : `. Candidates: ${candidates.map((candidate) => candidateLabel(candidate)).join("; ")}`}`,
    );
    this.name = "IdentityGateStopError";
    this.reason = reason;
    this.inputSymbol = inputSymbol;
    this.candidates = candidates;
  }
}

export type IdentityGateResult =
  | { readonly status: "resolved"; readonly identity?: InstrumentIdentity }
  | { readonly status: "redirect"; readonly symbol: string; readonly candidate: ListingCandidate };

function candidateLabel(candidate: ListingCandidate): string {
  return [candidate.symbol, candidate.name, candidate.exchange]
    .filter((part) => part !== undefined)
    .join(" ");
}

function suffixOf(symbol: string): string | undefined {
  return symbol.match(/\.([A-Z]{1,4})$/u)?.[1];
}

function matchKey(value: string): string {
  return value.toUpperCase().replaceAll(/[^A-Z0-9]/gu, "");
}

// Exact on the local code, the full name, or the name's first word ("ViTrox Corporation Berhad").
function isExactMatch(candidate: ListingCandidate, query: string): boolean {
  const key = matchKey(query);
  const base = candidate.symbol.replace(/\.[A-Z]{1,4}$/u, "");
  const name = candidate.name ?? "";
  return (
    matchKey(base) === key ||
    matchKey(name) === key ||
    matchKey(name.split(/\s+/u)[0] ?? "") === key
  );
}

function toCandidate(quote: YahooQuoteInfo): ListingCandidate {
  return {
    symbol: quote.symbol,
    ...(quote.name === undefined ? {} : { name: quote.name }),
    ...((quote.fullExchangeName ?? quote.exchange)
      ? { exchange: quote.fullExchangeName ?? quote.exchange }
      : {}),
  };
}

function tickerQuote(market: MarketCollectionResult, symbol: string): YahooQuoteInfo | undefined {
  return market.rawSnapshots
    .filter((snapshot) => snapshot.adapter === "yahoo-ticker")
    .flatMap((snapshot) => readYahooQuoteResults(snapshot.payload))
    .map((value) => readQuoteInfo(value))
    .find((quote) => quote?.symbol === symbol);
}

function identityFromQuote(quote: YahooQuoteInfo): InstrumentIdentity {
  const exchange = quote.fullExchangeName ?? quote.exchange;
  return {
    ...(exchange === undefined ? {} : { exchange }),
    ...(quote.currency === undefined ? {} : { quoteCurrency: quote.currency }),
    ...(quote.name === undefined ? {} : { displayName: quote.name }),
  };
}

function searchCandidates(payload: unknown, suffix: string | undefined): readonly YahooQuoteInfo[] {
  const quotes =
    typeof payload === "object" && payload !== null && Array.isArray(Reflect.get(payload, "quotes"))
      ? (Reflect.get(payload, "quotes") as readonly unknown[])
      : [];
  return quotes
    .map((value) => readQuoteInfo(value))
    .filter(
      (quote): quote is YahooQuoteInfo =>
        quote !== undefined &&
        listedStockRejection(quote) === undefined &&
        (suffix === undefined || suffixOf(quote.symbol) === suffix),
    );
}

function requireWebCredential(
  ctx: CollectContext,
  symbol: string,
  identity: InstrumentIdentity | undefined,
): void {
  if (isUsListing(symbol, identity)) {
    return;
  }
  if (ctx.webGatherDisabled === true) {
    throw new IdentityGateStopError(
      "web-gather-disabled",
      symbol,
      "a non-SEC issuer is researched from web and issuer sources, and MARKET_BOT_WEB_GATHER_DISABLE is set",
    );
  }
  if (ctx.exaApiKey === undefined) {
    throw new IdentityGateStopError(
      "missing-web-credential",
      symbol,
      "a non-SEC issuer is researched from web and issuer sources, and MARKET_BOT_EXA_API_KEY is not set",
    );
  }
}

async function resolveBySearch(
  ctx: CollectContext,
  symbol: string,
): Promise<IdentityGateResult | undefined> {
  const suffix = hasNonUsSuffix(symbol) ? suffixOf(symbol) : undefined;
  const query = suffix === undefined ? symbol : symbol.slice(0, -(suffix.length + 1));
  const url = `${YAHOO_SYMBOL_SEARCH_URL}?${new URLSearchParams({ q: query, quotesCount: "10", newsCount: "0" }).toString()}`;
  const fetched = await ctx.request.json({ url, adapter: "yahoo-symbol-search" });
  if (!isFetchJsonResult(fetched)) {
    // Yahoo unreachable: a US-looking symbol keeps today's path, where the missing quote has its own gap.
    if (!hasNonUsSuffix(symbol)) {
      return undefined;
    }
    throw new IdentityGateStopError(
      "unresolved",
      symbol,
      `the Yahoo quote did not resolve and Yahoo search failed (${fetched.message})`,
    );
  }
  const listed = searchCandidates(fetched.payload, suffix);
  const same = listed.find((quote) => quote.symbol === symbol);
  if (same !== undefined) {
    return { status: "resolved", identity: identityFromQuote(same) };
  }
  const exact = listed
    .map((quote) => toCandidate(quote))
    .filter((candidate) => isExactMatch(candidate, query));
  if (exact.length === 1) {
    return { status: "redirect", symbol: exact[0]!.symbol, candidate: exact[0]! };
  }
  if (exact.length > 1) {
    throw new IdentityGateStopError(
      "ambiguous",
      symbol,
      `Yahoo search matched ${String(exact.length)} listings exactly; rerun with one code`,
      exact.slice(0, MAX_LISTED_CANDIDATES),
    );
  }
  throw new IdentityGateStopError(
    "unresolved",
    symbol,
    "no Yahoo quote and no single exact Yahoo search match",
    listed.slice(0, MAX_LISTED_CANDIDATES).map((quote) => toCandidate(quote)),
  );
}

// Decisions 2–3 (ADR 0006): resolve the listing before any model stage, or stop.
export async function runIdentityGate(
  ctx: CollectContext,
  command: InstrumentCommand,
  market: MarketCollectionResult,
): Promise<IdentityGateResult> {
  const symbol = command.symbol.toUpperCase();
  const snapshot = market.marketSnapshots.find((candidate) => candidate.symbol === symbol);
  if (snapshot !== undefined) {
    requireWebCredential(ctx, symbol, snapshot.identity);
    return { status: "resolved" };
  }
  const quote = tickerQuote(market, symbol);
  if (quote?.quoteType !== undefined && quote.quoteType !== "NONE") {
    const identity = identityFromQuote(quote);
    requireWebCredential(ctx, symbol, identity);
    return { status: "resolved", identity };
  }
  const resolved = await resolveBySearch(ctx, symbol);
  if (resolved?.status === "resolved") {
    requireWebCredential(ctx, symbol, resolved.identity);
  }
  return resolved ?? { status: "resolved" };
}

export function listingCommand(
  command: ResearchCommand,
  resolution: { readonly symbol: string } | undefined,
): ResearchCommand {
  return resolution === undefined ||
    !isInstrumentCommand(command) ||
    command.symbol === resolution.symbol
    ? command
    : { ...command, symbol: resolution.symbol };
}

export function exchangeProfileGaps(
  symbol: string,
  identity: InstrumentIdentity | undefined,
): readonly SourceGap[] {
  if (isUsListing(symbol, identity)) {
    return [];
  }
  const profile = exchangeProfileFor(symbol);
  if (profile !== undefined) {
    const quoteCurrency = identity?.quoteCurrency?.toUpperCase();
    return quoteCurrency === undefined || quoteCurrency === profile.currency
      ? []
      : [
          sourceGap({
            source: "exchange-profile",
            symbol,
            message: `Quote currency ${quoteCurrency} differs from the ${profile.exchange} trading currency ${profile.currency}: prices stay in ${quoteCurrency} and issuer report figures in their reported currency, and the two are not compared`,
            capability: "market-data",
            cause: "validation-failed",
            evidenceQualityImpact: "no-cap",
          }),
        ];
  }
  return [
    sourceGap({
      source: "exchange-profile",
      symbol,
      message: `No Exchange Profile for ${identity?.exchange ?? symbol}: market regime, the Event Grid relative event, and final-synthesis relative benchmark guidance use US proxies (SPY, QQQ, IWM, DIA, VIX) instead of a local benchmark`,
      capability: "market-data",
      cause: "unsupported-coverage",
      evidenceQualityImpact: "no-cap",
    }),
  ];
}

export const NON_SEC_COVERAGE_LABEL = "non-SEC issuer: web and issuer sources";

// Equity runs on a non-US listing take the non-SEC path (ADR 0006).
export function isNonSecEquityListing(
  command: ResearchCommand,
  identity: InstrumentIdentity | undefined,
): boolean {
  return (
    isInstrumentCommand(command) &&
    command.assetClass === "equity" &&
    !isUsListing(command.symbol, identity)
  );
}
