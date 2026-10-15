import type { ExtendedEvidence, ExtendedEvidenceCategory } from "../../domain/evidence";
import { sourceGap } from "../../domain/source-gaps";
import type { SourceGap } from "../../domain/sources";
import type { CapitalOwnershipArtifact } from "./capital-ownership";
import type {
  FinancialStatementFact,
  FinancialStatementSeriesKey,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";
import type { LensValueUnit } from "./value-format";

type MetricStatus = "value" | "missing" | "not-meaningful" | "not-applicable";

export interface MetricInput {
  readonly label: string;
  readonly value: number | string;
  readonly artifact: "statements" | "capitalOwnership" | "quote" | "evidence";
  readonly series?: FinancialStatementSeriesKey | "stockBasedCompensation" | "marketCap";
  // Evidence inputs: the Extended Evidence item category and its metric key.
  readonly category?: ExtendedEvidenceCategory;
  readonly key?: string;
  readonly periodType?: "annual" | "interim" | "instant";
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly periodKey?: string;
  readonly unit: string;
  readonly currency?: string;
  readonly sourceIds: readonly string[];
}

interface MetricResult {
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
  readonly depositorySic?: string;
  readonly evidence?: ExtendedEvidence;
  readonly asOf?: string;
}

export type MetricOutcome =
  | {
      readonly status: "value";
      readonly value: number | string;
      readonly currency?: string;
      readonly periodEnd?: string;
      readonly periodMonths?: number;
      readonly inputs: readonly MetricInput[];
    }
  | {
      readonly status: "missing" | "not-meaningful";
      readonly reason: string;
      readonly periodEnd?: string;
      readonly inputs?: readonly MetricInput[];
    };

export function statementInput(
  fact: FinancialStatementFact,
  series: FinancialStatementSeriesKey,
  label: string,
): MetricInput {
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
  return {
    id,
    label,
    unit,
    basis,
    ...outcome,
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
  const missing = unresolved.some((metric) => metric.status === "missing");
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
    cause: missing ? "provider-data-missing" : "suppressed-by-design",
    evidenceQualityImpact: "no-cap",
    triage: missing ? "material" : "diagnostic",
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
