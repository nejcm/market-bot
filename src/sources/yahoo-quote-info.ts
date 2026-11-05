import { isRecord, optionalString, readNumber, readString } from "../guards";

const OTC_EXCHANGE_CODES = new Set([
  "GREY",
  "OTC",
  "OTCBB",
  "OTCQB",
  "OTCQX",
  "PINX",
  "PINK",
  "PNK",
]);
const OTC_EXCHANGE_NAMES = new Set(["OTHER OTC", "OTC MARKETS", "OTCBB", "PINK SHEETS"]);

export interface YahooQuoteInfo {
  readonly symbol: string;
  readonly name?: string;
  readonly exchange?: string;
  readonly fullExchangeName?: string;
  readonly quoteType?: string;
  readonly currency?: string;
  readonly price?: number;
  readonly volume?: number;
  readonly marketCap?: number;
}

export function readYahooQuoteResults(payload: unknown): readonly unknown[] {
  if (!isRecord(payload) || !isRecord(payload.quoteResponse)) {
    return [];
  }

  return Array.isArray(payload.quoteResponse.result) ? payload.quoteResponse.result : [];
}

function isOtcExchange(value: string | undefined): boolean {
  const normalized = value?.trim().toUpperCase();
  return (
    normalized !== undefined &&
    (OTC_EXCHANGE_CODES.has(normalized) || OTC_EXCHANGE_NAMES.has(normalized))
  );
}

// Reads a v7 quote row or a v1 search `quotes` row; search spells names and exchange lowercase.
export function readQuoteInfo(value: unknown): YahooQuoteInfo | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const symbol = readString(value, "symbol")?.trim().toUpperCase();
  if (symbol === undefined) {
    return undefined;
  }
  const name =
    optionalString(value, "shortName") ??
    optionalString(value, "longName") ??
    optionalString(value, "shortname") ??
    optionalString(value, "longname");
  const exchange = optionalString(value, "exchange");
  const fullExchangeName =
    optionalString(value, "fullExchangeName") ?? optionalString(value, "exchDisp");
  const quoteType = optionalString(value, "quoteType")?.trim().toUpperCase();
  const currency = optionalString(value, "currency")?.trim().toUpperCase();
  const price = readNumber(value, "regularMarketPrice");
  const volume = readNumber(value, "regularMarketVolume");
  const marketCap = readNumber(value, "marketCap");

  return {
    symbol,
    ...(name !== undefined ? { name } : {}),
    ...(exchange !== undefined ? { exchange } : {}),
    ...(fullExchangeName !== undefined ? { fullExchangeName } : {}),
    ...(quoteType !== undefined ? { quoteType } : {}),
    ...(currency !== undefined && currency !== "" ? { currency } : {}),
    ...(price !== undefined ? { price } : {}),
    ...(volume !== undefined ? { volume } : {}),
    ...(marketCap !== undefined ? { marketCap } : {}),
  };
}

// The listed-stock check alpha-search and the identity gate share; returns the rejection reason.
export function listedStockRejection(quote: YahooQuoteInfo): string | undefined {
  if (quote.quoteType !== "EQUITY") {
    return "Yahoo quote type is not listed stock";
  }
  if (isOtcExchange(quote.exchange) || isOtcExchange(quote.fullExchangeName)) {
    return "OTC or pink-sheet instrument";
  }
  if (quote.exchange === undefined) {
    return "Yahoo quote is missing listed exchange";
  }
  return undefined;
}
