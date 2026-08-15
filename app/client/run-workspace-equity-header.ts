import type { RunDetail } from "../types";
import {
  resolveMarketSnapshotPriceAsOf,
  type MarketSnapshot,
  type MarketSnapshotPriceAsOf,
} from "../../src/domain/types";
import {
  CURRENCY_SYMBOLS,
  formatLensValue,
  formatPeRatio,
  scaleCurrency,
} from "../../src/sources/extended-evidence/value-format";
import { matchingMarketSnapshot, priceAsOfLabel } from "./run-workspace-detail";

export interface RunWorkspaceEquityHeaderFinancial {
  readonly key:
    | "marketCap"
    | "trailingPE"
    | "forwardPE"
    | "forwardEPS"
    | "dividendYield"
    | "sharesOutstanding";
  readonly label: string;
  readonly value: string;
  readonly caption: string;
  readonly sourceIds: readonly string[];
}

export interface RunWorkspaceEquityHeaderView {
  readonly displayName: string;
  readonly symbol: string;
  readonly price?: string;
  readonly quoteCurrency?: string;
  readonly dailyChange?: string;
  readonly changeDirection?: "positive" | "negative" | "flat";
  readonly observedAt?: string;
  readonly priceAsOf?: MarketSnapshotPriceAsOf;
  readonly sourceIds: readonly string[];
  readonly financials: readonly RunWorkspaceEquityHeaderFinancial[];
}

function headerFinancials(snapshot: MarketSnapshot): readonly RunWorkspaceEquityHeaderFinancial[] {
  const quoteCurrency = snapshot.identity?.quoteCurrency;
  const priceDate = priceAsOfLabel(resolveMarketSnapshotPriceAsOf(snapshot));
  const sourceIds = snapshot.sourceId.trim() === "" ? [] : [snapshot.sourceId];
  const candidates: readonly (RunWorkspaceEquityHeaderFinancial | undefined)[] = [
    snapshot.marketCap === undefined || quoteCurrency === undefined
      ? undefined
      : {
          key: "marketCap",
          label: "Market cap",
          value: formatLensValue(snapshot.marketCap, "currency", quoteCurrency),
          caption: `Yahoo quote · point in time · ${priceDate}`,
          sourceIds,
        },
    snapshot.fundamentals?.trailingPE === undefined
      ? undefined
      : {
          key: "trailingPE",
          label: "Trailing P/E",
          value: formatPeRatio(
            snapshot.fundamentals.trailingPE,
            snapshot.fundamentals.epsTrailingTwelveMonths,
          ),
          caption: `Yahoo quote · trailing 12M · ${priceDate}`,
          sourceIds,
        },
    snapshot.fundamentals?.forwardPE === undefined
      ? undefined
      : {
          key: "forwardPE",
          label: "Forward P/E",
          value: formatPeRatio(snapshot.fundamentals.forwardPE, snapshot.fundamentals.epsForward),
          caption: `Yahoo quote · forward · ${priceDate}`,
          sourceIds,
        },
    snapshot.fundamentals?.epsForward === undefined
      ? undefined
      : {
          key: "forwardEPS",
          label: "Forward EPS",
          value: (() => {
            const value = formatLensValue(snapshot.fundamentals.epsForward, "number");
            const symbol =
              quoteCurrency === undefined ? undefined : CURRENCY_SYMBOLS[quoteCurrency];
            return symbol === undefined ? value : `${symbol}${value}`;
          })(),
          caption: `Yahoo quote · forward · ${priceDate}`,
          sourceIds,
        },
    snapshot.fundamentals?.dividendYield === undefined
      ? undefined
      : {
          key: "dividendYield",
          label: "Dividend yield",
          value: formatLensValue(snapshot.fundamentals.dividendYield, "whole-percent"),
          caption: `Yahoo quote · quote snapshot · ${priceDate}`,
          sourceIds,
        },
    snapshot.fundamentals?.sharesOutstanding === undefined
      ? undefined
      : {
          key: "sharesOutstanding",
          label: "Shares outstanding",
          value: scaleCurrency(snapshot.fundamentals.sharesOutstanding),
          caption: `Yahoo quote · point in time · ${priceDate}`,
          sourceIds,
        },
  ];
  return candidates.filter(
    (candidate): candidate is RunWorkspaceEquityHeaderFinancial => candidate !== undefined,
  );
}

function dailyChangeDirection(changePercent24h: number): "positive" | "negative" | "flat" {
  if (changePercent24h > 0) {
    return "positive";
  }
  if (changePercent24h < 0) {
    return "negative";
  }
  return "flat";
}

export function equityHeaderView(detail: RunDetail): RunWorkspaceEquityHeaderView | undefined {
  const snapshot = matchingMarketSnapshot(detail);
  if (snapshot === undefined) {
    return undefined;
  }
  const quoteCurrency = snapshot.identity?.quoteCurrency;
  const hasPrice = Number.isFinite(snapshot.price);
  const hasChange = Number.isFinite(snapshot.changePercent24h);
  const change = hasChange
    ? formatLensValue(snapshot.changePercent24h, "whole-percent")
    : undefined;
  const observedAt = snapshot.observedAt.trim() || undefined;
  const priceAsOf = resolveMarketSnapshotPriceAsOf(snapshot);
  const sourceIds = snapshot.sourceId.trim() === "" ? [] : [snapshot.sourceId];

  return {
    displayName: snapshot.identity?.displayName?.trim() || snapshot.name?.trim() || snapshot.symbol,
    symbol: snapshot.symbol,
    ...(hasPrice
      ? {
          price:
            quoteCurrency === undefined
              ? formatLensValue(snapshot.price, "number")
              : formatLensValue(snapshot.price, "currency", quoteCurrency),
        }
      : {}),
    ...(quoteCurrency === undefined ? {} : { quoteCurrency }),
    ...(change === undefined
      ? {}
      : {
          dailyChange: snapshot.changePercent24h > 0 ? `+${change}` : change,
          changeDirection: dailyChangeDirection(snapshot.changePercent24h),
        }),
    ...(observedAt === undefined ? {} : { observedAt }),
    priceAsOf,
    sourceIds,
    financials: headerFinancials(snapshot),
  };
}
