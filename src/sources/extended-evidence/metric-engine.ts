import type { ExtendedEvidence, ExtendedEvidenceCategory } from "../../domain/evidence";
import type { MarketSnapshot, VerifiedMarketSnapshot } from "../../domain/market-data";
import { sourceGap } from "../../domain/source-gaps";
import type { SourceGap } from "../../domain/sources";
import type { CapitalOwnershipArtifact } from "./capital-ownership";
import {
  derivedFactDisclosure,
  type FinancialStatementFact,
  type FinancialStatementSeriesKey,
  type FinancialStatementsArtifact,
} from "./financial-statements-contract";
import type { SubsequentFinancingBridgeArtifact } from "./subsequent-financing";
import type { LensValueUnit } from "./value-format";

type MetricStatus = "value" | "missing" | "not-meaningful" | "not-applicable";
// Structural absence is diagnostic; provider failures leave the cause unset.
type MetricMissingCause = "not-filed" | "insufficient-history" | "outside-price-history-window";

export interface MetricInput {
  readonly label: string;
  readonly value: number | string;
  readonly artifact:
    | "priceHistory"
    | "fx"
    | "statements"
    | "capitalOwnership"
    | "quote"
    | "evidence"
    | "verifiedSnapshot"
    | "subsequentFinancing";
  readonly series?: FinancialStatementSeriesKey | "stockBasedCompensation" | "marketCap";
  // Evidence inputs: the Extended Evidence item category and its metric key.
  readonly category?: ExtendedEvidenceCategory;
  readonly key?: string;
  readonly symbol?: string;
  readonly periodType?: "annual" | "interim" | "instant";
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly periodKey?: string;
  readonly unit: string;
  readonly currency?: string;
  readonly sourceIds: readonly string[];
  readonly derivation?: string;
}

export interface MetricResult {
  readonly id: string;
  readonly label: string;
  readonly unit: LensValueUnit;
  readonly basis: string;
  readonly status: MetricStatus;
  readonly value?: number | string;
  readonly currency?: string;
  readonly periodEnd?: string;
  readonly periodMonths?: number;
  readonly reason?: string;
  readonly cause?: MetricMissingCause;
  readonly inputs: readonly MetricInput[];
  readonly sourceIds: readonly string[];
}

export interface MetricSection {
  readonly id: string;
  readonly title: string;
  readonly metrics: readonly MetricResult[];
}

export interface MetricContext {
  readonly symbol: string;
  readonly statements?: FinancialStatementsArtifact;
  readonly capitalOwnership?: CapitalOwnershipArtifact;
  readonly quote?: {
    readonly marketCap: number;
    readonly currency?: string;
    readonly asOf: string;
    readonly sourceId: string;
  };
  readonly priceHistory?: readonly {
    readonly symbol: string;
    readonly sourceId: string;
    readonly currency?: string;
    readonly priceMode: "split-adjusted-close";
    readonly requestedFrom?: string;
    readonly bars: readonly {
      readonly date: string;
      readonly close: number;
      readonly completed: boolean;
    }[];
    /** Provider-reported split dates; absent when the provider split metadata was unreadable. */
    readonly splitDates?: readonly string[];
    readonly reason?: string;
  }[];
  readonly depositorySic?: string;
  readonly evidence?: ExtendedEvidence;
  readonly asOf?: string;
  readonly snapshot?: MarketSnapshot;
  readonly verifiedSnapshot?: VerifiedMarketSnapshot;
  readonly subsequentFinancing?: SubsequentFinancingBridgeArtifact;
}

// `basis` replaces the definition's when the selected inputs narrow it.
export type MetricOutcome = (
  | {
      readonly status: "value";
      readonly value: number | string;
      readonly currency?: string;
      readonly periodEnd?: string;
      readonly periodMonths?: number;
      readonly inputs: readonly MetricInput[];
    }
  | {
      readonly status: "missing";
      readonly reason: string;
      readonly cause?: MetricMissingCause;
      readonly periodEnd?: string;
      readonly inputs?: readonly MetricInput[];
    }
  | {
      readonly status: "not-meaningful";
      readonly reason: string;
      readonly periodEnd?: string;
      readonly inputs?: readonly MetricInput[];
    }
) & { readonly basis?: string; readonly label?: string };

export function seriesNotFiled(ctx: MetricContext, key: FinancialStatementSeriesKey): boolean {
  return ctx.statements?.unfiledSeries?.includes(key) === true;
}

export function statementInput(
  fact: FinancialStatementFact,
  series: FinancialStatementSeriesKey,
  label: string,
): MetricInput {
  const derivation = derivedFactDisclosure(series, fact);
  return {
    label,
    value: fact.value,
    artifact: "statements",
    series,
    periodType: fact.periodType,
    ...(fact.periodStart !== undefined ? { periodStart: fact.periodStart } : {}),
    periodEnd: fact.periodEnd,
    periodKey: fact.periodKey,
    unit: fact.unit,
    ...(fact.currency !== null ? { currency: fact.currency } : {}),
    sourceIds: fact.sourceIds,
    ...(derivation !== undefined ? { derivation } : {}),
  };
}

// One metric: `applicable` names economic inapplicability only; absent or stale inputs are `missing` from `compute`.
export interface MetricDefinition {
  readonly id: string;
  readonly label: string;
  readonly unit: LensValueUnit;
  readonly basis: string;
  readonly applicable?: (ctx: MetricContext) => string | undefined;
  readonly compute: (ctx: MetricContext) => MetricOutcome;
}

function evaluateMetric(definition: MetricDefinition, ctx: MetricContext): MetricResult {
  const { id, label, unit, basis } = definition;
  const inapplicable = definition.applicable?.(ctx);
  if (inapplicable !== undefined) {
    return {
      id,
      label,
      unit,
      basis,
      status: "not-applicable",
      reason: inapplicable,
      inputs: [],
      sourceIds: [],
    };
  }
  const outcome = definition.compute(ctx);
  const inputs = outcome.inputs ?? [];
  const derivations = [
    ...new Set(
      inputs.flatMap((input) => (input.derivation === undefined ? [] : [input.derivation])),
    ),
  ];
  return {
    id,
    label,
    unit,
    ...outcome,
    basis: [outcome.basis ?? basis, ...derivations].join("; "),
    inputs,
    sourceIds: [...new Set(inputs.flatMap((input) => input.sourceIds))],
  };
}

function sectionGap(
  id: string,
  title: string,
  symbol: string,
  unresolved: readonly MetricResult[],
): SourceGap {
  const missing = unresolved.filter((metric) => metric.status === "missing");
  const material = missing.some(
    (metric) =>
      metric.cause !== "not-filed" &&
      metric.cause !== "insufficient-history" &&
      metric.cause !== "outside-price-history-window",
  );
  const labelsByCause = new Map<string, string[]>();
  for (const metric of unresolved) {
    const cause = `${metric.status} (${metric.reason ?? "no reason"})`;
    labelsByCause.set(cause, [...(labelsByCause.get(cause) ?? []), metric.label]);
  }
  return sourceGap({
    source: id,
    message: `${title} metrics for ${symbol} not computed: ${[...labelsByCause]
      .map(([cause, labels]) => `${labels.join(", ")} ${cause}`)
      .join("; ")}`,
    symbol,
    provider: "market-bot",
    capability: "extended-evidence",
    cause: missing.some((metric) => metric.cause !== "outside-price-history-window")
      ? "provider-data-missing"
      : "suppressed-by-design",
    evidenceQualityImpact: "no-cap",
    triage: material ? "material" : "diagnostic",
  });
}

// Evaluates each definition in order; every non-value metric is listed in one section Source Gap.
export function evaluateMetricSection(
  id: string,
  title: string,
  definitions: readonly MetricDefinition[],
  ctx: MetricContext,
): { readonly section: MetricSection; readonly sourceGaps: readonly SourceGap[] } {
  const metrics = definitions.map((definition) => evaluateMetric(definition, ctx));
  const unresolved = metrics.filter((metric) => metric.status !== "value");
  const symbol = ctx.symbol.toUpperCase();
  return {
    section: { id, title, metrics },
    sourceGaps: unresolved.length === 0 ? [] : [sectionGap(id, title, symbol, unresolved)],
  };
}
