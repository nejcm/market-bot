import type { InstrumentIdentity } from "../domain/types";

// Yahoo appends an exchange suffix to international symbols (RR.L, RY.TO, ...).
// US listings carry no such suffix; share-class dots like BRK.B are not in this set.
const NON_US_SUFFIXES: ReadonlySet<string> = new Set([
  ".L",
  ".TO",
  ".V",
  ".NE",
  ".PA",
  ".DE",
  ".F",
  ".MI",
  ".AS",
  ".BR",
  ".MC",
  ".ST",
  ".OL",
  ".HE",
  ".CP",
  ".IS",
  ".IR",
  ".SW",
  ".VI",
  ".WA",
  ".HK",
  ".SS",
  ".SZ",
  ".T",
  ".TW",
  ".KS",
  ".KQ",
  ".AX",
  ".NS",
  ".BO",
  ".SG",
  ".JO",
  ".SA",
  ".MX",
  ".BA",
]);

// Known non-US exchange display names/keywords (Yahoo fullExchangeName or short code).
// Matched case-insensitively as a substring. An exchange not matching these is treated
// As US-or-unknown (conservative: attempt fetch) unless a non-US suffix is also present.
const NON_US_EXCHANGE_KEYWORDS: readonly string[] = [
  "london",
  "lse",
  "lon",
  "toronto",
  "tsx",
  "euronext",
  "xetra",
  "frankfurt",
  "borsa",
  "milan",
  "amsterdam",
  "brussels",
  "madrid",
  "stockholm",
  "oslo",
  "helsinki",
  "copenhagen",
  "dublin",
  "irish",
  "swiss",
  "six swiss",
  "vienna",
  "warsaw",
  "hong kong",
  "hkex",
  "shanghai",
  "shenzhen",
  "tokyo",
  "taiwan",
  "korea",
  "kospi",
  "australian",
  "asx",
  "bombay",
  "national stock",
  "singapore",
  "johannesburg",
  "sao paulo",
  "b3",
  "mexican",
  "buenos aires",
];

// Returns true when the instrument is a US listing or cannot be definitively classified
// (conservative: never suppresses an instrument we can't classify). Returns false only
// When a non-US signal is present — a known non-US exchange name or a non-US symbol suffix.
// US-only sources (SEC EDGAR, Tradier IV, Finnhub company/event news) use this to skip
// Instruments they cannot serve and emit an `unsupported-coverage` gap without a fetch.
export function isUsListing(symbol: string, identity?: InstrumentIdentity): boolean {
  const exchange = identity?.exchange;
  if (exchange !== undefined && exchange !== "") {
    const normalized = exchange.toLowerCase();
    if (NON_US_EXCHANGE_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
      return false;
    }
  }
  const upper = symbol.toUpperCase();
  for (const suffix of NON_US_SUFFIXES) {
    if (upper.endsWith(suffix)) {
      return false;
    }
  }
  return true;
}
