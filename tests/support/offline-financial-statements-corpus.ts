import { isRecord } from "../../src/guards";
import type { ExtendedEvidence, ExtendedEvidenceItem } from "../../src/domain/types";
import { withCanonicalFinancialLensInputs } from "../../src/sources/extended-evidence/financial-lens-canonical";
import {
  addFinancialLensEvidence,
  type FinancialLensArtifact,
  type FinancialLensMetric,
} from "../../src/sources/extended-evidence/financial-lens";
import {
  financialStatementFacts,
  financialStatementSeries,
  latestFinancialStatementFact,
} from "../../src/sources/extended-evidence/financial-statement-selection";
import { deriveFinancialStatements } from "../../src/sources/extended-evidence/financial-statements";
import type {
  FinancialStatementFact,
  FinancialStatementsArtifact,
} from "../../src/sources/extended-evidence/financial-statements-contract";
import { deriveFundamentalHistoryFromFinancialStatements } from "../../src/sources/extended-evidence/fundamental-history-canonical";
import {
  deriveFundamentalHistory,
  type FundamentalHistoryArtifact,
} from "../../src/sources/extended-evidence/fundamental-history";
import { summarizeSecFundamentals } from "../../src/sources/extended-evidence/sec-edgar";
import {
  allowanceKey,
  compareConsumers,
  countComparableFields,
  differenceKey,
  exactValueHash,
  type ProjectedConsumers,
  type ProjectedHistorySeries,
  type ProjectedLens,
  type ProjectedLensMetric,
} from "./offline-financial-corpus-compare";
import { verifyHistoryAllowanceProperties } from "./offline-financial-history-properties";
import { verifyLensAllowanceProperties } from "./offline-financial-lens-properties";

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
    | "selection-policy"
    | "history-property-not-rederivable";
  readonly justification: string;
}

export interface OfflineCorpusExecution {
  readonly input: OfflineFinancialStatementInput;
  readonly artifact: FinancialStatementsArtifact;
  readonly canonicalFinancialLensInputCategories: readonly string[];
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

async function loadOfflineFinancialStatementInput(
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

async function loadOfflineCorpusGolden(
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
    (value.legacy !== undefined && !isRecord(value.legacy))
  ) {
    throw new Error(`Invalid offline corpus golden: ${fixture}`);
  }
  // A golden without a legacy block asserts legacy === canonical (zero-difference fixtures).
  return {
    ...value,
    legacy: value.legacy ?? structuredClone(value.canonical),
  } as unknown as OfflineCorpusProjection;
}

async function loadOfflineCorpusAllowances(): Promise<readonly OfflineCorpusAllowance[]> {
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
          item.kind === "selection-policy" ||
          item.kind === "history-property-not-rederivable") &&
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

function runOfflineFinancialStatementCorpus(
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
  const canonicalFinancialLensEvidence = withCanonicalFinancialLensInputs(legacy, artifact);
  const canonicalHistory = deriveFundamentalHistoryFromFinancialStatements(artifact);
  const legacyHistory = deriveFundamentalHistory(input.companyFacts, {
    symbol: input.symbol,
    generatedAt: input.analysisAsOf,
    analysisAsOf: input.analysisAsOf,
    sourceId: input.sourceId,
  });
  const canonicalConsumers: ProjectedConsumers = {
    fundamentalHistory: projectHistory(canonicalHistory),
    financialLens: projectLenses(deriveLens(input, canonicalFinancialLensEvidence)),
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
    canonicalFinancialLensInputCategories: canonicalFinancialLensEvidence.items.map(
      (item) => item.category,
    ),
    projection,
    differences: compareConsumers(canonicalConsumers, legacyConsumers),
  };
}

function recompareOfflineCorpusProjection(
  execution: OfflineCorpusExecution,
  projection: OfflineCorpusProjection,
): OfflineCorpusExecution {
  return {
    ...execution,
    projection,
    differences: compareConsumers(projection.canonical, projection.legacy),
  };
}

function classifyOfflineCorpusDifferences(
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
    const historyVerification = allowance.path.startsWith("fundamentalHistory.")
      ? verifyHistoryAllowanceProperties(execution, allowance)
      : undefined;
    if (
      historyVerification !== undefined &&
      allowance.kind === "history-property-not-rederivable" &&
      historyVerification !== "not-rederivable"
    ) {
      throw new Error(
        `Offline comparator alarm: ${execution.input.fixture} ${difference.path} is not eligible for history-property reclassification`,
      );
    }
    if (
      historyVerification !== undefined &&
      allowance.kind !== "history-property-not-rederivable" &&
      historyVerification !== "verified"
    ) {
      throw new Error(
        `Offline comparator alarm: unclassified ${execution.input.fixture} difference ${difference.path}: fundamental-history property re-derivation ${historyVerification}`,
      );
    }
    if (
      historyVerification === undefined &&
      allowance.kind === "history-property-not-rederivable"
    ) {
      throw new Error(
        `Offline comparator alarm: ${execution.input.fixture} ${difference.path} is not a fundamental-history difference`,
      );
    }
    if (
      allowance.path.startsWith("financialLens.") &&
      !verifyLensAllowanceProperties(execution, allowance, difference)
    ) {
      throw new Error(
        `Offline comparator alarm: ${execution.input.fixture} ${difference.path} is not reproduced by financial-lens properties`,
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

// Pooling `.allowances` across every fixture reconstructs the full list; `golden` is stale after mutation (never recomputed).
export interface OfflineCorpusCase {
  readonly execution: OfflineCorpusExecution;
  readonly golden: OfflineCorpusProjection;
  readonly allowances: readonly OfflineCorpusAllowance[];
}

export async function loadOfflineCorpusCase(
  fixture: OfflineFinancialStatementFixtureId,
): Promise<OfflineCorpusCase> {
  const [input, golden, allAllowances] = await Promise.all([
    loadOfflineFinancialStatementInput(fixture),
    loadOfflineCorpusGolden(fixture),
    loadOfflineCorpusAllowances(),
  ]);
  return {
    execution: runOfflineFinancialStatementCorpus(input),
    golden,
    allowances: allAllowances.filter((allowance) => allowance.fixture === fixture),
  };
}

export type OfflineCorpusMutation =
  | readonly [path: string, operation: "set", value: unknown]
  | readonly [path: string, operation: "copy", sourcePath: string]
  | readonly [path: string, operation: "zero-margin-last", annualPath: string]
  | readonly [
      path: string,
      operation: "negate" | "increment" | "double" | "add-cent" | "last-only",
    ];

function readCanonicalPath(execution: OfflineCorpusExecution, path: string): unknown {
  let value: unknown = execution.projection.canonical;
  for (const segment of path.split(".")) {
    if (!isRecord(value)) {
      throw new Error(`Offline corpus mutation path is missing: ${path}`);
    }
    value = value[segment];
  }
  return value;
}

function requiredCanonicalNumber(execution: OfflineCorpusExecution, path: string): number {
  const value = readCanonicalPath(execution, path);
  if (typeof value !== "number") {
    throw new TypeError(`Offline corpus mutation number is missing: ${path}`);
  }
  return value;
}

function lastAnnualPoint(execution: OfflineCorpusExecution, path: string): Record<string, unknown> {
  const annual = readCanonicalPath(execution, path);
  const point = Array.isArray(annual) ? annual.at(-1) : undefined;
  if (!isRecord(point) || typeof point.periodEnd !== "string") {
    throw new Error(`Offline corpus golden is missing annual history: ${path}`);
  }
  return point;
}

function injectCanonicalMutations(
  execution: OfflineCorpusExecution,
  mutations: readonly OfflineCorpusMutation[],
): OfflineCorpusExecution {
  const projection = structuredClone(execution.projection);
  for (const mutation of mutations) {
    const [path, operation, operand] = mutation;
    const segments = path.split(".");
    const property = segments.pop();
    let target: unknown = projection.canonical;
    for (const segment of segments) {
      if (!isRecord(target)) {
        throw new Error(`Offline corpus mutation path is missing: ${path}`);
      }
      target = target[segment];
    }
    if (property === undefined || !isRecord(target)) {
      throw new Error(`Offline corpus mutation path is missing: ${path}`);
    }
    if (operation === "set") {
      target[property] = operand;
    } else if (operation === "copy") {
      target[property] = readCanonicalPath(execution, operand);
    } else if (operation === "last-only") {
      target[property] = [lastAnnualPoint(execution, path)];
    } else if (operation === "zero-margin-last") {
      const point = lastAnnualPoint(execution, operand);
      target[property] = {
        percentagePoints: 0,
        years: 0,
        periodStart: point.periodEnd,
        periodEnd: point.periodEnd,
      };
    } else {
      const value = requiredCanonicalNumber(execution, path);
      target[property] = {
        negate: -value,
        increment: value + 1,
        double: value * 2,
        "add-cent": value + 0.01,
      }[operation];
    }
  }
  return recompareOfflineCorpusProjection(execution, projection);
}

// No kind: regenerate only the canonical hash. Kind + existing allowance: reclassify, no hash touched. Kind + justification + no existing allowance: create one, hashing both sides fresh.
export interface OfflineCorpusAllowanceUpdate {
  readonly path: string;
  readonly kind?: OfflineCorpusAllowance["kind"];
  readonly justification?: string;
}

function applyAllowanceUpdates(
  execution: OfflineCorpusExecution,
  allowances: readonly OfflineCorpusAllowance[],
  updates: readonly OfflineCorpusAllowanceUpdate[],
): readonly OfflineCorpusAllowance[] {
  let result = allowances;
  for (const update of updates) {
    const existingIndex = result.findIndex((item) => item.path === update.path);
    const existing = existingIndex === -1 ? undefined : result[existingIndex];
    if (existing !== undefined && update.kind !== undefined) {
      result = result.with(existingIndex, {
        ...existing,
        kind: update.kind,
        justification: update.justification ?? existing.justification,
      });
      continue;
    }
    const difference = execution.differences.find((item) => item.path === update.path);
    if (difference === undefined) {
      throw new Error(`Fault spec: no difference at ${update.path} to back an allowance update`);
    }
    if (existing !== undefined) {
      result = result.with(existingIndex, {
        ...existing,
        canonicalSha256: exactValueHash(difference.canonical),
      });
      continue;
    }
    const { kind, justification } = update;
    if (kind === undefined || justification === undefined) {
      throw new Error(`Fault spec: ${update.path} update needs a kind and justification`);
    }
    result = [
      ...result,
      {
        fixture: execution.input.fixture,
        path: update.path,
        canonicalSha256: exactValueHash(difference.canonical),
        legacySha256: exactValueHash(difference.legacy),
        kind,
        justification,
      },
    ];
  }
  return result;
}

export interface OfflineCorpusFaultSpec {
  readonly input?: Partial<OfflineFinancialStatementInput>;
  readonly mutations?: readonly OfflineCorpusMutation[];
  readonly allowanceUpdates?: readonly OfflineCorpusAllowanceUpdate[];
}

export function mutateOfflineCorpusCase(
  corpusCase: OfflineCorpusCase,
  faultSpec: OfflineCorpusFaultSpec,
): OfflineCorpusCase {
  let { execution } = corpusCase;
  if (faultSpec.input !== undefined) {
    execution = runOfflineFinancialStatementCorpus({ ...execution.input, ...faultSpec.input });
  }
  if (faultSpec.mutations !== undefined && faultSpec.mutations.length > 0) {
    execution = injectCanonicalMutations(execution, faultSpec.mutations);
  }
  const allowances =
    faultSpec.allowanceUpdates === undefined
      ? corpusCase.allowances
      : applyAllowanceUpdates(execution, corpusCase.allowances, faultSpec.allowanceUpdates);
  return { ...corpusCase, execution, allowances };
}

export interface OfflineCorpusAudit {
  readonly matchedCount: number;
  readonly allowances: readonly OfflineCorpusAllowance[];
  readonly differences: readonly OfflineCorpusDifference[];
}

export function auditOfflineCorpusCase(corpusCase: OfflineCorpusCase): OfflineCorpusAudit {
  const classification = classifyOfflineCorpusDifferences(
    corpusCase.execution,
    corpusCase.allowances,
  );
  return { ...classification, differences: corpusCase.execution.differences };
}
