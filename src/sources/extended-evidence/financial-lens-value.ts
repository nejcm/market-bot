import type { ExtendedEvidenceItem } from "../../domain/evidence";
import { peIsClean, peMetricValue, valuationDateBasisMetric } from "./financial-lens-metrics";
import { financialStatementPeriodMonths } from "./financial-statement-selection";
import { type MetricContext, type MetricDefinition, type MetricOutcome } from "./metric-engine";
import { ENTERPRISE_VALUE_BASIS } from "./enterprise-value-bridge";
import { readNumberMetric, readStringMetric } from "./utils";
import { REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT } from "./valuation-comps";
import {
  type MetricPeriod,
  EMPTY_PERIOD,
  latestFact,
  factInput,
  periodOf,
  periodEndInput,
  noFact,
  annualize,
  secItem,
  valuationItem,
  targetValuationIds,
  valuationOutcome,
  yahooItem,
  evidenceInput,
  evidenceOutcome,
  summaryPeriod,
  withNetDebtApplicability,
  withCurrentEquityNote,
  marketCapInput,
  CURRENCY_MISMATCH_REASON,
  currencyMismatch,
} from "./financial-lens-inputs";

function peDefinitionsFor(
  ctx: MetricContext,
  yahoo: ExtendedEvidenceItem | undefined,
  yahooPeriod: MetricPeriod,
): readonly MetricDefinition[] {
  const trailingPe = readNumberMetric(yahoo?.metrics, "trailingPE");
  const forwardPe = readNumberMetric(yahoo?.metrics, "forwardPE");
  const epsTtm = readNumberMetric(yahoo?.metrics, "epsTrailingTwelveMonths");
  const epsForward = readNumberMetric(yahoo?.metrics, "epsForward");
  const trailingClean = peIsClean(trailingPe, epsTtm);
  const forwardClean = peIsClean(forwardPe, epsForward);
  return [
    {
      id: "peRatio",
      label: "PE",
      unit: trailingClean ? "ratio" : "text",
      basis: "Yahoo Finance trailing price/earnings",
      compute: () => {
        const value =
          trailingPe === undefined ? undefined : peMetricValue(trailingPe, epsTtm, trailingClean);
        return value === undefined || yahoo === undefined || trailingPe === undefined
          ? { status: "missing", reason: "no Yahoo trailing PE" }
          : {
              status: "value",
              value,
              inputs: [
                evidenceInput(yahoo, "trailingPE", "trailing PE", "ratio", trailingPe, yahooPeriod),
              ],
              ...yahooPeriod,
            };
      },
    },
    ...(trailingPe !== undefined && !trailingClean
      ? [
          {
            id: "epsTrailingTwelveMonths",
            label: "Trailing EPS",
            unit: "number" as const,
            basis: "Yahoo Finance trailing EPS",
            compute: () =>
              evidenceOutcome(
                yahoo,
                "epsTrailingTwelveMonths",
                "trailing EPS",
                "number",
                yahooPeriod,
              ),
          },
        ]
      : []),
    {
      id: "forwardPe",
      label: "Forward PE",
      unit: forwardClean ? "ratio" : "text",
      basis:
        "Yahoo Finance forward price/earnings; consensus forward EPS has no provider as-of date",
      compute: () => {
        const value =
          forwardPe === undefined ? undefined : peMetricValue(forwardPe, epsForward, forwardClean);
        return value === undefined || yahoo === undefined || forwardPe === undefined
          ? { status: "missing", reason: "no Yahoo forward PE" }
          : {
              status: "value",
              value,
              inputs: [
                evidenceInput(yahoo, "forwardPE", "forward PE", "ratio", forwardPe, yahooPeriod),
              ],
              ...yahooPeriod,
            };
      },
    },
    ...(forwardPe !== undefined && !forwardClean
      ? [
          {
            id: "epsForward",
            label: "Forward EPS",
            unit: "number" as const,
            basis: "Yahoo Finance forward EPS",
            compute: () =>
              evidenceOutcome(yahoo, "epsForward", "forward EPS", "number", yahooPeriod),
          },
        ]
      : []),
    {
      id: "priceToBook",
      label: "Price/book",
      unit: "ratio",
      basis: "Yahoo Finance price/book",
      compute: () => evidenceOutcome(yahoo, "priceToBook", "price/book", "ratio", yahooPeriod),
    },
  ];
}

export function valueDefinitions(ctx: MetricContext): readonly MetricDefinition[] {
  const valuation = valuationItem(ctx);
  const yahoo = yahooItem(ctx);
  const valuationPeriod = periodEndInput(readStringMetric(valuation?.metrics, "revenuePeriodEnd"));
  // Revenue multiples divide by TTM revenue, which SEC publishes only when it ends at revenuePeriodEnd.
  const ttmPeriod =
    valuationPeriod.periodEnd === undefined
      ? EMPTY_PERIOD
      : { ...valuationPeriod, periodMonths: 12 };
  const yahooPeriod = periodEndInput(yahoo?.observedAt);
  const supportability = valuation?.metrics?.valuationSupportability;
  const caveat: readonly MetricDefinition[] =
    valuation !== undefined && supportability === "not-meaningful"
      ? [
          {
            id: "valuationCaveat",
            label: "Valuation caveat",
            unit: "text",
            basis: "valuation evidence marks revenue multiples not meaningful for this issuer",
            compute: () => ({
              status: "value",
              value: REVENUE_MULTIPLE_NOT_MEANINGFUL_CAVEAT,
              ...valuationPeriod,
              inputs: [
                evidenceInput(
                  valuation,
                  "valuationSupportability",
                  "valuation supportability",
                  "text",
                  "not-meaningful",
                  valuationPeriod,
                ),
              ],
            }),
          },
        ]
      : [];
  const dateBasis = valuationDateBasisMetric(valuation).map((tile): MetricDefinition => {
    const quoteObservedAt =
      readStringMetric(valuation?.metrics, "quoteObservedAt") ??
      readStringMetric(valuation?.metrics, "quoteTimeUtc");
    return {
      id: tile.key,
      label: tile.label,
      unit: tile.unit,
      basis: "market cap quote and balance sheet dates diverge",
      compute: (): MetricOutcome => {
        const sourceIds = targetValuationIds(ctx, true);
        return quoteObservedAt === undefined || sourceIds === undefined
          ? { status: "missing", reason: "no cited EV date basis source" }
          : {
              status: "value",
              value: tile.value,
              ...(tile.periodEnd !== undefined ? { periodEnd: tile.periodEnd } : {}),
              inputs: [
                {
                  ...evidenceInput(
                    valuation,
                    "quoteObservedAt",
                    "EV date basis",
                    "text",
                    quoteObservedAt,
                    periodEndInput(tile.periodEnd),
                  ),
                  sourceIds,
                },
              ],
            };
      },
    };
  });
  const peDefinitions = peDefinitionsFor(ctx, yahoo, yahooPeriod);
  return [
    ...caveat,
    ...dateBasis,
    withNetDebtApplicability(
      withCurrentEquityNote({
        id: "enterpriseValue",
        label: "Enterprise value",
        unit: "currency",
        basis: `valuation evidence enterprise value at the quote date: ${ENTERPRISE_VALUE_BASIS}`,
        compute: () =>
          valuationOutcome(
            ctx,
            "enterpriseValue",
            "enterprise value",
            "currency",
            periodEndInput(
              readStringMetric(valuation?.metrics, "quoteObservedAt") ?? ctx.snapshot?.observedAt,
            ),
          ),
      }),
    ),
    {
      id: "annualizedRevenue",
      label: "TTM revenue",
      unit: "currency",
      basis: "valuation evidence trailing-twelve-month SEC revenue",
      compute: () =>
        valuationOutcome(ctx, "annualizedRevenue", "TTM revenue", "currency", ttmPeriod),
    },
    withNetDebtApplicability(
      withCurrentEquityNote({
        id: "evToAnnualizedRevenue",
        label: "EV/revenue",
        unit: "ratio",
        basis: `valuation evidence enterprise value / TTM revenue; ${ENTERPRISE_VALUE_BASIS}`,
        compute: () =>
          valuationOutcome(ctx, "evToAnnualizedRevenue", "EV/revenue", "ratio", ttmPeriod),
      }),
    ),
    {
      id: "marketCapToAnnualizedRevenue",
      label: "Market cap/revenue",
      unit: "ratio",
      basis: "valuation evidence market cap / TTM revenue",
      compute: () =>
        valuationOutcome(
          ctx,
          "marketCapToAnnualizedRevenue",
          "market cap/revenue",
          "ratio",
          ttmPeriod,
        ),
    },
    {
      id: "valuationSupportability",
      label: "Peer supportability",
      unit: "text",
      basis: "valuation evidence peer supportability",
      compute: (context) => {
        const item = valuationItem(context);
        const value = item?.metrics?.valuationSupportability;
        return typeof value !== "string"
          ? { status: "missing", reason: "no valuation supportability" }
          : {
              status: "value",
              value,
              inputs: [
                evidenceInput(
                  item,
                  "valuationSupportability",
                  "valuation supportability",
                  "text",
                  value,
                  valuationPeriod,
                ),
              ],
              ...valuationPeriod,
            };
      },
    },
    ...peDefinitions,
    {
      id: "pcfRatio",
      label: "PCF",
      unit: "ratio",
      basis: "quote market cap / operating cash flow annualized to a year",
      compute: (context) => {
        const marketCap = marketCapInput(context);
        if (context.statements === undefined) {
          const item = secItem(context);
          const operatingCashFlow = readNumberMetric(item?.metrics, "operatingCashFlow");
          const months = readNumberMetric(item?.metrics, "operatingCashFlowPeriodMonths");
          const denominator =
            operatingCashFlow === undefined ? undefined : annualize(operatingCashFlow, months);
          const period = summaryPeriod(context, "operatingCashFlow");
          return marketCap === undefined ||
            marketCap.value === undefined ||
            denominator === undefined ||
            denominator === 0
            ? { status: "missing", reason: "no SEC cash flow for PCF" }
            : {
                status: "value",
                value: Number(marketCap.value) / denominator,
                inputs: [
                  evidenceInput(
                    item,
                    "operatingCashFlow",
                    "operating cash flow",
                    "currency",
                    operatingCashFlow ?? 0,
                    period,
                  ),
                  marketCap,
                ],
                ...period,
              };
        }
        const anchor = latestFact(context, "operatingCashFlow");
        if (anchor === undefined) {
          return noFact(context, "operatingCashFlow");
        }
        const denominator = annualize(anchor.value, financialStatementPeriodMonths(anchor));
        const inputs = [
          factInput(anchor, "operatingCashFlow"),
          ...(marketCap === undefined ? [] : [marketCap]),
        ];
        if (denominator <= 0) {
          return {
            status: "not-meaningful",
            reason: "operating cash flow is not positive",
            ...periodOf(anchor),
            inputs: [factInput(anchor, "operatingCashFlow")],
          };
        }
        if (
          marketCap === undefined ||
          typeof marketCap.value !== "number" ||
          marketCap.value <= 0
        ) {
          return {
            status: "missing",
            reason: "no quote market cap",
            ...periodOf(anchor),
            inputs,
          };
        }
        if (currencyMismatch(marketCap, [anchor])) {
          return {
            status: "missing",
            reason: CURRENCY_MISMATCH_REASON,
            ...periodOf(anchor),
            inputs,
          };
        }
        return {
          status: "value",
          value: marketCap.value / denominator,
          ...periodOf(anchor),
          inputs,
        };
      },
    },
  ];
}
