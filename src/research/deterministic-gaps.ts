import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import { dedupeSourceGaps, sourceGapScopedReportText } from "../domain/source-gaps";
import { marketUpdateHorizonOf, type SourceGapEvidenceQualityImpact } from "../domain/types";
import type { CollectedSources } from "../sources/types";
import { missingVerifiedSnapshotGapText } from "./verified-snapshot-contract";

// Deterministic source gaps — disclosed in the prompt and in the final report.

function normalizedSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export const EQUITY_MARKET_OVERVIEW_MOVER_UNIVERSE_GAP =
  "Market overview mover universe is seeded from Yahoo day_gainers, day_losers, and most_actives — a single-day multi-screener set, not a trailing horizon mover screener";

export interface DataGapEntry {
  readonly text: string;
  readonly impact?: SourceGapEvidenceQualityImpact;
}

function deterministicGapEntry(text: string): DataGapEntry {
  return { text };
}

export function deterministicSourceGapEntries(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): readonly DataGapEntry[] {
  const gaps = dedupeSourceGaps(collectedSources.sourceGaps).map((gap) => ({
    text: sourceGapScopedReportText(gap),
    ...(gap.evidenceQualityImpact !== undefined ? { impact: gap.evidenceQualityImpact } : {}),
  }));
  const marketGaps =
    collectedSources.marketSnapshots.length === 0
      ? [deterministicGapEntry("No usable market data snapshots were collected")]
      : [];
  const newsGaps =
    collectedSources.newsSources.length === 0
      ? [deterministicGapEntry("No usable news sources were collected")]
      : [];
  const tickerGaps =
    isInstrumentCommand(command) &&
    collectedSources.marketSnapshots.every((snapshot) => snapshot.symbol !== command.symbol)
      ? [deterministicGapEntry(`No market snapshot matched ticker ${command.symbol}`)]
      : [];
  const marketUpdateHorizon = marketUpdateHorizonOf(command);
  const overviewMoverGaps =
    marketUpdateHorizon !== undefined && marketUpdateHorizon > 5
      ? [
          deterministicGapEntry(
            command.assetClass === "equity"
              ? EQUITY_MARKET_OVERVIEW_MOVER_UNIVERSE_GAP
              : "Market overview crypto mover data uses CoinGecko 24h change fields; trailing horizon mover changes are not available in the current source payload",
          ),
        ]
      : [];

  const verifiedSnapshotGaps =
    isInstrumentCommand(command) &&
    command.assetClass === "equity" &&
    collectedSources.verifiedMarketSnapshot === undefined
      ? [deterministicGapEntry(missingVerifiedSnapshotGapText(command.symbol))]
      : [];

  // Research subject: flag representative instruments with no live or verified snapshot so the
  // Model can cite the gap instead of silently substituting a mover (Phase 2.2).
  const researchRepresentativeGaps: DataGapEntry[] = [];
  if (command.jobType === "research") {
    const { resolvedSubject } = collectedSources;
    if (resolvedSubject?.representativeInstruments !== undefined) {
      const liveSymbols = new Set(
        collectedSources.marketSnapshots.map((s) => normalizedSymbol(s.symbol)),
      );
      const verifiedSymbols = new Set(
        (collectedSources.verifiedRepresentativeSnapshots ?? []).map((s) =>
          normalizedSymbol(s.symbol),
        ),
      );
      for (const instrument of resolvedSubject.representativeInstruments) {
        const symbol = normalizedSymbol(instrument.symbol);
        if (!liveSymbols.has(symbol) && !verifiedSymbols.has(symbol)) {
          const label =
            instrument.name !== undefined
              ? `${instrument.name} (${instrument.symbol})`
              : instrument.symbol;
          researchRepresentativeGaps.push(
            deterministicGapEntry(
              `researchRepresentative: no live or verified snapshot for representative ${label}; cite the registry sourceId instead`,
            ),
          );
        }
      }
    }
  }

  return [
    ...gaps,
    ...marketGaps,
    ...newsGaps,
    ...tickerGaps,
    ...overviewMoverGaps,
    ...verifiedSnapshotGaps,
    ...researchRepresentativeGaps,
  ];
}

export function deterministicSourceGaps(
  command: ResearchCommand,
  collectedSources: CollectedSources,
): readonly string[] {
  return deterministicSourceGapEntries(command, collectedSources).map((gap) => gap.text);
}
