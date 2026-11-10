import type { SourceGap } from "../../domain/sources";
import { verifiedSnapshotSourceId } from "../verified-snapshot-contract";
import { FINANCIAL_LENS_ORDER, financialLensMetricSectionId } from "./financial-lens-contract";
import { type FinancialLensName, type FinancialLensPosture } from "./financial-lens-metrics";
import {
  evaluateMetricSection,
  type MetricContext,
  type MetricDefinition,
  type MetricInput,
  type MetricResult,
  type MetricSection,
} from "./metric-engine";
import { type LensValueUnit } from "./value-format";
import {
  type MetricPeriod,
  periodEndInput,
  withCompleteDebt,
  withFreshDebt,
  positiveOf,
  atOrBelow,
  postureFrom,
  valuationItem,
  summaryCurrentness,
  withNetDebtApplicability,
  withCurrentEquityNote,
  evidenceDisplayNetDebt,
  quoteCurrencyOf,
} from "./financial-lens-inputs";
import {
  netMarginLabel,
  marginDefinition,
  freeCashFlowDefinition,
  cashConversionDefinition,
  returnOnLabel,
  returnOnDefinition,
  consolidatedIncomeDefinitions,
} from "./financial-lens-quality";
import { yoyLabel, yearOverYearDefinition } from "./financial-lens-growth";
import {
  instantDefinition,
  netDebtDefinition,
  currentRatioDefinition,
  debtToEquityDefinition,
  marketLeverageDefinition,
  payoutRatioDefinition,
  dividendYieldDefinition,
  financingCurrentnessDefinitions,
} from "./financial-lens-strength";
import { valueDefinitions } from "./financial-lens-value";

function verifiedInput(
  ctx: MetricContext,
  key: string,
  label: string,
  value: number,
  period: MetricPeriod,
  unit: LensValueUnit = "number",
  currency?: string,
): MetricInput {
  return {
    label,
    value,
    artifact: "verifiedSnapshot",
    key,
    unit,
    ...(currency !== undefined ? { currency } : {}),
    sourceIds:
      ctx.verifiedSnapshot === undefined
        ? []
        : [verifiedSnapshotSourceId(ctx.verifiedSnapshot.symbol)],
    ...(period.periodEnd !== undefined ? { periodEnd: period.periodEnd } : {}),
  };
}

const session = (ctx: MetricContext) => periodEndInput(ctx.verifiedSnapshot?.latestSessionDate);

function momentumDefinitions(): readonly MetricDefinition[] {
  return [
    {
      id: "latestClose",
      label: "Latest close",
      unit: "currency",
      basis: "last completed session close from the verified market snapshot",
      compute: (ctx) => {
        const close = ctx.verifiedSnapshot?.ohlcv.close;
        return close === undefined
          ? { status: "missing", reason: "no verified market snapshot close" }
          : {
              status: "value",
              value: close,
              currency: quoteCurrencyOf(ctx),
              inputs: [
                verifiedInput(
                  ctx,
                  "latestClose",
                  "latest close",
                  close,
                  session(ctx),
                  "currency",
                  quoteCurrencyOf(ctx),
                ),
              ],
              ...session(ctx),
            };
      },
    },
    ...(["sma50", "sma200", "rsi14", "macdHistogram"] as const).map(
      (key): MetricDefinition => ({
        id: key,
        label: key === "macdHistogram" ? "MACD histogram" : key.toUpperCase(),
        unit: "number",
        basis: "last completed session indicator from the verified market snapshot",
        compute: (ctx) => {
          const value = ctx.verifiedSnapshot?.indicators?.[key] ?? undefined;
          return value === undefined
            ? { status: "missing", reason: `no verified ${key}` }
            : {
                status: "value",
                value,
                inputs: [verifiedInput(ctx, key, key, value, session(ctx))],
                ...session(ctx),
              };
        },
      }),
    ),
  ];
}

function filedInput(metric: MetricResult): boolean {
  return metric.inputs.some(
    (input) =>
      input.artifact === "statements" ||
      (input.artifact === "evidence" && input.category === "sec-edgar"),
  );
}

function valueOf(section: readonly MetricResult[] | undefined, id: string): number | undefined {
  const metric = section?.find((candidate) => candidate.id === id);
  return metric?.status === "value" && typeof metric.value === "number" ? metric.value : undefined;
}

function meets(
  value: number | undefined,
  criterion: (input: number) => boolean,
): boolean | undefined {
  return value === undefined ? undefined : criterion(value);
}

function filedMetric(section: readonly MetricResult[] | undefined, id: string): boolean {
  const metric = section?.find((candidate) => candidate.id === id);
  return (
    metric?.inputs.some(
      (input) =>
        input.artifact === "statements" ||
        (input.artifact === "evidence" && input.category === "sec-edgar"),
    ) === true
  );
}

function qualityPosture(section: readonly MetricResult[] | undefined): FinancialLensPosture {
  return postureFrom([
    positiveOf(valueOf(section, "grossMargin")),
    positiveOf(valueOf(section, "operatingMargin")),
    positiveOf(valueOf(section, "netMargin")),
    positiveOf(valueOf(section, "freeCashFlowProxy")),
  ]);
}

function growthPosture(section: readonly MetricResult[] | undefined): FinancialLensPosture {
  return postureFrom(
    [
      "revenueDeltaPercent",
      "grossProfitDeltaPercent",
      "operatingIncomeDeltaPercent",
      "netIncomeDeltaPercent",
      "dilutedEpsDeltaPercent",
      "operatingCashFlowDeltaPercent",
    ].map((id) => positiveOf(valueOf(section, id))),
    2,
  );
}

function summaryNetDebtCriterion(ctx: MetricContext): boolean | undefined {
  if (!summaryCurrentness(ctx, "netDebt").current) {
    return undefined;
  }
  return meets(evidenceDisplayNetDebt(ctx), (value) => value <= 0);
}

function strengthPosture(
  ctx: MetricContext,
  section: readonly MetricResult[] | undefined,
): FinancialLensPosture {
  const netDebtCriterion =
    ctx.statements === undefined
      ? summaryNetDebtCriterion(ctx)
      : meets(valueOf(section, "netDebt"), (value) => value <= 0);
  return postureFrom([
    netDebtCriterion,
    meets(valueOf(section, "netDebtToMarketCap"), (value) => value <= 0.25),
    meets(valueOf(section, "debtToMarketCap"), (value) => value <= 0.5),
    meets(valueOf(section, "currentRatio"), (value) => value >= 1),
    filedMetric(section, "payoutRatio")
      ? atOrBelow(valueOf(section, "payoutRatio"), 0.8)
      : undefined,
  ]);
}

function valuePosture(ctx: MetricContext): FinancialLensPosture {
  const supportability = valuationItem(ctx)?.metrics?.valuationSupportability;
  return postureFrom([
    supportability === undefined || supportability === "not-meaningful"
      ? undefined
      : supportability === "supported",
  ]);
}

function momentumPosture(section: readonly MetricResult[] | undefined): FinancialLensPosture {
  const close = valueOf(section, "latestClose");
  const sma50 = valueOf(section, "sma50");
  const sma200 = valueOf(section, "sma200");
  const rsi14 = valueOf(section, "rsi14");
  const macdHistogram = valueOf(section, "macdHistogram");
  return postureFrom([
    close === undefined || sma50 === undefined ? undefined : close > sma50,
    sma50 === undefined || sma200 === undefined ? undefined : sma50 > sma200,
    meets(rsi14, (value) => value >= 40 && value <= 70),
    meets(macdHistogram, (value) => value >= 0),
  ]);
}

function lensDefinitions(
  ctx: MetricContext,
): Readonly<Record<FinancialLensName, readonly MetricDefinition[]>> {
  return {
    Quality: [
      marginDefinition("grossMargin", "grossProfit", "revenue", "Gross margin"),
      marginDefinition("operatingMargin", "operatingIncome", "revenue", "Operating margin"),
      marginDefinition("netMargin", "netIncome", "revenue", netMarginLabel(ctx), true),
      freeCashFlowDefinition(ctx),
      cashConversionDefinition(),
      returnOnDefinition(
        "roe",
        "stockholdersEquity",
        returnOnLabel(ctx, "roe", "stockholdersEquity"),
      ),
      returnOnDefinition("roa", "totalAssets", returnOnLabel(ctx, "roa", "totalAssets")),
      ...consolidatedIncomeDefinitions(ctx),
    ],
    Growth: [
      ...(
        [
          "revenue",
          "grossProfit",
          "operatingIncome",
          "netIncome",
          "dilutedEps",
          "continuingIncome",
          "continuingDilutedEps",
          "operatingCashFlow",
        ] as const
      ).map((key) => yearOverYearDefinition(key, yoyLabel(ctx, key))),
      // SEC payments-for-PP&E concepts are positive outflows; a negative filing is withheld, not sign-flipped.
      yearOverYearDefinition("capitalExpenditure", "Capex YoY (outflow amount)", "capex", true),
    ],
    "Financial Strength": [
      instantDefinition("cash", "cash", "Cash"),
      withCompleteDebt(withFreshDebt(instantDefinition("debt", "debt", "Debt"))),
      withNetDebtApplicability(withCompleteDebt(withCurrentEquityNote(netDebtDefinition()))),
      withCompleteDebt(marketLeverageDefinition("debtToMarketCap")),
      withNetDebtApplicability(
        withCompleteDebt(withCurrentEquityNote(marketLeverageDefinition("netDebtToMarketCap"))),
      ),
      currentRatioDefinition(),
      withCompleteDebt(debtToEquityDefinition()),
      payoutRatioDefinition(),
      dividendYieldDefinition(),
      ...financingCurrentnessDefinitions(ctx),
    ],
    Value: valueDefinitions(ctx),
    Momentum: momentumDefinitions(),
  };
}

export function financialLensMetrics(ctx: MetricContext): {
  readonly sections: readonly MetricSection[];
  readonly lensMetrics: Readonly<Record<FinancialLensName, readonly MetricResult[]>>;
  readonly postures: Readonly<Record<FinancialLensName, FinancialLensPosture>>;
  readonly sourceGaps: readonly SourceGap[];
} {
  const definitions = lensDefinitions(ctx);
  const evaluated = FINANCIAL_LENS_ORDER.map((name) => {
    const result = evaluateMetricSection(
      financialLensMetricSectionId(name),
      `Financial Lens: ${name}`,
      definitions[name],
      ctx,
    );
    return [name, result] as const;
  });
  const emitted = evaluated.filter(([, { section }]) => section.metrics.some(filedInput));
  const sections = emitted.map(([, { section }]) => section);
  const lensMetrics = Object.fromEntries(
    evaluated.map(([name, { section }]) => [name, section.metrics] as const),
  ) as Readonly<Record<FinancialLensName, readonly MetricResult[]>>;
  const postures: Record<FinancialLensName, FinancialLensPosture> = {
    Quality: qualityPosture(lensMetrics.Quality),
    Growth: growthPosture(lensMetrics.Growth),
    "Financial Strength": strengthPosture(ctx, lensMetrics["Financial Strength"]),
    Value: valuePosture(ctx),
    Momentum: momentumPosture(lensMetrics.Momentum),
  };
  return {
    sections,
    lensMetrics,
    postures,
    sourceGaps: emitted.flatMap(([, { sourceGaps }]) => sourceGaps),
  };
}
