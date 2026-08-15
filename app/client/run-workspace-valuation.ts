import type { RunDetail } from "../types";
import type { MarketSnapshotPriceAsOf } from "../../src/domain/types";
import type { EquityReaderValuationContext } from "../../src/report/equity-reader";
import type {
  PeerImpliedRange,
  ValuationCompsRow,
} from "../../src/sources/extended-evidence/valuation-comps";
import type {
  ValuationMetricResult,
  ValuationWorkbenchArtifact,
} from "../../src/sources/extended-evidence/valuation-workbench-contract";
import type { ReverseDcfArtifact } from "../../src/sources/extended-evidence/reverse-dcf";
import { formatLensValue, scaleCurrency } from "../../src/sources/extended-evidence/value-format";
import { priceAsOfLabel, projectEquityReaderForDetail } from "./run-workspace-detail";

export interface RunWorkspacePeerImpliedRangeGeometry {
  readonly mid: number;
  readonly current: number;
}

export type RunWorkspacePeerImpliedRangeView =
  | {
      readonly status: "derived";
      readonly label: string;
      readonly sourceIds: readonly string[];
      readonly position: "below-range" | "within-range" | "above-range";
      readonly positionLabel: string;
      readonly lowLabel: string;
      readonly midLabel: string;
      readonly highLabel: string;
      readonly currentLabel: string;
      readonly methodDisclosure: string;
      readonly boundaryDisclosure: string;
      readonly geometry: RunWorkspacePeerImpliedRangeGeometry;
    }
  | {
      readonly status: "suppressed";
      readonly label: string;
      readonly sourceIds: readonly string[];
      readonly suppressionReason: string;
      readonly message: string;
    };

interface RunWorkspaceValuationMetricCell {
  readonly display: string;
  readonly status: ValuationMetricResult["status"];
  readonly detail?: string;
}

interface RunWorkspaceHistoricalValuationRow {
  readonly basis: string;
  readonly periodEnd: string;
  readonly publicAt: string;
  readonly price: string;
  readonly priceToEarnings: RunWorkspaceValuationMetricCell;
  readonly priceToSales: RunWorkspaceValuationMetricCell;
  readonly enterpriseValueToRevenue: RunWorkspaceValuationMetricCell;
  readonly priceToFreeCashFlow: RunWorkspaceValuationMetricCell;
}

interface RunWorkspaceValuationPeerRow {
  readonly symbol: string;
  readonly role: string;
  readonly status: string;
  readonly multiple: string;
  readonly currency: string;
  readonly inputDates: string;
}

export interface RunWorkspaceExcludedValuationPeerRow {
  readonly symbol: string;
  readonly role: string;
  readonly reason: string;
  readonly sourceIds: readonly string[];
}

export interface RunWorkspaceValuationWorkbenchView {
  readonly reportingCurrency: string;
  readonly quoteCurrency: string;
  readonly priceSelectionRule: string;
  readonly trailingDisclosure: string;
  readonly rows: readonly RunWorkspaceHistoricalValuationRow[];
  readonly suppressionReasons: readonly string[];
  readonly peerSupportability: string;
  readonly peerSuppression?: string;
  readonly peerRows: readonly RunWorkspaceValuationPeerRow[];
  readonly excludedPeerRows: readonly RunWorkspaceExcludedValuationPeerRow[];
}

export type RunWorkspaceReverseDcfView =
  | {
      readonly status: "computed";
      readonly startingFcf: string;
      readonly startingFcfDates: string;
      readonly enterpriseValue: string;
      readonly enterpriseValueDate: string;
      readonly horizonYears: number;
      readonly terminalGrowthRatesPct: readonly number[];
      readonly rows: readonly {
        readonly discountRatePct: number;
        readonly cells: readonly string[];
      }[];
    }
  | {
      readonly status: "suppressed";
      readonly message: string;
    };

function formatReferencePrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

const PEER_IMPLIED_RANGE_POSITION_LABELS = {
  "below-range": "Below range",
  "within-range": "Within range",
  "above-range": "Above range",
} satisfies Record<Extract<PeerImpliedRange, { status: "derived" }>["position"], string>;

export const PEER_REFERENCE_RANGE_LABEL = "Peer-implied price reference range";

function rangeGeometry(
  range: Extract<PeerImpliedRange, { status: "derived" }>,
): RunWorkspacePeerImpliedRangeGeometry {
  const span = range.high - range.low;
  if (span <= 0) {
    return { mid: 0.5, current: 0.5 };
  }
  const { currentPrice } = range.inputs;
  return {
    mid: Math.max(0, Math.min(1, (range.mid - range.low) / span)),
    current: Math.max(0, Math.min(1, (currentPrice - range.low) / span)),
  };
}

function valuationRowPriceAsOf(row: ValuationCompsRow): MarketSnapshotPriceAsOf | undefined {
  return (
    row.priceAsOf ??
    (row.quoteObservedAt === undefined
      ? undefined
      : { kind: "fetch-time-only", instant: row.quoteObservedAt })
  );
}

function valuationTargetPriceAsOf(
  detail: RunDetail,
  fallbackFetchTime: string | null | undefined,
): MarketSnapshotPriceAsOf | undefined {
  if (detail.valuationWorkbench?.peerComparison.status === "available") {
    return valuationRowPriceAsOf(detail.valuationWorkbench.peerComparison.valuationComps.target);
  }
  return fallbackFetchTime === null || fallbackFetchTime === undefined
    ? undefined
    : { kind: "fetch-time-only", instant: fallbackFetchTime };
}

function valuationRowInputDates(row: ValuationCompsRow): string {
  const priceAsOf = valuationRowPriceAsOf(row);
  return (
    [
      ...(priceAsOf === undefined ? [] : [priceAsOfLabel(priceAsOf)]),
      ...(row.revenuePeriodEnd === undefined ? [] : [`revenue ${row.revenuePeriodEnd}`]),
      ...(row.cashPeriodEnd === undefined ? [] : [`cash ${row.cashPeriodEnd}`]),
      ...(row.debtPeriodEnd === undefined ? [] : [`debt ${row.debtPeriodEnd}`]),
    ].join(" · ") || "—"
  );
}

export function peerImpliedRangeView(
  detail: RunDetail,
): RunWorkspacePeerImpliedRangeView | undefined {
  return peerImpliedRangeFromProjection(
    projectEquityReaderForDetail(detail).defaultView.valuationContext,
  );
}

export function peerImpliedRangeFromProjection(
  valuation: EquityReaderValuationContext,
): RunWorkspacePeerImpliedRangeView | undefined {
  if (valuation.kind !== "peer-range") {
    return undefined;
  }
  const { range, sourceIds } = valuation;
  const { label } = range;
  if (valuation.status === "suppressed") {
    return {
      status: "suppressed",
      label,
      sourceIds,
      suppressionReason: valuation.range.suppressedReason,
      message: `Reference range suppressed: ${valuation.range.suppressedReason}.`,
    };
  }
  const { inputs } = valuation.range;
  const { priceAsOf } = valuation;
  const priceDate = priceAsOf === undefined ? "price time unavailable" : priceAsOfLabel(priceAsOf);
  return {
    status: "derived",
    label,
    sourceIds,
    position: valuation.range.position,
    positionLabel: PEER_IMPLIED_RANGE_POSITION_LABELS[valuation.range.position],
    lowLabel: `Low ${formatReferencePrice(valuation.range.low)}`,
    midLabel: `Mid ${formatReferencePrice(valuation.range.mid)}`,
    highLabel: `High ${formatReferencePrice(valuation.range.high)}`,
    currentLabel: `Current price ${formatReferencePrice(inputs.currentPrice)}`,
    methodDisclosure: `Method: ${valuation.range.basis}; ${valuation.range.formula}. Inputs: P25 ${inputs.peerP25EvToAnnualizedRevenue.toFixed(2)}x, median ${inputs.peerMedianEvToAnnualizedRevenue.toFixed(2)}x, P75 ${inputs.peerP75EvToAnnualizedRevenue.toFixed(2)}x; annualized revenue ${formatLensValue(inputs.annualizedRevenue, "currency", "USD")}, net debt ${formatLensValue(inputs.netDebt, "currency", "USD")}, shares ${scaleCurrency(inputs.sharesOutstanding)}, current price ${formatReferencePrice(inputs.currentPrice)}, Yahoo price ${priceDate}.`,
    boundaryDisclosure: "Boundary rule: prices equal to low or high are within range.",
    geometry: rangeGeometry(valuation.range),
  };
}

function valuationMetricCell(metric: ValuationMetricResult): RunWorkspaceValuationMetricCell {
  if (metric.status === "suppressed") {
    return { display: metric.display, status: metric.status, detail: metric.detail };
  }
  if (metric.status === "not-applicable") {
    return { display: metric.display, status: metric.status, detail: metric.rationale };
  }
  if (metric.status === "not-meaningful") {
    return {
      display: metric.display,
      status: metric.status,
      detail: metric.reason.replaceAll("-", " "),
    };
  }
  return { display: metric.display, status: metric.status };
}

function valuationPeerRows(
  artifact: ValuationWorkbenchArtifact,
): readonly RunWorkspaceValuationPeerRow[] {
  if (artifact.peerComparison.status === "suppressed") {
    return [];
  }
  const { valuationComps } = artifact.peerComparison;
  return [valuationComps.target, ...valuationComps.peers].map((row) => ({
    symbol: row.symbol,
    role: row.symbol === valuationComps.target.symbol ? "target" : (row.role ?? "peer"),
    status: row.usable ? "usable" : "excluded",
    multiple:
      row.evToAnnualizedRevenue === undefined ? "N/M" : `${row.evToAnnualizedRevenue.toFixed(2)}x`,
    currency: row.quoteCurrency ?? "—",
    inputDates: valuationRowInputDates(row),
  }));
}

export function valuationWorkbenchView(
  detail: RunDetail,
): RunWorkspaceValuationWorkbenchView | undefined {
  const artifact = detail.valuationWorkbench;
  if (artifact === undefined) {
    return undefined;
  }
  const { trailingBasis } = artifact.historicalMultiples;
  const peerSupportability =
    artifact.peerComparison.status === "available"
      ? artifact.peerComparison.valuationComps.summary.valuationSupportability
      : "suppressed";
  return {
    reportingCurrency: artifact.reportingCurrency ?? "unavailable",
    quoteCurrency: artifact.quoteCurrency ?? "unavailable",
    priceSelectionRule: artifact.historicalMultiples.priceSelectionRule,
    trailingDisclosure:
      trailingBasis.status === "available"
        ? `Reconciled TTM through ${trailingBasis.periodEnd}, public ${trailingBasis.publicAt}`
        : trailingBasis.detail,
    rows: artifact.historicalMultiples.observations.map((observation) => ({
      basis: observation.basis.toUpperCase(),
      periodEnd: observation.periodEnd,
      publicAt: observation.publicAt,
      price:
        observation.price === null
          ? "—"
          : `${observation.price.close.toFixed(2)} ${observation.price.currency} · ${observation.price.sessionDate}`,
      priceToEarnings: valuationMetricCell(observation.metrics.priceToEarnings),
      priceToSales: valuationMetricCell(observation.metrics.priceToSales),
      enterpriseValueToRevenue: valuationMetricCell(observation.metrics.enterpriseValueToRevenue),
      priceToFreeCashFlow: valuationMetricCell(observation.metrics.priceToFreeCashFlow),
    })),
    suppressionReasons: artifact.historicalMultiples.suppressionReasons,
    peerSupportability,
    ...(artifact.peerComparison.status === "suppressed"
      ? { peerSuppression: artifact.peerComparison.detail }
      : {}),
    peerRows: valuationPeerRows(artifact),
    excludedPeerRows:
      artifact.peerComparison.status === "available"
        ? artifact.peerComparison.valuationComps.excludedPeers.map((peer) => ({
            symbol: peer.symbol,
            role: peer.role,
            reason: peer.reason,
            sourceIds: peer.sourceIds,
          }))
        : [],
  };
}

function formatReverseDcfAmount(value: number, currency: string): string {
  return `${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value)} ${currency}`;
}

export function reverseDcfView(detail: RunDetail): RunWorkspaceReverseDcfView | undefined {
  const artifact: ReverseDcfArtifact | undefined = detail.reverseDcf;
  if (artifact === undefined) {
    return undefined;
  }
  if (artifact.status === "suppressed") {
    return {
      status: "suppressed",
      message: `${artifact.reason}: ${artifact.detail}`,
    };
  }
  const priceAsOf = valuationTargetPriceAsOf(
    detail,
    artifact.assumptions.enterpriseValue.observedAt,
  );
  return {
    status: "computed",
    startingFcf: formatReverseDcfAmount(
      artifact.assumptions.startingFcf.value,
      artifact.assumptions.startingFcf.currency,
    ),
    startingFcfDates: `period ${artifact.assumptions.startingFcf.periodEnd} · public ${artifact.assumptions.startingFcf.publicAt}`,
    enterpriseValue: formatReverseDcfAmount(
      artifact.assumptions.enterpriseValue.value,
      artifact.assumptions.enterpriseValue.currency,
    ),
    enterpriseValueDate:
      priceAsOf === undefined
        ? `fetch time ${artifact.assumptions.enterpriseValue.observedAt}`
        : priceAsOfLabel(priceAsOf),
    horizonYears: artifact.assumptions.horizonYears,
    terminalGrowthRatesPct: artifact.assumptions.terminalGrowthRatesPct,
    rows: artifact.grid.rows.map((row) => ({
      discountRatePct: row.discountRatePct,
      cells: artifact.assumptions.terminalGrowthRatesPct.map((rate) => {
        const cell = row.cells.find((candidate) => candidate.terminalGrowthRatePct === rate);
        if (cell === undefined) {
          return "— (unavailable)";
        }
        return cell.status === "solved"
          ? `${cell.solvedFiveYearFcfGrowthPct.toFixed(2)}%`
          : "not solved";
      }),
    })),
  };
}
