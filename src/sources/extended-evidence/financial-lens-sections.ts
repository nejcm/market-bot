import type { SourceGap } from "../../domain/sources";
import { sourceGap } from "../../domain/source-gaps";
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
import { readNumberMetric } from "./utils";
import { PAYOUT_CEILING, payoutFallbackApplies } from "./payout-basis";
import {
  type MetricPeriod,
  periodEndInput,
  withCompleteDebt,
  postureFrom,
  criterionOf,
  type PostureCriterion,
  secItem,
  eligibleFacts,
  valuationCriterion,
  summaryCurrentness,
  withNetDebtApplicability,
  withCurrentEquityNote,
  evidenceDisplayNetDebt,
  yoyDirection,
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
  liquidityDefinition,
  trailingOperatingCashFlowDefinition,
  cashRunwayDefinitions,
  netDebtDefinition,
  currentRatioDefinition,
  debtToEquityDefinition,
  marketLeverageDefinition,
  payoutRatioDefinition,
  cumulativePayoutRatioDefinition,
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

export function latestCloseCurrency(ctx: MetricContext): string | undefined {
  return ctx.verifiedSnapshot?.currency ?? ctx.snapshot?.identity?.quoteCurrency;
}

function momentumDefinitions(): readonly MetricDefinition[] {
  return [
    {
      id: "latestClose",
      label: "Latest close",
      unit: "currency",
      basis: "last completed session close from the verified market snapshot",
      compute: (ctx) => {
        const close = ctx.verifiedSnapshot?.ohlcv.close;
        const currency = latestCloseCurrency(ctx);
        if (close === undefined) {
          return { status: "missing", reason: "no verified market snapshot close" };
        }
        return currency === undefined
          ? { status: "missing", reason: "latest close currency undeclared" }
          : {
              status: "value",
              value: close,
              currency,
              inputs: [
                verifiedInput(
                  ctx,
                  "latestClose",
                  "latest close",
                  close,
                  session(ctx),
                  "currency",
                  currency,
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
            ? {
                status: "missing",
                reason:
                  ctx.verifiedSnapshot === undefined
                    ? `no verified ${key}`
                    : `${key} not computable from the verified chart's sessions`,
              }
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

const positive = (value: number): boolean => value > 0;

function qualityPosture(section: readonly MetricResult[] | undefined): FinancialLensPosture {
  return postureFrom(
    ["grossMargin", "operatingMargin", "netMargin", "freeCashFlowProxy"].map((id) =>
      criterionOf(section, id, positive),
    ),
  );
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
    ].map((id) => criterionOf(section, id, positive, yoyDirection)),
    2,
  );
}

function summaryNetDebtCriterion(ctx: MetricContext): boolean | undefined {
  if (!summaryCurrentness(ctx, "netDebt").current) {
    return undefined;
  }
  return meets(evidenceDisplayNetDebt(ctx), (value) => value <= 0);
}

const withinPayoutCeiling = (value: number) => value <= PAYOUT_CEILING;

// The 3y window decides; a non-payer is one whose deciding window paid nothing.
export function payoutCriterion(
  ctx: MetricContext,
  section: readonly MetricResult[] | undefined,
): PostureCriterion {
  if (ctx.statements === undefined) {
    const dividend = readNumberMetric(secItem(ctx)?.metrics, "dividendsPaid");
    const payout = section?.find((metric) => metric.id === "payoutRatio");
    if (dividend === undefined || dividend === 0) {
      return "not-applicable";
    }
    return payout !== undefined && filedInput(payout)
      ? criterionOf(section, "payoutRatio", withinPayoutCeiling)
      : undefined;
  }
  if (eligibleFacts(ctx, "dividendsPaid").every((fact) => fact.value === 0)) {
    return "not-applicable";
  }
  const rows = section ?? [];
  const cumulative = rows.find((metric) => metric.id === "payoutRatio3y");
  const decidingId =
    cumulative !== undefined && cumulative.status !== "missing"
      ? "payoutRatio3y"
      : payoutFallbackApplies(rows)
        ? "payoutRatio"
        : undefined;
  if (decidingId === undefined) {
    return undefined;
  }
  return valueOf(section, decidingId) === 0
    ? "not-applicable"
    : criterionOf(section, decidingId, withinPayoutCeiling);
}

function strengthPosture(
  ctx: MetricContext,
  section: readonly MetricResult[] | undefined,
): FinancialLensPosture {
  const netDebt = criterionOf(section, "netDebt", (value) => value <= 0);
  return postureFrom([
    ctx.statements === undefined && netDebt !== "not-applicable"
      ? summaryNetDebtCriterion(ctx)
      : netDebt,
    criterionOf(section, "netDebtToMarketCap", (value) => value <= 0.25),
    criterionOf(section, "debtToMarketCap", (value) => value <= 0.5),
    criterionOf(section, "currentRatio", (value) => value >= 1),
    payoutCriterion(ctx, section),
    // Balance-sheet tests alone pass a cash-funded loss-maker; self-funding is the burn test.
    criterionOf(section, "trailingOperatingCashFlow", (value) => value >= 0),
  ]);
}

// Close vs SMA50 compares one series, so it needs no currency even when the close row is withheld.
function momentumPosture(
  ctx: MetricContext,
  section: readonly MetricResult[] | undefined,
): FinancialLensPosture {
  const close = ctx.verifiedSnapshot?.ohlcv.close;
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
      liquidityDefinition(),
      trailingOperatingCashFlowDefinition(ctx),
      ...cashRunwayDefinitions(ctx),
      withCompleteDebt(instantDefinition("debt", "debt", "Debt")),
      withNetDebtApplicability(withCompleteDebt(withCurrentEquityNote(netDebtDefinition()))),
      withCompleteDebt(marketLeverageDefinition("debtToMarketCap")),
      withNetDebtApplicability(
        withCompleteDebt(withCurrentEquityNote(marketLeverageDefinition("netDebtToMarketCap"))),
      ),
      currentRatioDefinition(),
      withCompleteDebt(debtToEquityDefinition()),
      payoutRatioDefinition(),
      cumulativePayoutRatioDefinition(),
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
  // A not-applicable verdict is decided from the filed SIC, so it anchors a section like a filed input.
  const emitted = evaluated.filter(([, { section }]) =>
    section.metrics.some((metric) => filedInput(metric) || metric.status === "not-applicable"),
  );
  const sections = emitted.map(([, { section }]) => section);
  const lensMetrics = Object.fromEntries(
    evaluated.map(([name, { section }]) => [name, section.metrics] as const),
  ) as Readonly<Record<FinancialLensName, readonly MetricResult[]>>;
  const postures: Record<FinancialLensName, FinancialLensPosture> = {
    Quality: qualityPosture(lensMetrics.Quality),
    Growth: growthPosture(lensMetrics.Growth),
    "Financial Strength": strengthPosture(ctx, lensMetrics["Financial Strength"]),
    Value: postureFrom([valuationCriterion(ctx)]),
    Momentum: momentumPosture(ctx, lensMetrics.Momentum),
  };
  const strength = lensMetrics["Financial Strength"];
  const symbol = ctx.symbol.toUpperCase();
  const latestPayout = strength.find((metric) => metric.id === "payoutRatio");
  const displayOnlyPayout =
    payoutCriterion(ctx, strength) === undefined &&
    latestPayout?.status === "value" &&
    !filedInput(latestPayout);
  return {
    sections,
    lensMetrics,
    postures,
    sourceGaps: [
      // Momentum never has a filed input, so its gaps follow the verified chart its posture reads;
      // Strength's posture reads SEC evidence, so its gaps follow that evidence even when no row is filed.
      ...evaluated
        .filter(
          (entry) =>
            emitted.includes(entry) ||
            (entry[0] === "Momentum" && ctx.verifiedSnapshot !== undefined) ||
            (entry[0] === "Financial Strength" &&
              (ctx.statements !== undefined || secItem(ctx) !== undefined)),
        )
        .flatMap(([, { sourceGaps }]) => sourceGaps),
      ...(displayOnlyPayout
        ? [
            sourceGap({
              source: financialLensMetricSectionId("Financial Strength"),
              message: `Financial Lens: Financial Strength payout criterion for ${symbol} not assessed: no current same-period filed payout ratio; the Yahoo-derived ratio is display-only`,
              symbol,
              provider: "market-bot",
              capability: "extended-evidence",
              cause: "provider-data-missing",
              evidenceQualityImpact: "no-cap",
            }),
          ]
        : []),
    ],
  };
}
