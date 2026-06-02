import type { SourceGap } from "../domain/types";
import { isRecord, optionalString, readNumber, readString } from "../sources/guards";
import { yahooQuoteSourceRequest } from "../sources/yahoo";
import {
  isFetchJsonResult,
  type RawSourceSnapshot,
  type SourceRequestExecutor,
} from "../sources/types";
import type { RedditRankedCandidate } from "./reddit-ranking";

const VALID_QUOTE_TYPES = new Set(["EQUITY", "ETF"]);
const MINIMUM_ALLOWED_PRICE = 1;

export type YahooInstrumentKind = "stock" | "etf";

export interface YahooValidatedLead {
  readonly candidate: RedditRankedCandidate;
  readonly symbol: string;
  readonly name?: string;
  readonly exchange?: string;
  readonly price: number;
  readonly volume: number;
  readonly marketCap?: number;
  readonly instrumentKind: YahooInstrumentKind;
}

export interface YahooRejectedCandidate {
  readonly candidate: RedditRankedCandidate;
  readonly reason: string;
}

export interface YahooCandidateValidation {
  readonly validLeads: readonly YahooValidatedLead[];
  readonly rejectedCandidates: readonly YahooRejectedCandidate[];
}

export interface YahooCandidateValidationResult extends YahooCandidateValidation {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sourceGaps: readonly SourceGap[];
}

interface YahooQuoteInfo {
  readonly symbol: string;
  readonly name?: string;
  readonly exchange?: string;
  readonly fullExchangeName?: string;
  readonly quoteType?: string;
  readonly price?: number;
  readonly volume?: number;
  readonly marketCap?: number;
}

interface ValidatedYahooQuoteInfo extends YahooQuoteInfo {
  readonly price: number;
  readonly volume: number;
}

type YahooQuoteValidation =
  | {
      readonly status: "valid";
      readonly quote: ValidatedYahooQuoteInfo;
      readonly instrumentKind: YahooInstrumentKind;
    }
  | {
      readonly status: "rejected";
      readonly reason: string;
    };

function readYahooQuoteResults(payload: unknown): readonly unknown[] {
  if (!isRecord(payload) || !isRecord(payload.quoteResponse)) {
    return [];
  }

  return Array.isArray(payload.quoteResponse.result) ? payload.quoteResponse.result : [];
}

function normalizeQuoteType(value: string | undefined): string | undefined {
  return value?.trim().toUpperCase();
}

function instrumentKind(quoteType: string | undefined): YahooInstrumentKind | undefined {
  if (quoteType === "EQUITY") {
    return "stock";
  }
  if (quoteType === "ETF") {
    return "etf";
  }
  return undefined;
}

function isOtcExchange(value: string | undefined): boolean {
  const normalized = value?.trim().toUpperCase();
  return (
    normalized !== undefined &&
    (normalized === "PNK" || normalized.includes("OTC") || normalized.includes("PINK"))
  );
}

function readQuoteInfo(value: unknown): YahooQuoteInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const symbol = readString(value, "symbol")?.trim().toUpperCase();
  if (symbol === undefined) {
    return undefined;
  }
  const name = optionalString(value, "shortName") ?? optionalString(value, "longName");
  const exchange = optionalString(value, "exchange");
  const fullExchangeName = optionalString(value, "fullExchangeName");
  const quoteType = normalizeQuoteType(optionalString(value, "quoteType"));
  const price = readNumber(value, "regularMarketPrice");
  const volume = readNumber(value, "regularMarketVolume");
  const marketCap = readNumber(value, "marketCap");

  return {
    symbol,
    ...(name !== undefined ? { name } : {}),
    ...(exchange !== undefined ? { exchange } : {}),
    ...(fullExchangeName !== undefined ? { fullExchangeName } : {}),
    ...(quoteType !== undefined ? { quoteType } : {}),
    ...(price !== undefined ? { price } : {}),
    ...(volume !== undefined ? { volume } : {}),
    ...(marketCap !== undefined ? { marketCap } : {}),
  };
}

function validateQuoteInfo(quote: YahooQuoteInfo): YahooQuoteValidation {
  const kind = instrumentKind(quote.quoteType);
  if (!VALID_QUOTE_TYPES.has(quote.quoteType ?? "") || kind === undefined) {
    return { status: "rejected", reason: "Yahoo quote type is not stock or ETF" };
  }
  if (isOtcExchange(quote.exchange) || isOtcExchange(quote.fullExchangeName)) {
    return { status: "rejected", reason: "OTC or pink-sheet instrument" };
  }
  if (quote.price === undefined || quote.volume === undefined) {
    return { status: "rejected", reason: "Yahoo quote is missing price or volume" };
  }
  if (quote.price < MINIMUM_ALLOWED_PRICE) {
    return { status: "rejected", reason: "Yahoo price is below $1" };
  }
  return {
    status: "valid",
    quote: { ...quote, price: quote.price, volume: quote.volume },
    instrumentKind: kind,
  };
}

function validatedLead(
  candidate: RedditRankedCandidate,
  quote: ValidatedYahooQuoteInfo,
  yahooInstrumentKind: YahooInstrumentKind,
): YahooValidatedLead {
  return {
    candidate,
    symbol: quote.symbol,
    ...(quote.name !== undefined ? { name: quote.name } : {}),
    ...(quote.exchange !== undefined ? { exchange: quote.exchange } : {}),
    price: quote.price,
    volume: quote.volume,
    ...(quote.marketCap !== undefined ? { marketCap: quote.marketCap } : {}),
    instrumentKind: yahooInstrumentKind,
  };
}

export function validateYahooCandidateQuotes(
  candidates: readonly RedditRankedCandidate[],
  payload: unknown,
): YahooCandidateValidation {
  const quotesBySymbol = new Map(
    readYahooQuoteResults(payload)
      .flatMap((value) => {
        const quote = readQuoteInfo(value);
        return quote === undefined ? [] : [quote];
      })
      .map((quote) => [quote.symbol, quote]),
  );

  return candidates.reduce<YahooCandidateValidation>(
    (result, candidate) => {
      const quote = quotesBySymbol.get(candidate.symbol);
      if (quote === undefined) {
        return {
          validLeads: result.validLeads,
          rejectedCandidates: [
            ...result.rejectedCandidates,
            { candidate, reason: "unresolved by Yahoo" },
          ],
        };
      }

      const validation = validateQuoteInfo(quote);
      if (validation.status === "rejected") {
        return {
          validLeads: result.validLeads,
          rejectedCandidates: [
            ...result.rejectedCandidates,
            { candidate, reason: validation.reason },
          ],
        };
      }

      return {
        validLeads: [
          ...result.validLeads,
          validatedLead(candidate, validation.quote, validation.instrumentKind),
        ],
        rejectedCandidates: result.rejectedCandidates,
      };
    },
    { validLeads: [], rejectedCandidates: [] },
  );
}

export async function crossCheckRedditCandidatesWithYahoo(input: {
  readonly candidates: readonly RedditRankedCandidate[];
  readonly candidateLimit: number;
  readonly request: SourceRequestExecutor;
}): Promise<YahooCandidateValidationResult> {
  const candidates = input.candidates.slice(0, Math.max(0, input.candidateLimit));
  if (candidates.length === 0) {
    return { rawSnapshots: [], validLeads: [], rejectedCandidates: [], sourceGaps: [] };
  }

  const fetched = await input.request.json(
    yahooQuoteSourceRequest(
      candidates.map((candidate) => candidate.symbol),
      "yahoo-alpha-search",
    ),
  );
  if (!isFetchJsonResult(fetched)) {
    return { rawSnapshots: [], validLeads: [], rejectedCandidates: [], sourceGaps: [fetched] };
  }

  return {
    rawSnapshots: [fetched.rawSnapshot],
    sourceGaps: [],
    ...validateYahooCandidateQuotes(candidates, fetched.payload),
  };
}
