import type {
  FinancialStatementFact,
  FinancialStatementParityComparison,
  FinancialStatementSeries,
  FinancialStatementsArtifact,
  FinancialStatementShadowParity,
} from "./financial-statements-contract";
import { financialStatementSeries } from "./financial-statements";
import { financialStatementPeriodMonths } from "./financial-statement-periods";
import type { FundamentalHistoryArtifact } from "./fundamental-history";
import type { FinancialLensArtifact, FinancialLensMetric } from "./financial-lens";

export interface FinancialStatementParityInput {
  readonly fundamentalHistory?: FundamentalHistoryArtifact;
  readonly financialLenses?: FinancialLensArtifact;
}

const HISTORY_SERIES: Readonly<Record<string, string>> = {
  revenue: "revenue",
  grossProfit: "grossProfit",
  operatingIncome: "operatingIncome",
  netIncome: "netIncome",
  dilutedEps: "dilutedEps",
  operatingCashFlow: "operatingCashFlow",
  capex: "capitalExpenditure",
};

function numbersMatch(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= scale * 1e-12;
}

function directFormsAreLegacySupported(series: readonly FinancialStatementSeries[]): boolean {
  return series.some((item) =>
    [...item.annual, ...item.interim].some(
      (fact) => fact.canonicalForm === "10-K" || fact.canonicalForm === "10-Q",
    ),
  );
}

function explainedUnsupported(
  consumer: "fundamental-history" | "financial-lens",
): FinancialStatementParityComparison {
  return {
    consumer,
    field: "structured-financial-coverage",
    status: "explained",
    reasonCode: "legacy-form-unsupported",
    explanation:
      "The shadow artifact supports 20-F/6-K companyfacts while the Phase 1 legacy consumer remains limited to 10-K/10-Q.",
  };
}

function differenceComparison(input: {
  readonly consumer: "fundamental-history" | "financial-lens";
  readonly field: string;
  readonly artifactValue: number | string;
  readonly legacyValue: number | string;
  readonly periodEnd?: string;
  readonly artifactFact?: FinancialStatementFact;
  readonly currencyDifference?: boolean;
  readonly periodSelectionDifference?: boolean;
  readonly verifiedRestatementDifference?: boolean;
  readonly verifiedHistoryCapDifference?: boolean;
}): FinancialStatementParityComparison {
  if (input.currencyDifference === true) {
    return {
      consumer: input.consumer,
      field: input.field,
      status: "explained",
      artifactValue: input.artifactValue,
      legacyValue: input.legacyValue,
      ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
      reasonCode: "canonical-reporting-currency-isolation",
      explanation:
        "The canonical series isolates the reporting currency selected from the latest annual revenue basis; the legacy selector uses its fixed unit preference.",
    };
  }
  if (input.verifiedRestatementDifference === true) {
    return {
      consumer: input.consumer,
      field: input.field,
      status: "explained",
      artifactValue: input.artifactValue,
      legacyValue: input.legacyValue,
      ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
      reasonCode: "canonical-restatement-precedence",
      explanation:
        "The canonical selector applies accession/date/amendment precedence to the matching period before comparison.",
    };
  }
  if (input.verifiedHistoryCapDifference === true) {
    return {
      consumer: input.consumer,
      field: input.field,
      status: "explained",
      artifactValue: input.artifactValue,
      legacyValue: input.legacyValue,
      ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
      reasonCode: "canonical-history-cap",
      explanation:
        "The exact canonical period was explicitly omitted by the shared artifact history cap.",
    };
  }
  if (input.periodSelectionDifference === true) {
    return {
      consumer: input.consumer,
      field: input.field,
      status: "explained",
      artifactValue: input.artifactValue,
      legacyValue: input.legacyValue,
      ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
      reasonCode: "canonical-period-selection",
      explanation:
        "The canonical selector keeps start/end period keys isolated before selecting comparable periods; the legacy selector ranks by its current period heuristic.",
    };
  }
  return {
    consumer: input.consumer,
    field: input.field,
    status: "unexplained",
    artifactValue: input.artifactValue,
    legacyValue: input.legacyValue,
    ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
  };
}

function fundamentalHistoryComparisons(
  artifact: FinancialStatementsArtifact,
  history: FundamentalHistoryArtifact | undefined,
): readonly FinancialStatementParityComparison[] {
  const series = financialStatementSeries(artifact);
  if (!directFormsAreLegacySupported(series)) {
    return series.some((item) => item.annual.length > 0 || item.interim.length > 0)
      ? [explainedUnsupported("fundamental-history")]
      : [];
  }
  if (history === undefined) {
    return [
      {
        consumer: "fundamental-history",
        field: "structured-financial-coverage",
        status: "unexplained",
        artifactValue: "present",
        legacyValue: "missing",
      },
    ];
  }
  const comparisons: FinancialStatementParityComparison[] = [];
  for (const [historyKey, artifactKey] of Object.entries(HISTORY_SERIES)) {
    const artifactSeries = series.find((item) => item.key === artifactKey);
    const historySeries = history.series[historyKey as keyof typeof history.series];
    if (artifactSeries === undefined) {
      continue;
    }
    const artifactAnnualByPeriod = new Map(
      artifactSeries.annual.map((fact) => [fact.periodKey, fact]),
    );
    const legacyAnnualByPeriod = new Map(
      (historySeries?.annual ?? []).map((point) => [
        `${point.periodStart}|${point.periodEnd}`,
        point,
      ]),
    );
    const periodKeys = [
      ...new Set([...artifactAnnualByPeriod.keys(), ...legacyAnnualByPeriod.keys()]),
    ].toSorted();
    for (const periodKey of periodKeys) {
      const legacyPoint = legacyAnnualByPeriod.get(periodKey);
      const artifactFact = artifactAnnualByPeriod.get(periodKey);
      const periodEnd = artifactFact?.periodEnd ?? legacyPoint?.periodEnd;
      const field = `${historyKey}.annual`;
      if (artifactFact === undefined || legacyPoint === undefined) {
        const capKey = `annual|${periodKey}`;
        comparisons.push(
          differenceComparison({
            consumer: "fundamental-history",
            field,
            artifactValue: artifactFact?.value ?? "missing",
            legacyValue: legacyPoint?.value ?? "missing",
            ...(periodEnd !== undefined ? { periodEnd } : {}),
            verifiedHistoryCapDifference:
              artifactFact === undefined &&
              artifact.omissionNotes.some(
                (note) => note.code === "history-cap" && note.periodKey === capKey,
              ),
          }),
        );
        continue;
      }
      const valueMatch = numbersMatch(artifactFact.value, legacyPoint.value);
      const currencyMatch = artifactFact.unit === legacyPoint.currency;
      comparisons.push(
        valueMatch && currencyMatch
          ? {
              consumer: "fundamental-history",
              field,
              status: "matched",
              artifactValue: artifactFact.value,
              legacyValue: legacyPoint.value,
              periodEnd: legacyPoint.periodEnd,
            }
          : differenceComparison({
              consumer: "fundamental-history",
              field,
              artifactValue: artifactFact.value,
              legacyValue: legacyPoint.value,
              periodEnd: legacyPoint.periodEnd,
              artifactFact,
              currencyDifference: !currencyMatch,
              verifiedRestatementDifference:
                artifactFact.amendment && artifactFact.filedAt > legacyPoint.filedAt,
            }),
      );
    }
    if (artifactSeries.ttm !== undefined || historySeries?.ttm !== undefined) {
      if (artifactSeries.ttm === undefined || historySeries?.ttm === undefined) {
        const periodEnd = artifactSeries.ttm?.periodEnd ?? historySeries?.ttm?.periodEnd;
        comparisons.push({
          consumer: "fundamental-history",
          field: `${historyKey}.ttm`,
          status: "unexplained",
          artifactValue: artifactSeries.ttm?.value ?? "missing",
          legacyValue: historySeries?.ttm?.value ?? "missing",
          ...(periodEnd !== undefined ? { periodEnd } : {}),
        });
        continue;
      }
      const valueMatch = numbersMatch(artifactSeries.ttm.value, historySeries.ttm.value);
      const periodMatch =
        artifactSeries.ttm.periodStart === historySeries.ttm.periodStart &&
        artifactSeries.ttm.periodEnd === historySeries.ttm.periodEnd;
      const currencyMatch = artifactSeries.ttm.unit === historySeries.ttm.currency;
      comparisons.push(
        valueMatch && periodMatch && currencyMatch
          ? {
              consumer: "fundamental-history",
              field: `${historyKey}.ttm`,
              status: "matched",
              artifactValue: artifactSeries.ttm.value,
              legacyValue: historySeries.ttm.value,
              periodEnd: historySeries.ttm.periodEnd,
            }
          : differenceComparison({
              consumer: "fundamental-history",
              field: `${historyKey}.ttm`,
              artifactValue: artifactSeries.ttm.value,
              legacyValue: historySeries.ttm.value,
              periodEnd: artifactSeries.ttm.periodEnd,
              currencyDifference: !currencyMatch,
              periodSelectionDifference: !periodMatch,
            }),
      );
    }
  }
  return comparisons;
}

function lensMetrics(
  artifact: FinancialLensArtifact | undefined,
): ReadonlyMap<string, FinancialLensMetric> {
  if (artifact === undefined) {
    return new Map();
  }
  return new Map(
    artifact.lenses.flatMap((lens) => lens.metrics.map((metric) => [metric.key, metric] as const)),
  );
}

function latestFact(
  series: FinancialStatementSeries | undefined,
): FinancialStatementFact | undefined {
  return series === undefined
    ? undefined
    : [...series.annual, ...series.interim].toSorted(
        (left, right) =>
          right.periodEnd.localeCompare(left.periodEnd) ||
          right.filedAt.localeCompare(left.filedAt) ||
          (right.accessionNumber ?? "").localeCompare(left.accessionNumber ?? ""),
      )[0];
}

function latestCommonFacts(
  series: readonly (FinancialStatementSeries | undefined)[],
): readonly FinancialStatementFact[] | undefined {
  if (series.some((item) => item === undefined)) {
    return undefined;
  }
  const facts = series.map((item) => [...item!.annual, ...item!.interim]);
  const commonKeys = facts[0]
    ?.map((fact) => fact.periodKey)
    .filter((key) => facts.every((items) => items.some((fact) => fact.periodKey === key)))
    .toSorted()
    .at(-1);
  return commonKeys === undefined
    ? undefined
    : facts.map((items) => items.find((fact) => fact.periodKey === commonKeys)!);
}

function financialLensComparisons(
  artifact: FinancialStatementsArtifact,
  financialLenses: FinancialLensArtifact | undefined,
): readonly FinancialStatementParityComparison[] {
  const series = financialStatementSeries(artifact);
  if (!directFormsAreLegacySupported(series)) {
    return series.some((item) => item.annual.length > 0 || item.interim.length > 0)
      ? [explainedUnsupported("financial-lens")]
      : [];
  }
  const metrics = lensMetrics(financialLenses);
  const byKey = new Map(series.map((item) => [item.key, item]));
  const candidates: readonly {
    readonly key: string;
    readonly fact: FinancialStatementFact | undefined;
    readonly artifactValue: number | undefined;
    readonly currency?: string | null;
  }[] = [
    (() => {
      const fact = latestFact(byKey.get("cash"));
      return {
        key: "cash",
        fact,
        artifactValue: fact?.value,
        ...(fact?.currency !== undefined ? { currency: fact.currency } : {}),
      };
    })(),
    (() => {
      const facts = latestCommonFacts([
        byKey.get("operatingCashFlow"),
        byKey.get("capitalExpenditure"),
      ]);
      return {
        key: "freeCashFlowProxy",
        fact: facts?.[0],
        artifactValue: facts === undefined ? undefined : facts[0]!.value - facts[1]!.value,
        ...(facts?.[0]?.currency !== undefined ? { currency: facts[0].currency } : {}),
      };
    })(),
    ...(
      [
        ["grossMargin", "grossProfit"],
        ["operatingMargin", "operatingIncome"],
        ["netMargin", "netIncome"],
      ] as const
    ).map(([key, numeratorKey]) => {
      const facts = latestCommonFacts([byKey.get(numeratorKey), byKey.get("revenue")]);
      return {
        key,
        fact: facts?.[0],
        artifactValue:
          facts === undefined || facts[1]!.value === 0
            ? undefined
            : facts[0]!.value / facts[1]!.value,
      };
    }),
    (() => {
      const facts = latestCommonFacts([
        byKey.get("currentAssets"),
        byKey.get("currentLiabilities"),
      ]);
      return {
        key: "currentRatio",
        fact: facts?.[0],
        artifactValue:
          facts === undefined || facts[1]!.value === 0
            ? undefined
            : facts[0]!.value / facts[1]!.value,
      };
    })(),
  ];
  return candidates.flatMap((candidate) => {
    const metric = metrics.get(candidate.key);
    if (metric === undefined && candidate.artifactValue === undefined) {
      return [];
    }
    if (
      metric === undefined ||
      typeof metric.value !== "number" ||
      candidate.artifactValue === undefined
    ) {
      return [
        {
          consumer: "financial-lens" as const,
          field: candidate.key,
          status: "unexplained" as const,
          artifactValue: candidate.artifactValue ?? "missing",
          legacyValue: metric?.value ?? "missing",
          ...(candidate.fact?.periodEnd !== undefined
            ? { periodEnd: candidate.fact.periodEnd }
            : {}),
        },
      ];
    }
    const valueMatch = numbersMatch(candidate.artifactValue, metric.value);
    const periodMatch =
      (metric.periodEnd === undefined || metric.periodEnd === candidate.fact?.periodEnd) &&
      (metric.periodMonths === undefined ||
        metric.periodMonths ===
          (candidate.fact === undefined
            ? undefined
            : financialStatementPeriodMonths(candidate.fact)));
    const currencyMatch = metric.currency === undefined || metric.currency === candidate.currency;
    return [
      valueMatch && periodMatch && currencyMatch
        ? {
            consumer: "financial-lens" as const,
            field: candidate.key,
            status: "matched" as const,
            artifactValue: candidate.artifactValue,
            legacyValue: metric.value,
            ...(candidate.fact?.periodEnd !== undefined
              ? { periodEnd: candidate.fact.periodEnd }
              : {}),
          }
        : differenceComparison({
            consumer: "financial-lens",
            field: candidate.key,
            artifactValue: candidate.artifactValue,
            legacyValue: metric.value,
            ...(candidate.fact?.periodEnd !== undefined
              ? { periodEnd: candidate.fact.periodEnd }
              : {}),
            ...(candidate.fact !== undefined ? { artifactFact: candidate.fact } : {}),
            currencyDifference: !currencyMatch,
            periodSelectionDifference: !periodMatch,
          }),
    ];
  });
}

function summarizeParity(
  comparisons: readonly FinancialStatementParityComparison[],
): FinancialStatementShadowParity {
  const matchedCount = comparisons.filter((comparison) => comparison.status === "matched").length;
  const explainedCount = comparisons.filter(
    (comparison) => comparison.status === "explained",
  ).length;
  const unexplainedCount = comparisons.filter(
    (comparison) => comparison.status === "unexplained",
  ).length;
  let status: FinancialStatementShadowParity["status"] = "not-applicable";
  if (unexplainedCount > 0) {
    status = "unexplained";
  } else if (explainedCount > 0) {
    status = "explained";
  } else if (matchedCount > 0) {
    status = "matched";
  }
  return {
    version: 1,
    status,
    matchedCount,
    explainedCount,
    unexplainedCount,
    comparisons,
  };
}

export function attachFinancialStatementParity(
  artifact: FinancialStatementsArtifact,
  input: FinancialStatementParityInput,
): FinancialStatementsArtifact {
  const comparisons = [
    ...fundamentalHistoryComparisons(artifact, input.fundamentalHistory),
    ...financialLensComparisons(artifact, input.financialLenses),
  ];
  return { ...artifact, shadowParity: summarizeParity(comparisons) };
}
