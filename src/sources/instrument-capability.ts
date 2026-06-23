import type { InstrumentIdentity } from "../domain/types";

// Single source of truth for US-vs-international equity classification. Two consumers with
// Deliberately different risk postures share these tables:
//   - isUsListing (capability gate): conservative. Suppresses a US-only source only on a
//     Positive non-US signal; never suppresses an instrument it cannot classify.
//   - isInternationalIdentity (run-health validation): aggressive. Prefers to over-count
//     International coverage; an exchange that is not a known US venue counts as international.

// Yahoo appends an exchange suffix to international symbols (RR.L, RY.TO, ...). US listings
// Carry no such suffix; share-class dots like BRK.B are not in this set. Bare suffix codes
// (no leading dot), matched against the symbol's trailing ".<CODE>".
const NON_US_SUFFIXES: ReadonlySet<string> = new Set([
  "AS",
  "AX",
  "BA",
  "BO",
  "BR",
  "CO",
  "CP",
  "DE",
  "F",
  "HE",
  "HK",
  "IR",
  "IS",
  "JO",
  "KQ",
  "KS",
  "L",
  "MC",
  "MI",
  "MX",
  "NE",
  "NS",
  "NZ",
  "OL",
  "PA",
  "SA",
  "SG",
  "SI",
  "SS",
  "ST",
  "SW",
  "SZ",
  "T",
  "TA",
  "TO",
  "TW",
  "V",
  "VI",
  "VX",
  "WA",
]);

// Known US equity exchanges (normalized to uppercase letters only). An identity carrying one
// Of these is positively US; an exchange not in this set is "not positively US".
const US_EQUITY_EXCHANGES: ReadonlySet<string> = new Set([
  "AMEX",
  "BATS",
  "CBOE",
  "NASDAQ",
  "NASDAQCM",
  "NASDAQGM",
  "NASDAQGS",
  "NYSE",
  "NYSEAMERICAN",
  "NYSEARCA",
]);

// Non-US exchange display-name keywords (Yahoo fullExchangeName or short code), matched
// Case-insensitively as a substring. Used by the conservative capability gate as a positive
// Non-US signal when neither a quote currency nor a recognizable suffix is available.
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

function exchangeKey(exchange: string): string {
  return exchange.toUpperCase().replaceAll(/[^A-Z]/gu, "");
}

function instrumentSuffix(symbol: string): string | undefined {
  return symbol.toUpperCase().match(/\.([A-Z]{1,4})$/u)?.[1];
}

// Returns true when the symbol carries a known non-US Yahoo-style exchange suffix.
export function hasNonUsSuffix(symbol: string): boolean {
  const suffix = instrumentSuffix(symbol);
  return suffix !== undefined && NON_US_SUFFIXES.has(suffix);
}

function hasNonUsExchangeName(exchange: string | undefined): boolean {
  if (exchange === undefined || exchange === "") {
    return false;
  }
  const normalized = exchange.toLowerCase();
  return NON_US_EXCHANGE_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function hasNonUsdQuoteCurrency(quoteCurrency: string | undefined): boolean {
  return (
    quoteCurrency !== undefined && quoteCurrency !== "" && quoteCurrency.toUpperCase() !== "USD"
  );
}

// Aggressive (run-health validation): an identity is international when it quotes in a non-USD
// Currency or sits on an exchange that is not a known US venue. For an unrecognized exchange this
// Returns true — the opposite posture to isUsListing's conservative default.
export function isInternationalIdentity(identity: InstrumentIdentity | undefined): boolean {
  if (hasNonUsdQuoteCurrency(identity?.quoteCurrency)) {
    return true;
  }
  if (identity?.exchange === undefined || identity.exchange === "") {
    return false;
  }
  return !US_EQUITY_EXCHANGES.has(exchangeKey(identity.exchange));
}

// Conservative (capability gate): returns true when the instrument is a US listing or cannot be
// Definitively classified (never suppresses an instrument we can't classify). Returns false only
// On a positive non-US signal — a non-USD quote currency, a known non-US exchange name, or a
// Non-US symbol suffix. Quote currency is the primary signal; exchange name and suffix are
// Fallbacks. US-only sources (SEC EDGAR, Tradier IV, Finnhub company/event news) use this to skip
// Instruments they cannot serve and emit an `unsupported-coverage` gap without a fetch.
export function isUsListing(symbol: string, identity?: InstrumentIdentity): boolean {
  if (hasNonUsdQuoteCurrency(identity?.quoteCurrency)) {
    return false;
  }
  if (hasNonUsExchangeName(identity?.exchange)) {
    return false;
  }
  if (hasNonUsSuffix(symbol)) {
    return false;
  }
  return true;
}
