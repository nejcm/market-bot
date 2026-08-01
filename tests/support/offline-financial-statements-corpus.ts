import { isRecord } from "../../src/guards";
import { createHash } from "node:crypto";
import type { ExtendedEvidence, ExtendedEvidenceItem } from "../../src/domain/types";
import { withCanonicalFinancialLensInputs } from "../../src/sources/extended-evidence/financial-lens-canonical";
import {
  addFinancialLensEvidence,
  type FinancialLensArtifact,
  type FinancialLensMetric,
} from "../../src/sources/extended-evidence/financial-lens";
import {
  financialStatementFacts,
  financialStatementFactsAreCompatible,
  financialStatementPeriodMonths,
  financialStatementPeriodsYearAligned,
  financialStatementSeries,
  financialStatementSeriesByKey,
  latestCommonFinancialStatementFacts,
  latestCommonFinancialStatementPeriodEndFacts,
  latestFinancialStatementFact,
} from "../../src/sources/extended-evidence/financial-statement-selection";
import { deriveFinancialStatements } from "../../src/sources/extended-evidence/financial-statements";
import type {
  FinancialStatementFact,
  FinancialStatementSeriesKey,
  FinancialStatementsArtifact,
} from "../../src/sources/extended-evidence/financial-statements-contract";
import { deriveFundamentalHistoryFromFinancialStatements } from "../../src/sources/extended-evidence/fundamental-history-canonical";
import {
  deriveFundamentalHistory,
  type FundamentalHistoryArtifact,
  type FundamentalHistorySeries,
} from "../../src/sources/extended-evidence/fundamental-history";
import { summarizeSecFundamentals } from "../../src/sources/extended-evidence/sec-edgar";

export const OFFLINE_FINANCIAL_STATEMENT_FIXTURES = [
  "aapl",
  "msft",
  "mara",
  "nbis",
  "fpi-quarterly",
  "fpi-ifrs-semiannual",
] as const;

export type OfflineFinancialStatementFixtureId =
  (typeof OFFLINE_FINANCIAL_STATEMENT_FIXTURES)[number];

export interface OfflineFinancialStatementInput {
  readonly fixture: OfflineFinancialStatementFixtureId;
  readonly symbol: string;
  readonly analysisAsOf: string;
  readonly sourceId: string;
  readonly provenance: {
    readonly companyFacts: string;
    readonly submissions: string;
  };
  readonly companyFacts: unknown;
  readonly submissions: unknown;
}

interface ProjectedFact {
  readonly concept: string;
  readonly periodKey: string;
  readonly periodStart?: string;
  readonly periodEnd: string;
  readonly form: string;
  readonly filingDate: string;
  readonly accession: string | null;
  readonly value: number;
  readonly currency: string | null;
  readonly unit: string;
}

interface ProjectedStatementSeries {
  readonly selectedConcept: string | null;
  readonly selectedFact: ProjectedFact | null;
  readonly annual: readonly ProjectedFact[];
  readonly interim: readonly ProjectedFact[];
  readonly ttm: null | {
    readonly value: number;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly currency: string;
    readonly unit: string;
    readonly components: {
      readonly fiscalYear: ProjectedFact;
      readonly latestYearToDate: ProjectedFact;
      readonly priorYearToDate: ProjectedFact;
    };
  };
}

interface ProjectedLensMetric {
  readonly key: string;
  readonly label: string;
  readonly value: number | string;
  readonly unit: string;
  readonly sourceIds: readonly string[];
  readonly currency?: string;
  readonly periodEnd?: string;
  readonly periodMonths?: number;
}

interface ProjectedLens {
  readonly posture: string;
  readonly metrics: Readonly<Record<string, ProjectedLensMetric>>;
}

interface ProjectedHistorySeries {
  readonly concept: string | null;
  readonly annual: FundamentalHistorySeries["annual"];
  readonly ttm: FundamentalHistorySeries["ttm"] | null;
  readonly cagr: FundamentalHistorySeries["cagr"] | null;
  readonly marginChange: FundamentalHistorySeries["marginChange"] | null;
}

interface ProjectedConsumers {
  readonly fundamentalHistory: Readonly<Record<string, ProjectedHistorySeries>>;
  readonly financialLens: Readonly<Record<string, ProjectedLens>>;
}

export interface OfflineCorpusProjection {
  readonly fixture: OfflineFinancialStatementFixtureId;
  readonly symbol: string;
  readonly analysisAsOf: string;
  readonly taxonomy: string | null;
  readonly reportingCurrency: string | null;
  readonly interimCadence: string;
  readonly statements: Readonly<Record<string, ProjectedStatementSeries>>;
  readonly canonical: ProjectedConsumers;
  readonly legacy: ProjectedConsumers;
}

export interface OfflineCorpusDifference {
  readonly path: string;
  readonly canonical: unknown;
  readonly legacy: unknown;
}

export interface OfflineCorpusAllowance {
  readonly fixture: OfflineFinancialStatementFixtureId;
  readonly path: string;
  readonly canonicalSha256: string;
  readonly legacySha256: string;
  readonly kind:
    | "legacy-form-unsupported"
    | "canonical-exact-period-correction"
    | "selection-policy";
  readonly justification: string;
}

export interface OfflineCorpusExecution {
  readonly input: OfflineFinancialStatementInput;
  readonly artifact: FinancialStatementsArtifact;
  readonly projection: OfflineCorpusProjection;
  readonly differences: readonly OfflineCorpusDifference[];
}

function readRequiredString(value: Readonly<Record<string, unknown>>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field === "") {
    throw new Error(`Offline corpus input is missing ${key}`);
  }
  return field;
}

export async function loadOfflineFinancialStatementInput(
  fixture: OfflineFinancialStatementFixtureId,
): Promise<OfflineFinancialStatementInput> {
  const path = new URL(
    `../fixtures/financial-statements-corpus/${fixture}/input.json`,
    import.meta.url,
  );
  const value: unknown = await Bun.file(path).json();
  if (!isRecord(value) || !isRecord(value.provenance)) {
    throw new Error(`Invalid offline financial-statement fixture: ${fixture}`);
  }
  const fixtureValue = readRequiredString(value, "fixture");
  if (fixtureValue !== fixture) {
    throw new Error(`Offline fixture id mismatch: expected ${fixture}, received ${fixtureValue}`);
  }
  return {
    fixture,
    symbol: readRequiredString(value, "symbol"),
    analysisAsOf: readRequiredString(value, "analysisAsOf"),
    sourceId: readRequiredString(value, "sourceId"),
    provenance: {
      companyFacts: readRequiredString(value.provenance, "companyFacts"),
      submissions: readRequiredString(value.provenance, "submissions"),
    },
    companyFacts: value.companyFacts,
    submissions: value.submissions,
  };
}

export async function loadOfflineCorpusGolden(
  fixture: OfflineFinancialStatementFixtureId,
): Promise<OfflineCorpusProjection> {
  const path = new URL(
    `../fixtures/financial-statements-corpus/${fixture}/golden.json`,
    import.meta.url,
  );
  const value: unknown = await Bun.file(path).json();
  if (
    !isRecord(value) ||
    value.fixture !== fixture ||
    typeof value.symbol !== "string" ||
    !isRecord(value.statements) ||
    !isRecord(value.canonical) ||
    !isRecord(value.legacy)
  ) {
    throw new Error(`Invalid offline corpus golden: ${fixture}`);
  }
  return value as unknown as OfflineCorpusProjection;
}

export async function loadOfflineCorpusAllowances(): Promise<readonly OfflineCorpusAllowance[]> {
  const path = new URL("../fixtures/financial-statements-corpus/allowances.json", import.meta.url);
  const value: unknown = await Bun.file(path).json();
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        isRecord(item) &&
        OFFLINE_FINANCIAL_STATEMENT_FIXTURES.includes(
          item.fixture as OfflineFinancialStatementFixtureId,
        ) &&
        typeof item.path === "string" &&
        typeof item.canonicalSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(item.canonicalSha256) &&
        typeof item.legacySha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(item.legacySha256) &&
        (item.kind === "legacy-form-unsupported" ||
          item.kind === "canonical-exact-period-correction" ||
          item.kind === "selection-policy") &&
        typeof item.justification === "string" &&
        item.justification !== "",
    )
  ) {
    throw new Error("Invalid offline corpus allowances");
  }
  return value as OfflineCorpusAllowance[];
}

function projectFact(fact: FinancialStatementFact): ProjectedFact {
  return {
    concept: fact.concept,
    periodKey: fact.periodKey,
    ...(fact.periodStart !== undefined ? { periodStart: fact.periodStart } : {}),
    periodEnd: fact.periodEnd,
    form: fact.form,
    filingDate: fact.filedAt,
    accession: fact.accessionNumber,
    value: fact.value,
    currency: fact.currency,
    unit: fact.unit,
  };
}

function projectStatements(
  artifact: FinancialStatementsArtifact,
): Readonly<Record<string, ProjectedStatementSeries>> {
  return Object.fromEntries(
    financialStatementSeries(artifact).map((series) => {
      const selected = latestFinancialStatementFact(financialStatementFacts(series));
      return [
        series.key,
        {
          selectedConcept: selected?.concept ?? null,
          selectedFact: selected === undefined ? null : projectFact(selected),
          annual: series.annual.map(projectFact),
          interim: series.interim.map(projectFact),
          ttm:
            series.ttm === undefined
              ? null
              : {
                  value: series.ttm.value,
                  periodStart: series.ttm.periodStart,
                  periodEnd: series.ttm.periodEnd,
                  currency: series.ttm.currency,
                  unit: series.ttm.unit,
                  components: {
                    fiscalYear: projectFact(series.ttm.components.fiscalYear),
                    latestYearToDate: projectFact(series.ttm.components.latestYearToDate),
                    priorYearToDate: projectFact(series.ttm.components.priorYearToDate),
                  },
                },
        },
      ];
    }),
  );
}

function projectHistory(
  artifact: FundamentalHistoryArtifact,
): Readonly<Record<string, ProjectedHistorySeries>> {
  return Object.fromEntries(
    Object.entries(artifact.series).map(([key, series]) => [
      key,
      {
        concept: series.concept ?? null,
        annual: series.annual,
        ttm: series.ttm ?? null,
        cagr: series.cagr ?? null,
        marginChange: series.marginChange ?? null,
      },
    ]),
  );
}

function projectMetric(metric: FinancialLensMetric): ProjectedLensMetric {
  return {
    key: metric.key,
    label: metric.label,
    value: metric.value,
    unit: metric.unit,
    sourceIds: metric.sourceIds,
    ...(metric.currency !== undefined ? { currency: metric.currency } : {}),
    ...(metric.periodEnd !== undefined ? { periodEnd: metric.periodEnd } : {}),
    ...(metric.periodMonths !== undefined ? { periodMonths: metric.periodMonths } : {}),
  };
}

function projectLenses(
  artifact: FinancialLensArtifact | undefined,
): Readonly<Record<string, ProjectedLens>> {
  return Object.fromEntries(
    (artifact?.lenses ?? []).map((lens) => [
      lens.name,
      {
        posture: lens.posture,
        metrics: Object.fromEntries(
          lens.metrics.map((metric) => [metric.key, projectMetric(metric)]),
        ),
      },
    ]),
  );
}

function legacyEvidence(input: OfflineFinancialStatementInput): ExtendedEvidence {
  const summary = summarizeSecFundamentals(input.companyFacts, input.analysisAsOf);
  if (summary === undefined) {
    return { instrument: { symbol: input.symbol, assetClass: "equity" }, items: [], gaps: [] };
  }
  const item: ExtendedEvidenceItem = {
    category: "sec-edgar",
    title: `${input.symbol} SEC Fundamental Evidence`,
    summary: summary.summary,
    sourceIds: [input.sourceId],
    observedAt: input.analysisAsOf,
    metrics: summary.metrics,
  };
  return {
    instrument: { symbol: input.symbol, assetClass: "equity" },
    items: [item],
    gaps: summary.gaps,
  };
}

function deriveLens(
  input: OfflineFinancialStatementInput,
  evidence: ExtendedEvidence,
): FinancialLensArtifact | undefined {
  return addFinancialLensEvidence(
    { jobType: "equity", assetClass: "equity", symbol: input.symbol, depth: "deep" },
    [],
    evidence,
    undefined,
    input.analysisAsOf,
  ).artifact;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareField(
  differences: OfflineCorpusDifference[],
  path: string,
  canonical: unknown,
  legacy: unknown,
): void {
  if (!sameValue(canonical, legacy)) {
    differences.push({ path, canonical: canonical ?? null, legacy: legacy ?? null });
  }
}

function compareConsumers(
  canonical: ProjectedConsumers,
  legacy: ProjectedConsumers,
): readonly OfflineCorpusDifference[] {
  const differences: OfflineCorpusDifference[] = [];
  const historyKeys = [
    ...new Set([
      ...Object.keys(canonical.fundamentalHistory),
      ...Object.keys(legacy.fundamentalHistory),
    ]),
  ].toSorted();
  for (const key of historyKeys) {
    const current = canonical.fundamentalHistory[key];
    const previous = legacy.fundamentalHistory[key];
    for (const field of ["concept", "annual", "ttm", "cagr", "marginChange"] as const) {
      compareField(
        differences,
        `fundamentalHistory.${key}.${field}`,
        current?.[field],
        previous?.[field],
      );
    }
  }
  const lensNames = [
    ...new Set([...Object.keys(canonical.financialLens), ...Object.keys(legacy.financialLens)]),
  ].toSorted();
  for (const name of lensNames) {
    const current = canonical.financialLens[name];
    const previous = legacy.financialLens[name];
    compareField(differences, `financialLens.${name}.posture`, current?.posture, previous?.posture);
    const metricKeys = [
      ...new Set([...Object.keys(current?.metrics ?? {}), ...Object.keys(previous?.metrics ?? {})]),
    ].toSorted();
    for (const key of metricKeys) {
      compareField(
        differences,
        `financialLens.${name}.metrics.${key}`,
        current?.metrics[key],
        previous?.metrics[key],
      );
    }
  }
  return differences;
}

export function runOfflineFinancialStatementCorpus(
  input: OfflineFinancialStatementInput,
): OfflineCorpusExecution {
  const artifact = deriveFinancialStatements(input.companyFacts, {
    symbol: input.symbol,
    generatedAt: input.analysisAsOf,
    analysisAsOf: input.analysisAsOf,
    sourceId: input.sourceId,
    submissionsPayload: input.submissions,
    submissionsSourceId: `offline-sec-submissions-${input.fixture}`,
  });
  const legacy = legacyEvidence(input);
  const canonicalHistory = deriveFundamentalHistoryFromFinancialStatements(artifact);
  const legacyHistory = deriveFundamentalHistory(input.companyFacts, {
    symbol: input.symbol,
    generatedAt: input.analysisAsOf,
    analysisAsOf: input.analysisAsOf,
    sourceId: input.sourceId,
  });
  const canonicalConsumers: ProjectedConsumers = {
    fundamentalHistory: projectHistory(canonicalHistory),
    financialLens: projectLenses(
      deriveLens(input, withCanonicalFinancialLensInputs(legacy, artifact)),
    ),
  };
  const legacyConsumers: ProjectedConsumers = {
    fundamentalHistory: projectHistory(legacyHistory),
    financialLens: projectLenses(deriveLens(input, legacy)),
  };
  const projection: OfflineCorpusProjection = {
    fixture: input.fixture,
    symbol: input.symbol,
    analysisAsOf: input.analysisAsOf,
    taxonomy: artifact.taxonomy ?? null,
    reportingCurrency: artifact.reportingCurrency ?? null,
    interimCadence: artifact.interimCadence,
    statements: projectStatements(artifact),
    canonical: canonicalConsumers,
    legacy: legacyConsumers,
  };
  return {
    input,
    artifact,
    projection,
    differences: compareConsumers(canonicalConsumers, legacyConsumers),
  };
}

export function recompareOfflineCorpusProjection(
  execution: OfflineCorpusExecution,
  projection: OfflineCorpusProjection,
): OfflineCorpusExecution {
  return {
    ...execution,
    projection,
    differences: compareConsumers(projection.canonical, projection.legacy),
  };
}

function sourceContainsFact(input: OfflineFinancialStatementInput, fact: FinancialStatementFact) {
  if (!isRecord(input.companyFacts) || !isRecord(input.companyFacts.facts)) {
    return false;
  }
  const taxonomy = input.companyFacts.facts[fact.taxonomy];
  if (!isRecord(taxonomy)) {
    return false;
  }
  const concept = taxonomy[fact.concept];
  if (!isRecord(concept)) {
    return false;
  }
  const { units } = concept;
  const values = isRecord(units) ? units[fact.unit] : undefined;
  return (
    Array.isArray(values) &&
    values.some(
      (value) =>
        isRecord(value) &&
        value.val === fact.value &&
        value.form === fact.form &&
        value.filed === fact.filedAt &&
        value.start === fact.periodStart &&
        value.end === fact.periodEnd &&
        (value.accn ?? null) === fact.accessionNumber,
    )
  );
}

const EXACT_PERIOD_METRICS: Readonly<
  Record<
    string,
    readonly [FinancialStatementSeriesKey, FinancialStatementSeriesKey, "ratio" | "difference"]
  >
> = {
  grossMargin: ["grossProfit", "revenue", "ratio"],
  operatingMargin: ["operatingIncome", "revenue", "ratio"],
  netMargin: ["netIncome", "revenue", "ratio"],
  cashConversion: ["operatingCashFlow", "netIncome", "ratio"],
  freeCashFlowProxy: ["operatingCashFlow", "capitalExpenditure", "difference"],
  currentRatio: ["currentAssets", "currentLiabilities", "ratio"],
};

const EXACT_PERIOD_DELTAS: Readonly<Record<string, FinancialStatementSeriesKey>> = {
  revenueDeltaPercent: "revenue",
  grossProfitDeltaPercent: "grossProfit",
  operatingIncomeDeltaPercent: "operatingIncome",
  netIncomeDeltaPercent: "netIncome",
  dilutedEpsDeltaPercent: "dilutedEps",
  operatingCashFlowDeltaPercent: "operatingCashFlow",
};

const END_ALIGNED_BALANCE_RATIOS: Readonly<
  Record<string, readonly [FinancialStatementSeriesKey, FinancialStatementSeriesKey]>
> = {
  roa: ["netIncome", "totalAssets"],
  roe: ["netIncome", "stockholdersEquity"],
};

function verifyExactPeriodMetric(
  execution: OfflineCorpusExecution,
  allowance: OfflineCorpusAllowance,
  difference: OfflineCorpusDifference,
): boolean {
  const metricKey = allowance.path.split(".").at(-1);
  const definition = metricKey === undefined ? undefined : EXACT_PERIOD_METRICS[metricKey];
  if (metricKey === undefined || !isRecord(difference.canonical)) {
    return false;
  }
  const { value, periodEnd, periodMonths } = difference.canonical;
  if (typeof value !== "number" || typeof periodEnd !== "string") {
    return false;
  }
  const deltaSeriesKey = EXACT_PERIOD_DELTAS[metricKey];
  if (deltaSeriesKey !== undefined) {
    const series = financialStatementSeriesByKey(execution.artifact, deltaSeriesKey);
    const latest =
      series === undefined
        ? undefined
        : latestFinancialStatementFact(financialStatementFacts(series));
    if (latest === undefined) {
      return false;
    }
    const months = financialStatementPeriodMonths(latest);
    const prior = latestFinancialStatementFact(
      financialStatementFacts(series!).filter(
        (fact) =>
          fact.periodEnd < latest.periodEnd &&
          financialStatementPeriodMonths(fact) === months &&
          financialStatementPeriodsYearAligned(fact, latest) &&
          financialStatementFactsAreCompatible([fact, latest]),
      ),
    );
    if (prior === undefined || prior.value === 0) {
      return false;
    }
    const expected = ((latest.value - prior.value) / Math.abs(prior.value)) * 100;
    return (
      Math.abs(value - expected) <= Math.max(1, Math.abs(value), Math.abs(expected)) * 1e-12 &&
      periodEnd === latest.periodEnd &&
      (periodMonths === undefined || periodMonths === months) &&
      sourceContainsFact(execution.input, latest) &&
      sourceContainsFact(execution.input, prior)
    );
  }
  const balanceRatio = END_ALIGNED_BALANCE_RATIOS[metricKey];
  if (balanceRatio !== undefined) {
    const [flowKey, instantKey] = balanceRatio;
    const facts = latestCommonFinancialStatementPeriodEndFacts([
      financialStatementSeriesByKey(execution.artifact, flowKey),
      financialStatementSeriesByKey(execution.artifact, instantKey),
    ]);
    const flow = facts?.[0];
    const instant = facts?.[1];
    const months = flow === undefined ? undefined : financialStatementPeriodMonths(flow);
    const expected =
      flow === undefined ||
      instant === undefined ||
      instant.value === 0 ||
      months === undefined ||
      flow.periodEnd !== instant.periodEnd
        ? undefined
        : (flow.value * (12 / months)) / instant.value;
    return (
      expected !== undefined &&
      Math.abs(value - expected) <= Math.max(1, Math.abs(value), Math.abs(expected)) * 1e-12 &&
      periodEnd === flow!.periodEnd &&
      (periodMonths === undefined || periodMonths === months) &&
      sourceContainsFact(execution.input, flow!) &&
      sourceContainsFact(execution.input, instant!)
    );
  }
  if (definition === undefined) {
    return false;
  }
  const [leftKey, rightKey, operation] = definition;
  const facts = latestCommonFinancialStatementFacts([
    financialStatementSeriesByKey(execution.artifact, leftKey),
    financialStatementSeriesByKey(execution.artifact, rightKey),
  ]);
  if (facts === undefined || facts[0] === undefined || facts[1] === undefined) {
    return false;
  }
  if (operation === "ratio" && facts[1].value === 0) {
    return false;
  }
  const expectedValue =
    operation === "ratio" ? facts[0].value / facts[1].value : facts[0].value - facts[1].value;
  return (
    Math.abs(value - expectedValue) <=
      Math.max(1, Math.abs(value), Math.abs(expectedValue)) * 1e-12 &&
    periodEnd === facts[0].periodEnd &&
    (periodMonths === undefined || periodMonths === financialStatementPeriodMonths(facts[0])) &&
    facts.every((fact) => sourceContainsFact(execution.input, fact))
  );
}

function exactValueHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

function differenceKey(value: OfflineCorpusDifference): string {
  return JSON.stringify([
    value.path,
    exactValueHash(value.canonical),
    exactValueHash(value.legacy),
  ]);
}

function allowanceKey(value: OfflineCorpusAllowance): string {
  return JSON.stringify([value.path, value.canonicalSha256, value.legacySha256]);
}

export function classifyOfflineCorpusDifferences(
  execution: OfflineCorpusExecution,
  allowances: readonly OfflineCorpusAllowance[],
): { readonly matchedCount: number; readonly allowances: readonly OfflineCorpusAllowance[] } {
  const fixtureAllowances = allowances.filter(
    (allowance) => allowance.fixture === execution.input.fixture,
  );
  const byDifference = new Map(
    fixtureAllowances.map((allowance) => [allowanceKey(allowance), allowance]),
  );
  const classified = execution.differences.map((difference) => {
    const allowance = byDifference.get(differenceKey(difference));
    if (allowance === undefined) {
      throw new Error(
        `Offline comparator alarm: unclassified ${execution.input.fixture} difference ${difference.path}: ${JSON.stringify(difference)}`,
      );
    }
    if (
      allowance.kind === "canonical-exact-period-correction" &&
      !verifyExactPeriodMetric(execution, allowance, difference)
    ) {
      throw new Error(
        `Offline comparator alarm: ${execution.input.fixture} ${difference.path} is not reproduced by compatible exact-period source facts`,
      );
    }
    return allowance;
  });
  const used = new Set(classified.map((allowance) => allowanceKey(allowance)));
  const stale = fixtureAllowances.filter((allowance) => !used.has(allowanceKey(allowance)));
  if (stale.length > 0) {
    throw new Error(
      `Offline comparator alarm: stale ${execution.input.fixture} allowance(s): ${stale.map((item) => item.path).join(", ")}`,
    );
  }
  return {
    matchedCount:
      countComparableFields(execution.projection.canonical, execution.projection.legacy) -
      execution.differences.length,
    allowances: classified,
  };
}

function countComparableFields(canonical: ProjectedConsumers, legacy: ProjectedConsumers): number {
  let count =
    new Set([
      ...Object.keys(canonical.fundamentalHistory),
      ...Object.keys(legacy.fundamentalHistory),
    ]).size * 5;
  const lensNames = new Set([
    ...Object.keys(canonical.financialLens),
    ...Object.keys(legacy.financialLens),
  ]);
  for (const name of lensNames) {
    count += 1;
    count += new Set([
      ...Object.keys(canonical.financialLens[name]?.metrics ?? {}),
      ...Object.keys(legacy.financialLens[name]?.metrics ?? {}),
    ]).size;
  }
  return count;
}
