import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../../cli/args";
import type { ExtendedEvidenceItem, MarketFundamentals, MarketSnapshot } from "../../domain/types";

// Derives the `yahoo-fundamentals` ExtendedEvidenceItem from the normalized
// MarketSnapshot.fundamentals (captured once in normalizeYahooQuote), not from
// The raw payload. This makes the item immune to the Massive quote fallback,
// Which replaces the Yahoo payload with a non-Yahoo shape carrying none of these
// Fields — in that case snapshot.fundamentals is absent and no item is produced.
// See ADR 0033.

function tickerSnapshot(
  command: InstrumentCommand,
  marketSnapshots: readonly MarketSnapshot[],
): MarketSnapshot | undefined {
  const symbol = command.symbol.toUpperCase();
  return marketSnapshots.find(
    (snapshot) =>
      snapshot.assetClass === command.assetClass && snapshot.symbol.toUpperCase() === symbol,
  );
}

function formatRatio(value: number | undefined): string {
  return value === undefined ? "" : `${value.toFixed(2)}x`;
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "" : `${value.toFixed(2)}%`;
}

function summarize(fundamentals: MarketFundamentals): string {
  const parts: string[] = [];
  const pe = formatRatio(fundamentals.trailingPE);
  if (pe !== "") {
    parts.push(`trailing PE ${pe}`);
  }
  const forwardPe = formatRatio(fundamentals.forwardPE);
  if (forwardPe !== "") {
    parts.push(`forward PE ${forwardPe}`);
  }
  const pbv = formatRatio(fundamentals.priceToBook);
  if (pbv !== "") {
    parts.push(`price/book ${pbv}`);
  }
  // Dividend yield is whole-percent (verified against captured fixtures).
  const yieldText = formatPercent(fundamentals.dividendYield);
  if (yieldText !== "") {
    parts.push(`dividend yield ${yieldText}`);
  }
  if (fundamentals.epsTrailingTwelveMonths !== undefined) {
    parts.push(`EPS TTM ${fundamentals.epsTrailingTwelveMonths.toFixed(2)}`);
  }
  if (fundamentals.epsForward !== undefined) {
    parts.push(`forward EPS ${fundamentals.epsForward.toFixed(2)}`);
  }
  if (fundamentals.trailingAnnualDividendRate !== undefined) {
    parts.push(`annual dividend rate ${fundamentals.trailingAnnualDividendRate.toFixed(3)}`);
  }
  return parts.length > 0 ? `Yahoo Fundamentals: ${parts.join(", ")}.` : "Yahoo Fundamentals.";
}

export function buildYahooFundamentals(
  command: ResearchCommand,
  marketSnapshots: readonly MarketSnapshot[],
  fetchedAt: string,
): ExtendedEvidenceItem | undefined {
  if (!isInstrumentCommand(command) || command.assetClass !== "equity") {
    return undefined;
  }
  const snapshot = tickerSnapshot(command, marketSnapshots);
  const fundamentals = snapshot?.fundamentals;
  if (snapshot === undefined || fundamentals === undefined) {
    return undefined;
  }
  const metrics: Record<string, number | string> = {};
  if (fundamentals.trailingPE !== undefined) {
    metrics.trailingPE = fundamentals.trailingPE;
  }
  if (fundamentals.forwardPE !== undefined) {
    metrics.forwardPE = fundamentals.forwardPE;
  }
  if (fundamentals.priceToBook !== undefined) {
    metrics.priceToBook = fundamentals.priceToBook;
  }
  if (fundamentals.bookValue !== undefined) {
    metrics.bookValue = fundamentals.bookValue;
  }
  if (fundamentals.dividendYield !== undefined) {
    metrics.dividendYield = fundamentals.dividendYield;
  }
  if (fundamentals.epsTrailingTwelveMonths !== undefined) {
    metrics.epsTrailingTwelveMonths = fundamentals.epsTrailingTwelveMonths;
  }
  if (fundamentals.epsForward !== undefined) {
    metrics.epsForward = fundamentals.epsForward;
  }
  if (fundamentals.sharesOutstanding !== undefined) {
    metrics.sharesOutstanding = fundamentals.sharesOutstanding;
  }
  if (fundamentals.trailingAnnualDividendRate !== undefined) {
    metrics.trailingAnnualDividendRate = fundamentals.trailingAnnualDividendRate;
  }
  return {
    category: "yahoo-fundamentals",
    title: `${command.symbol} Yahoo Fundamentals Evidence`,
    summary: summarize(fundamentals),
    sourceIds: [snapshot.sourceId],
    observedAt: snapshot.observedAt ?? fetchedAt,
    metrics,
    ...(snapshot.identity !== undefined ? { identity: snapshot.identity } : {}),
  };
}
