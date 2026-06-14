import type { ResearchCommand } from "../../cli/args";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  MarketSnapshot,
  SourceGap,
} from "../../domain/types";
import { sourceGap } from "../../domain/source-gaps";

interface ValuationEvidenceResult {
  readonly extendedEvidence?: ExtendedEvidence;
  readonly sourceGaps: readonly SourceGap[];
}

const REQUIRED_SEC_METRICS = ["revenue", "cash", "debt"] as const;

function readMetric(
  metrics: Readonly<Record<string, number | string>> | undefined,
  key: string,
): number | undefined {
  const value = metrics?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tickerSnapshot(
  command: Extract<ResearchCommand, { readonly jobType: "ticker" }>,
  marketSnapshots: readonly MarketSnapshot[],
): MarketSnapshot | undefined {
  const symbol = command.symbol.toUpperCase();
  return marketSnapshots.find(
    (snapshot) =>
      snapshot.assetClass === command.assetClass && snapshot.symbol.toUpperCase() === symbol,
  );
}

function valuationGap(
  command: Extract<ResearchCommand, { readonly jobType: "ticker" }>,
  missing: readonly string[],
): SourceGap {
  return sourceGap({
    source: "valuation",
    message: `Valuation Evidence unavailable for ${command.symbol}: missing ${missing.join(", ")}`,
    provider: "market-bot",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
  });
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator > 0 ? numerator / denominator : undefined;
}

function fixed(value: number | undefined): string {
  return value === undefined ? "n/a" : `${value.toFixed(2)}x`;
}

function formatUsd(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (abs >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(1)}M`;
  }
  return `$${value.toFixed(0)}`;
}

export function addValuationEvidence(
  command: ResearchCommand,
  marketSnapshots: readonly MarketSnapshot[],
  extendedEvidence: ExtendedEvidence | undefined,
): ValuationEvidenceResult {
  if (command.jobType !== "ticker" || command.assetClass !== "equity") {
    return { ...(extendedEvidence !== undefined ? { extendedEvidence } : {}), sourceGaps: [] };
  }

  const snapshot = tickerSnapshot(command, marketSnapshots);
  const secItem = extendedEvidence?.items.find((item) => item.category === "sec-edgar");
  const marketCap = snapshot?.marketCap;
  const revenue = readMetric(secItem?.metrics, "revenue");
  const cash = readMetric(secItem?.metrics, "cash");
  const debt = readMetric(secItem?.metrics, "debt");
  const missing = [
    ...(marketCap === undefined ? ["marketCap"] : []),
    ...REQUIRED_SEC_METRICS.filter((metric) => readMetric(secItem?.metrics, metric) === undefined),
  ];

  if (
    snapshot === undefined ||
    secItem === undefined ||
    marketCap === undefined ||
    revenue === undefined ||
    cash === undefined ||
    debt === undefined
  ) {
    const gaps = [valuationGap(command, missing.length > 0 ? missing : ["SEC fundamentals"])];
    const mergedEvidence: ExtendedEvidence = {
      instrument: extendedEvidence?.instrument ?? {
        symbol: command.symbol,
        assetClass: command.assetClass,
      },
      items: extendedEvidence?.items ?? [],
      gaps: [...(extendedEvidence?.gaps ?? []), ...gaps],
    };
    return { extendedEvidence: mergedEvidence, sourceGaps: gaps };
  }

  const annualizedRevenue = revenue * 4;
  const enterpriseValue = marketCap + debt - cash;
  const evToAnnualizedRevenue = ratio(enterpriseValue, annualizedRevenue);
  const marketCapToAnnualizedRevenue = ratio(marketCap, annualizedRevenue);
  const debtToMarketCap = ratio(debt, marketCap);
  const netDebt = debt - cash;
  const netDebtToMarketCap = ratio(netDebt, marketCap);
  const item: ExtendedEvidenceItem = {
    category: "valuation",
    title: `${command.symbol} Valuation Evidence`,
    summary:
      `Valuation Evidence: market cap ${formatUsd(marketCap)}, enterprise value ${formatUsd(enterpriseValue)}, ` +
      `annualized latest-quarter revenue ${formatUsd(annualizedRevenue)}, EV/annualized revenue ${fixed(evToAnnualizedRevenue)}, ` +
      `market cap/annualized revenue ${fixed(marketCapToAnnualizedRevenue)}, debt/market cap ${fixed(debtToMarketCap)}, ` +
      `net debt/market cap ${fixed(netDebtToMarketCap)}.`,
    sourceIds: [snapshot.sourceId, ...secItem.sourceIds],
    observedAt: snapshot.observedAt > secItem.observedAt ? snapshot.observedAt : secItem.observedAt,
    metrics: {
      marketCap,
      cash,
      debt,
      netDebt,
      enterpriseValue,
      latestQuarterRevenue: revenue,
      annualizedLatestQuarterRevenue: annualizedRevenue,
      ...(evToAnnualizedRevenue !== undefined ? { evToAnnualizedRevenue } : {}),
      ...(marketCapToAnnualizedRevenue !== undefined ? { marketCapToAnnualizedRevenue } : {}),
      ...(debtToMarketCap !== undefined ? { debtToMarketCap } : {}),
      ...(netDebtToMarketCap !== undefined ? { netDebtToMarketCap } : {}),
    },
    ...(secItem.identity !== undefined ? { identity: secItem.identity } : {}),
  };

  return {
    extendedEvidence: {
      instrument: extendedEvidence?.instrument ?? {
        symbol: command.symbol,
        assetClass: command.assetClass,
      },
      items: [...(extendedEvidence?.items ?? []), item],
      gaps: extendedEvidence?.gaps ?? [],
    },
    sourceGaps: [],
  };
}
