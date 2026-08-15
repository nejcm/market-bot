import type { ExtendedEvidence, OhlcvBar, Source, SourceGap } from "../../domain/types";
import type { FetchLike } from "../types";
import { depositoryIssuerSic } from "./industry-classification";
import { fetchYahooFxClosesOnOrBefore, type YahooFxClose } from "../yahoo-fx";
import type { FinancialStatementsArtifact } from "./financial-statements-contract";
import {
  periodPublicAt,
  unique,
  valuationPeriodInputs,
  type ValuationPeriodInputs,
} from "./valuation-workbench-inputs";
import { metricResults } from "./valuation-workbench-metrics";
import type { ValuationCompsArtifact } from "./valuation-comps";
import type {
  HistoricalValuationObservation,
  TrailingValuationBasis,
  ValuationPriceInput,
  ValuationWorkbenchArtifact,
  PeerValuationComparison,
} from "./valuation-workbench-contract";

const DAY_MS = 86_400_000;
const MAX_PRICE_ALIGNMENT_DAYS = 7;
const PRICE_SELECTION_RULE =
  "first verified close within 7 calendar days on or after publicAt" as const;

export interface BuildValuationWorkbenchInput {
  readonly generatedAt: string;
  readonly symbol: string;
  readonly financialStatements?: FinancialStatementsArtifact;
  readonly valuationComps?: ValuationCompsArtifact;
  readonly priceHistory: readonly Pick<OhlcvBar, "date" | "close">[];
  readonly priceSourceId?: string;
  readonly quoteCurrency?: string;
  // Carried only to classify the issuer's industry; see depositoryIssuerSic.
  readonly extendedEvidence?: ExtendedEvidence;
}

function selectedPrice(
  input: BuildValuationWorkbenchInput,
  publicAt: string,
): ValuationPriceInput | null {
  if (input.priceSourceId === undefined || input.quoteCurrency === undefined) {
    return null;
  }
  const publicAtMs = Date.parse(publicAt);
  const priceObservation = input.priceHistory
    .filter((price) => {
      const delayDays = (Date.parse(price.date) - publicAtMs) / DAY_MS;
      return (
        Number.isFinite(delayDays) &&
        delayDays >= 0 &&
        delayDays <= MAX_PRICE_ALIGNMENT_DAYS &&
        price.close > 0 &&
        Number.isFinite(price.close)
      );
    })
    .toSorted((left, right) => left.date.localeCompare(right.date))
    .at(0);
  return priceObservation === undefined
    ? null
    : {
        close: priceObservation.close,
        sessionDate: priceObservation.date,
        currency: input.quoteCurrency,
        sourceId: input.priceSourceId,
      };
}

function observation(
  input: BuildValuationWorkbenchInput,
  periodInputs: ValuationPeriodInputs,
  fxClosesByPriceDate: Readonly<Record<string, YahooFxClose>>,
  // Classified once per issuer by the caller, never per period: a per-period decision would let
  // One row print a multiple and the next declare the metric inapplicable for the same issuer.
  depositorySic: string | undefined,
): HistoricalValuationObservation {
  const publicAt = periodPublicAt(periodInputs);
  const price = selectedPrice(input, publicAt);
  const reportingCurrency = input.financialStatements?.reportingCurrency;
  const fxCandidate = price === null ? undefined : fxClosesByPriceDate[price.sessionDate];
  const fxClose =
    price !== null &&
    reportingCurrency !== undefined &&
    price.currency !== reportingCurrency &&
    fxCandidate !== undefined &&
    fxCandidate.date <= price.sessionDate
      ? fxCandidate
      : undefined;
  const metricPrice =
    price !== null && fxClose !== undefined && reportingCurrency !== undefined
      ? {
          ...price,
          close: price.close * fxClose.quoteCurrencyPerBaseCurrency,
          currency: reportingCurrency,
        }
      : price;
  const inputs = {
    ...(periodInputs.revenue !== undefined ? { revenue: periodInputs.revenue } : {}),
    ...(periodInputs.netIncome !== undefined ? { netIncome: periodInputs.netIncome } : {}),
    ...(periodInputs.dilutedEps !== undefined ? { dilutedEps: periodInputs.dilutedEps } : {}),
    ...(periodInputs.dilutedShares !== undefined
      ? { dilutedShares: periodInputs.dilutedShares }
      : {}),
    ...(periodInputs.freeCashFlow !== undefined ? { freeCashFlow: periodInputs.freeCashFlow } : {}),
    ...(periodInputs.cash !== undefined ? { cash: periodInputs.cash } : {}),
    ...(periodInputs.debt !== undefined ? { debt: periodInputs.debt } : {}),
  };
  const sourceIds = unique([
    ...Object.values(inputs).flatMap((value) => value.sourceIds),
    ...(price === null ? [] : [price.sourceId]),
    ...(fxClose === undefined ? [] : [fxClose.sourceId]),
  ]);
  return {
    basis: periodInputs.basis,
    periodEnd: periodInputs.periodEnd,
    publicAt,
    price,
    ...(fxClose !== undefined
      ? {
          fxConversion: {
            rate: fxClose.quoteCurrencyPerBaseCurrency,
            rateDate: fxClose.date,
            pair: fxClose.pair,
            sourceId: fxClose.sourceId,
          },
        }
      : {}),
    inputs,
    metrics: metricResults(
      periodInputs,
      metricPrice,
      reportingCurrency,
      input.quoteCurrency,
      depositorySic,
      fxClose === undefined ? [] : [fxClose.sourceId],
    ),
    sourceIds,
  };
}

function trailingBasis(
  artifact: FinancialStatementsArtifact | undefined,
  ttm: ValuationPeriodInputs | undefined,
): TrailingValuationBasis {
  if (artifact === undefined || ttm === undefined) {
    return {
      status: "suppressed",
      reason: "canonical-ttm-unavailable",
      detail:
        "Canonical reconciled TTM is unavailable; retained quarter-only periods are not combined into an unreconciled TTM.",
      sourceIds: artifact === undefined ? [] : [artifact.sourceId],
    };
  }
  return {
    status: "available",
    periodEnd: ttm.periodEnd,
    publicAt: periodPublicAt(ttm),
    sourceIds: unique(
      Object.values(ttm).flatMap((value) =>
        typeof value === "object" && value !== null && "sourceIds" in value
          ? (value.sourceIds as readonly string[])
          : [],
      ),
    ),
  };
}

// The peer table's only multiple is EV/revenue and the reference range is derived from peer EV
// Multiples, so the whole comparison is EV-based and inapplicable for a depository issuer.
// Saying "unavailable" here would restate the decision as a missing input.
function peerComparison(
  valuationComps: ValuationCompsArtifact | undefined,
  depositorySic: string | undefined,
): PeerValuationComparison {
  if (depositorySic !== undefined) {
    return {
      status: "suppressed",
      reason: "enterprise-value-not-applicable",
      detail: `Peer comparison is EV-based and not applicable to a depository issuer (SIC ${depositorySic}); deposits and borrowings fund operations rather than sitting on top of them.`,
      sourceIds: [],
    };
  }
  if (valuationComps === undefined) {
    return {
      status: "suppressed",
      reason: "peer-data-unavailable",
      detail: "Peer comparison data is unavailable for this run.",
      sourceIds: [],
    };
  }
  return { status: "available", valuationComps };
}

export function buildValuationWorkbench(
  input: BuildValuationWorkbenchInput,
  fxClosesByPriceDate: Readonly<Record<string, YahooFxClose>> = {},
): ValuationWorkbenchArtifact {
  const artifact = input.financialStatements;
  const inputsForArtifact = artifact === undefined ? undefined : valuationPeriodInputs(artifact);
  const ttm = inputsForArtifact?.ttm;
  const periodInputs = inputsForArtifact?.periods ?? [];
  const depositorySic = depositoryIssuerSic(input.extendedEvidence);
  const observations = periodInputs.map((period) =>
    observation(input, period, fxClosesByPriceDate, depositorySic),
  );
  const suppressionReasons = [
    ...(artifact === undefined ? ["canonical financial statements unavailable"] : []),
    ...(observations.length === 0 ? ["no annual or reconciled TTM valuation basis available"] : []),
    ...(input.priceHistory.length === 0 ? ["verified historical closes unavailable"] : []),
    ...(input.quoteCurrency === undefined ? ["quote currency unavailable"] : []),
  ];
  const sourceIds = unique([
    ...observations.flatMap((item) => item.sourceIds),
    ...(input.valuationComps?.sourceIds ?? []),
  ]);
  return {
    version: 1,
    generatedAt: input.generatedAt,
    analysisAsOf: artifact?.analysisAsOf ?? input.generatedAt,
    symbol: input.symbol,
    reportingCurrency: artifact?.reportingCurrency ?? null,
    quoteCurrency: input.quoteCurrency ?? null,
    historicalMultiples: {
      priceSelectionRule: PRICE_SELECTION_RULE,
      observations,
      trailingBasis: trailingBasis(artifact, ttm),
      suppressionReasons,
    },
    peerComparison: peerComparison(input.valuationComps, depositorySic),
    sourceIds,
  };
}

export async function collectValuationWorkbench(
  input: BuildValuationWorkbenchInput & { readonly fetchImpl?: FetchLike },
): Promise<{
  readonly artifact: ValuationWorkbenchArtifact;
  readonly sources: readonly Source[];
  readonly sourceGaps: readonly SourceGap[];
}> {
  const { fetchImpl, ...buildInput } = input;
  const initialArtifact = buildValuationWorkbench(buildInput);
  const { reportingCurrency, quoteCurrency } = initialArtifact;
  if (reportingCurrency === null || quoteCurrency === null || reportingCurrency === quoteCurrency) {
    return { artifact: initialArtifact, sources: [], sourceGaps: [] };
  }
  const priceDates = initialArtifact.historicalMultiples.observations.flatMap(({ price }) =>
    price === null ? [] : [price.sessionDate],
  );
  if (priceDates.length === 0) {
    return { artifact: initialArtifact, sources: [], sourceGaps: [] };
  }

  // The equity's quote currency is the FX base leg: USD price × (CAD/USD) = CAD.
  const fxResult = await fetchYahooFxClosesOnOrBefore(
    quoteCurrency,
    reportingCurrency,
    priceDates,
    fetchImpl,
  );
  const [firstClose] = Object.values(fxResult.closesByRequestedDate);
  return {
    artifact: buildValuationWorkbench(buildInput, fxResult.closesByRequestedDate),
    sources:
      firstClose === undefined
        ? []
        : [
            {
              id: firstClose.sourceId,
              title: `Yahoo Finance ${firstClose.pair} historical FX closes`,
              url: `https://finance.yahoo.com/quote/${encodeURIComponent(firstClose.pair)}/history`,
              fetchedAt: input.generatedAt,
              kind: "extended-evidence",
              provider: "yahoo",
            },
          ],
    sourceGaps: fxResult.sourceGaps,
  };
}
