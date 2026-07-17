import type { ResearchReport } from "../domain/types";
import { resolutionDate } from "../scoring/exchange-calendar";
import type { Observation, ObservationRepository } from "../scoring/observations";
import type { AlphaSearchDiscoverySource } from "./candidates";
import { readAlphaSearchLeads, type AlphaSearchLead } from "./report-extras";

export const ALPHA_VALIDATION_BENCHMARK_SYMBOL = "IWM";
export const ALPHA_VALIDATION_HORIZONS = [5, 20] as const;

export type AlphaValidationOutcome = "outperformed" | "did-not-outperform";
export type AlphaValidationUnresolvedReason = "horizon-not-elapsed" | "observation-unavailable";
export type AlphaValidationSourceGroup = "apewisdom-only" | "sec-only" | "apewisdom+sec";
export type AlphaSourcePromotionStatus =
  | "blocked-prerequisite"
  | "insufficient-sample"
  | "promising"
  | "mixed"
  | "weak";

export interface AlphaSourcePromotionThresholds {
  readonly minimumResolvedCount: number;
  readonly promisingHitRate: number;
  readonly weakHitRate: number;
}

export interface AlphaSourcePromotionPrerequisites {
  readonly status: "met" | "blocked";
  readonly providerHealthStatus?: "pass" | "warn" | "fail" | "unavailable";
  readonly blockingIssueCount?: number;
  readonly unmetRequiredCoverage: readonly string[];
}

export interface AlphaSourcePromotionCriterion {
  readonly status: AlphaSourcePromotionStatus;
  readonly reason: string;
  readonly resolvedCount: number;
  readonly hitRate?: number;
  readonly averageExcessReturn?: number;
}

export interface AlphaSourcePromotionCriteria {
  readonly thresholds: AlphaSourcePromotionThresholds;
  readonly prerequisites: AlphaSourcePromotionPrerequisites;
  readonly bySourceGroup: Partial<
    Readonly<
      Record<AlphaValidationSourceGroup, Readonly<Record<string, AlphaSourcePromotionCriterion>>>
    >
  >;
}

export interface AlphaValidationLeadSnapshot {
  readonly symbol: string;
  readonly name?: string;
  readonly discoverySources: readonly AlphaSearchDiscoverySource[];
  readonly socialRank?: number;
  readonly socialMomentumScore?: number;
  readonly sourceIds: readonly string[];
}

export interface AlphaValidationResolvedHorizon {
  readonly status: "resolved";
  readonly horizonTradingDays: number;
  readonly benchmarkSymbol: string;
  readonly candidateClose0: number;
  readonly candidateCloseN: number;
  readonly benchmarkClose0: number;
  readonly benchmarkCloseN: number;
  readonly candidateDate0: string;
  readonly candidateDateN: string;
  readonly benchmarkDate0: string;
  readonly benchmarkDateN: string;
  readonly candidateReturn: number;
  readonly benchmarkReturn: number;
  readonly excessReturn: number;
  readonly outcome: AlphaValidationOutcome;
}

export interface AlphaValidationUnresolvedHorizon {
  readonly status: "unresolved";
  readonly horizonTradingDays: number;
  readonly benchmarkSymbol: string;
  readonly reason: AlphaValidationUnresolvedReason;
  readonly missingInstruments?: readonly string[];
}

export type AlphaValidationHorizon =
  | AlphaValidationResolvedHorizon
  | AlphaValidationUnresolvedHorizon;

export interface AlphaValidationLeadResult extends AlphaValidationLeadSnapshot {
  readonly sourceGroup: AlphaValidationSourceGroup;
  readonly horizons: readonly AlphaValidationHorizon[];
}

export interface AlphaValidationFile {
  readonly runId: string;
  readonly validatedAt: string;
  readonly generatedAt: string;
  readonly benchmarkSymbol: string;
  readonly horizons: readonly number[];
  readonly leads: readonly AlphaValidationLeadResult[];
}

export interface AlphaValidationMetrics {
  readonly totalCount: number;
  readonly resolvedCount: number;
  readonly unresolvedCount: number;
  readonly outperformedCount: number;
  readonly hitRate?: number;
  readonly averageExcessReturn?: number;
}

export interface AlphaValidationSummary {
  readonly generatedAt: string;
  readonly benchmarkSymbol: string;
  readonly horizons: readonly number[];
  readonly runCount: number;
  readonly leadCount: number;
  readonly overall: Readonly<Record<string, AlphaValidationMetrics>>;
  readonly bySourceGroup: Partial<
    Readonly<Record<AlphaValidationSourceGroup, Readonly<Record<string, AlphaValidationMetrics>>>>
  >;
  readonly sourcePromotionCriteria: AlphaSourcePromotionCriteria;
}

export interface AlphaValidationPrerequisiteInput {
  readonly providerHealthStatus?: "pass" | "warn" | "fail" | "unavailable";
  readonly blockingIssueCount?: number;
  readonly unmetRequiredCoverage?: readonly string[];
}

export interface AlphaValidationOptions {
  readonly report: ResearchReport;
  readonly repository: ObservationRepository;
  readonly now?: Date;
  readonly benchmarkSymbol?: string;
  readonly horizons?: readonly number[];
  readonly existingValidation?: AlphaValidationFile;
}

export interface AlphaValidationCompletenessOptions {
  readonly report: ResearchReport;
  readonly validation: AlphaValidationFile | undefined;
  readonly benchmarkSymbol?: string;
  readonly horizons?: readonly number[];
}

interface MetricAccumulator {
  totalCount: number;
  resolvedCount: number;
  unresolvedCount: number;
  outperformedCount: number;
  excessReturnTotal: number;
}

const SOURCE_PROMOTION_THRESHOLDS: AlphaSourcePromotionThresholds = {
  minimumResolvedCount: 30,
  promisingHitRate: 0.55,
  weakHitRate: 0.45,
};

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function formatRate(value: number | undefined): string {
  return value === undefined ? "n/a" : `${String(Math.round(value * 1000) / 10)}%`;
}

function formatReturn(value: number | undefined): string {
  return value === undefined ? "n/a" : `${String(Math.round(value * 10_000) / 100)}%`;
}

function returnFrom(close0: number, closeN: number): number {
  return closeN / close0 - 1;
}

function sourceGroup(
  discoverySources: readonly AlphaSearchDiscoverySource[],
): AlphaValidationSourceGroup {
  const sources = new Set(discoverySources);
  if (sources.has("apewisdom") && sources.has("sec-filings")) {
    return "apewisdom+sec";
  }
  if (sources.has("sec-filings")) {
    return "sec-only";
  }
  return "apewisdom-only";
}

function leadSnapshot(lead: AlphaSearchLead): AlphaValidationLeadSnapshot {
  return {
    symbol: lead.symbol,
    ...(lead.name !== undefined ? { name: lead.name } : {}),
    discoverySources: lead.discoverySources,
    ...(lead.socialRank !== undefined ? { socialRank: lead.socialRank } : {}),
    ...(lead.socialMomentumScore !== undefined
      ? { socialMomentumScore: lead.socialMomentumScore }
      : {}),
    sourceIds: lead.sourceIds,
  };
}

function sortedWindow(
  observations: readonly Observation[],
  required: number,
): readonly Observation[] | undefined {
  const window = observations
    .filter((observation) => Number.isFinite(observation.value))
    .toSorted((left, right) => left.date.localeCompare(right.date));
  return window.length < required ? undefined : window.slice(0, required);
}

function alignedWindows(input: {
  readonly candidateObservations: readonly Observation[];
  readonly benchmarkObservations: readonly Observation[];
  readonly required: number;
}):
  | {
      readonly candidateWindow: readonly Observation[];
      readonly benchmarkWindow: readonly Observation[];
    }
  | undefined {
  const candidateWindow = sortedWindow(input.candidateObservations, input.required);
  const benchmarkWindow = sortedWindow(input.benchmarkObservations, input.required);
  const candidateByDate = new Map(
    input.candidateObservations
      .filter((observation) => Number.isFinite(observation.value))
      .map((observation) => [observation.date, observation]),
  );
  const benchmarkByDate = new Map(
    input.benchmarkObservations
      .filter((observation) => Number.isFinite(observation.value))
      .map((observation) => [observation.date, observation]),
  );
  const commonDates = [...candidateByDate.keys()]
    .filter((date) => benchmarkByDate.has(date))
    .toSorted();

  if (
    candidateWindow === undefined ||
    benchmarkWindow === undefined ||
    commonDates.length < input.required
  ) {
    return;
  }

  const dates = commonDates.slice(0, input.required);
  return {
    candidateWindow: dates.map((date) => candidateByDate.get(date) as Observation),
    benchmarkWindow: dates.map((date) => benchmarkByDate.get(date) as Observation),
  };
}

function existingResolvedHorizon(
  validation: AlphaValidationFile | undefined,
  symbol: string,
  horizonTradingDays: number,
  benchmarkSymbol: string,
): AlphaValidationResolvedHorizon | undefined {
  const horizon = validation?.leads
    .find((lead) => lead.symbol === symbol)
    ?.horizons.find(
      (candidate) =>
        candidate.horizonTradingDays === horizonTradingDays &&
        candidate.benchmarkSymbol === benchmarkSymbol,
    );
  return horizon?.status === "resolved" ? horizon : undefined;
}

function unresolvedHorizon(input: {
  readonly horizonTradingDays: number;
  readonly benchmarkSymbol: string;
  readonly reason: AlphaValidationUnresolvedReason;
  readonly missingInstruments?: readonly string[];
}): AlphaValidationUnresolvedHorizon {
  return {
    status: "unresolved",
    horizonTradingDays: input.horizonTradingDays,
    benchmarkSymbol: input.benchmarkSymbol,
    reason: input.reason,
    ...(input.missingInstruments !== undefined && input.missingInstruments.length > 0
      ? { missingInstruments: input.missingInstruments }
      : {}),
  };
}

function resolveLeadHorizon(input: {
  readonly lead: AlphaSearchLead;
  readonly report: ResearchReport;
  readonly now: Date;
  readonly benchmarkSymbol: string;
  readonly horizonTradingDays: number;
  readonly candidateObservations: readonly Observation[];
  readonly benchmarkObservations: readonly Observation[];
}): AlphaValidationHorizon {
  const resolution = resolutionDate(input.report.generatedAt, input.horizonTradingDays);
  if (resolution > input.now) {
    return unresolvedHorizon({
      horizonTradingDays: input.horizonTradingDays,
      benchmarkSymbol: input.benchmarkSymbol,
      reason: "horizon-not-elapsed",
    });
  }

  const required = input.horizonTradingDays + 1;
  const aligned = alignedWindows({
    candidateObservations: input.candidateObservations,
    benchmarkObservations: input.benchmarkObservations,
    required,
  });
  const candidateWindow = sortedWindow(input.candidateObservations, required);
  const benchmarkWindow = sortedWindow(input.benchmarkObservations, required);
  const missingInstruments = [
    ...(candidateWindow === undefined ? [input.lead.symbol] : []),
    ...(benchmarkWindow === undefined ? [input.benchmarkSymbol] : []),
  ];
  if (aligned === undefined) {
    return unresolvedHorizon({
      horizonTradingDays: input.horizonTradingDays,
      benchmarkSymbol: input.benchmarkSymbol,
      reason: "observation-unavailable",
      missingInstruments,
    });
  }

  const candidateOrigin = aligned.candidateWindow[0] as Observation;
  const candidateHorizon = aligned.candidateWindow.at(-1) as Observation;
  const benchmarkOrigin = aligned.benchmarkWindow[0] as Observation;
  const benchmarkHorizon = aligned.benchmarkWindow.at(-1) as Observation;
  const candidateReturn = returnFrom(candidateOrigin.value, candidateHorizon.value);
  const benchmarkReturn = returnFrom(benchmarkOrigin.value, benchmarkHorizon.value);
  const excessReturn = candidateReturn - benchmarkReturn;

  return {
    status: "resolved",
    horizonTradingDays: input.horizonTradingDays,
    benchmarkSymbol: input.benchmarkSymbol,
    candidateClose0: candidateOrigin.value,
    candidateCloseN: candidateHorizon.value,
    benchmarkClose0: benchmarkOrigin.value,
    benchmarkCloseN: benchmarkHorizon.value,
    candidateDate0: candidateOrigin.date,
    candidateDateN: candidateHorizon.date,
    benchmarkDate0: benchmarkOrigin.date,
    benchmarkDateN: benchmarkHorizon.date,
    candidateReturn: roundMetric(candidateReturn),
    benchmarkReturn: roundMetric(benchmarkReturn),
    excessReturn: roundMetric(excessReturn),
    outcome: excessReturn > 0 ? "outperformed" : "did-not-outperform",
  };
}

export async function validateAlphaSearchReport(
  options: AlphaValidationOptions,
): Promise<AlphaValidationFile | undefined> {
  if (options.report.jobType !== "alpha-search") {
    return;
  }

  const leads = readAlphaSearchLeads(options.report.extras);
  if (leads.length === 0) {
    return;
  }

  const now = options.now ?? new Date();
  const benchmarkSymbol = options.benchmarkSymbol ?? ALPHA_VALIDATION_BENCHMARK_SYMBOL;
  const horizons = options.horizons ?? ALPHA_VALIDATION_HORIZONS;
  const from = new Date(options.report.generatedAt);
  const observationWindows = new Map<string, Promise<readonly Observation[]>>();
  const observationsFor = (symbol: string): Promise<readonly Observation[]> => {
    const existing = observationWindows.get(symbol);
    if (existing !== undefined) {
      return existing;
    }
    const request = options.repository.window(symbol, "equity", from, now);
    observationWindows.set(symbol, request);
    return request;
  };

  const leadResults = await Promise.all(
    leads.map(async (lead) => ({
      ...leadSnapshot(lead),
      sourceGroup: sourceGroup(lead.discoverySources),
      horizons: await Promise.all(
        horizons.map(async (horizonTradingDays) => {
          const existing = existingResolvedHorizon(
            options.existingValidation,
            lead.symbol,
            horizonTradingDays,
            benchmarkSymbol,
          );
          if (existing !== undefined) {
            return existing;
          }

          const resolution = resolutionDate(options.report.generatedAt, horizonTradingDays);
          if (resolution > now) {
            return unresolvedHorizon({
              horizonTradingDays,
              benchmarkSymbol,
              reason: "horizon-not-elapsed",
            });
          }

          const [candidateObservations, benchmarkObservations] = await Promise.all([
            observationsFor(lead.symbol),
            observationsFor(benchmarkSymbol),
          ]);
          return resolveLeadHorizon({
            lead,
            report: options.report,
            now,
            benchmarkSymbol,
            horizonTradingDays,
            candidateObservations,
            benchmarkObservations,
          });
        }),
      ),
    })),
  );

  return {
    runId: options.report.runId,
    validatedAt: now.toISOString(),
    generatedAt: options.report.generatedAt,
    benchmarkSymbol,
    horizons,
    leads: leadResults,
  };
}

export function isAlphaValidationComplete(options: AlphaValidationCompletenessOptions): boolean {
  if (options.report.jobType !== "alpha-search" || options.validation === undefined) {
    return false;
  }

  const leads = readAlphaSearchLeads(options.report.extras);
  if (leads.length === 0) {
    return false;
  }

  const benchmarkSymbol = options.benchmarkSymbol ?? ALPHA_VALIDATION_BENCHMARK_SYMBOL;
  const horizons = options.horizons ?? ALPHA_VALIDATION_HORIZONS;
  if (
    options.validation.runId !== options.report.runId ||
    options.validation.generatedAt !== options.report.generatedAt ||
    options.validation.benchmarkSymbol !== benchmarkSymbol
  ) {
    return false;
  }

  return leads.every((lead) =>
    horizons.every(
      (horizonTradingDays) =>
        existingResolvedHorizon(
          options.validation,
          lead.symbol,
          horizonTradingDays,
          benchmarkSymbol,
        ) !== undefined,
    ),
  );
}

function emptyAccumulator(): MetricAccumulator {
  return {
    totalCount: 0,
    resolvedCount: 0,
    unresolvedCount: 0,
    outperformedCount: 0,
    excessReturnTotal: 0,
  };
}

function addHorizon(target: Map<number, MetricAccumulator>, horizon: AlphaValidationHorizon): void {
  const current = target.get(horizon.horizonTradingDays) ?? emptyAccumulator();
  current.totalCount += 1;
  if (horizon.status === "unresolved") {
    current.unresolvedCount += 1;
  } else {
    current.resolvedCount += 1;
    current.excessReturnTotal += horizon.excessReturn;
    if (horizon.outcome === "outperformed") {
      current.outperformedCount += 1;
    }
  }
  target.set(horizon.horizonTradingDays, current);
}

function metricFromAccumulator(accumulator: MetricAccumulator): AlphaValidationMetrics {
  return {
    totalCount: accumulator.totalCount,
    resolvedCount: accumulator.resolvedCount,
    unresolvedCount: accumulator.unresolvedCount,
    outperformedCount: accumulator.outperformedCount,
    ...(accumulator.resolvedCount > 0
      ? {
          hitRate: roundMetric(accumulator.outperformedCount / accumulator.resolvedCount),
          averageExcessReturn: roundMetric(
            accumulator.excessReturnTotal / accumulator.resolvedCount,
          ),
        }
      : {}),
  };
}

function metricsByHorizon(
  accumulators: ReadonlyMap<number, MetricAccumulator>,
): Readonly<Record<string, AlphaValidationMetrics>> {
  return Object.fromEntries(
    [...accumulators.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([horizon, accumulator]) => [String(horizon), metricFromAccumulator(accumulator)]),
  );
}

function sourcePromotionPrerequisites(
  input: AlphaValidationPrerequisiteInput | undefined,
): AlphaSourcePromotionPrerequisites {
  const unmetRequiredCoverage = input?.unmetRequiredCoverage ?? [];
  const blockingIssueCount = input?.blockingIssueCount ?? 0;
  const blocked =
    input?.providerHealthStatus === "fail" ||
    input?.providerHealthStatus === "unavailable" ||
    blockingIssueCount > 0 ||
    unmetRequiredCoverage.length > 0;
  return {
    status: blocked ? "blocked" : "met",
    ...(input?.providerHealthStatus !== undefined
      ? { providerHealthStatus: input.providerHealthStatus }
      : {}),
    ...(input?.blockingIssueCount !== undefined ? { blockingIssueCount } : {}),
    unmetRequiredCoverage,
  };
}

function sourcePromotionCriterion(
  metric: AlphaValidationMetrics,
  prerequisites: AlphaSourcePromotionPrerequisites,
): AlphaSourcePromotionCriterion {
  const base = {
    resolvedCount: metric.resolvedCount,
    ...(metric.hitRate !== undefined ? { hitRate: metric.hitRate } : {}),
    ...(metric.averageExcessReturn !== undefined
      ? { averageExcessReturn: metric.averageExcessReturn }
      : {}),
  };

  if (prerequisites.status === "blocked") {
    return {
      ...base,
      status: "blocked-prerequisite",
      reason: "Prerequisite validation is failing.",
    };
  }
  if (metric.resolvedCount < SOURCE_PROMOTION_THRESHOLDS.minimumResolvedCount) {
    return {
      ...base,
      status: "insufficient-sample",
      reason: "Resolved sample is below the source-promotion threshold.",
    };
  }
  if (
    (metric.hitRate ?? 0) >= SOURCE_PROMOTION_THRESHOLDS.promisingHitRate &&
    (metric.averageExcessReturn ?? 0) > 0
  ) {
    return {
      ...base,
      status: "promising",
      reason: "Hit rate and average excess return meet source-promotion thresholds.",
    };
  }
  if (
    (metric.hitRate ?? 0) <= SOURCE_PROMOTION_THRESHOLDS.weakHitRate &&
    (metric.averageExcessReturn ?? 0) < 0
  ) {
    return {
      ...base,
      status: "weak",
      reason: "Hit rate and average excess return are below source-promotion thresholds.",
    };
  }
  return {
    ...base,
    status: "mixed",
    reason: "Resolved outcomes do not meet promising or weak thresholds.",
  };
}

function buildSourcePromotionCriteria(
  bySourceGroup: AlphaValidationSummary["bySourceGroup"],
  prerequisiteInput: AlphaValidationPrerequisiteInput | undefined,
): AlphaSourcePromotionCriteria {
  const prerequisites = sourcePromotionPrerequisites(prerequisiteInput);
  return {
    thresholds: SOURCE_PROMOTION_THRESHOLDS,
    prerequisites,
    bySourceGroup: Object.fromEntries(
      Object.entries(bySourceGroup)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([group, metrics]) => [
          group,
          Object.fromEntries(
            Object.entries(metrics)
              .toSorted(([left], [right]) => Number(left) - Number(right))
              .map(([horizon, metric]) => [
                horizon,
                sourcePromotionCriterion(metric, prerequisites),
              ]),
          ),
        ]),
    ),
  };
}

export function buildAlphaValidationSummary(
  files: readonly AlphaValidationFile[],
  now: Date = new Date(),
  prerequisites?: AlphaValidationPrerequisiteInput,
): AlphaValidationSummary {
  const overall = new Map<number, MetricAccumulator>();
  const bySourceGroup = new Map<AlphaValidationSourceGroup, Map<number, MetricAccumulator>>();
  const horizons = new Set<number>();
  const benchmarkSymbol =
    files.find((file) => file.benchmarkSymbol !== "")?.benchmarkSymbol ??
    ALPHA_VALIDATION_BENCHMARK_SYMBOL;

  for (const file of files) {
    for (const horizon of file.horizons) {
      horizons.add(horizon);
    }
    for (const lead of file.leads) {
      const sourceMetrics = bySourceGroup.get(lead.sourceGroup) ?? new Map();
      for (const horizon of lead.horizons) {
        horizons.add(horizon.horizonTradingDays);
        addHorizon(overall, horizon);
        addHorizon(sourceMetrics, horizon);
      }
      bySourceGroup.set(lead.sourceGroup, sourceMetrics);
    }
  }

  const metricsBySourceGroup = Object.fromEntries(
    [...bySourceGroup.entries()]
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([group, metrics]) => [group, metricsByHorizon(metrics)]),
  );

  return {
    generatedAt: now.toISOString(),
    benchmarkSymbol,
    horizons: [...horizons].toSorted((left, right) => left - right),
    runCount: files.length,
    leadCount: files.reduce((total, file) => total + file.leads.length, 0),
    overall: metricsByHorizon(overall),
    bySourceGroup: metricsBySourceGroup,
    sourcePromotionCriteria: buildSourcePromotionCriteria(metricsBySourceGroup, prerequisites),
  };
}

function metricRows(metrics: Readonly<Record<string, AlphaValidationMetrics>>): readonly string[] {
  return Object.entries(metrics)
    .toSorted(([left], [right]) => Number(left) - Number(right))
    .map(([horizon, metric]) =>
      [
        horizon,
        String(metric.totalCount),
        String(metric.resolvedCount),
        String(metric.unresolvedCount),
        String(metric.outperformedCount),
        formatRate(metric.hitRate),
        formatReturn(metric.averageExcessReturn),
      ].join(" | "),
    );
}

function renderMetricTable(metrics: Readonly<Record<string, AlphaValidationMetrics>>): string {
  const rows = metricRows(metrics);
  if (rows.length === 0) {
    return "_No alpha validation outcomes yet._";
  }
  return [
    "Horizon | Total | Resolved | Unresolved | Outperformed | Hit rate | Avg excess return",
    "--- | ---: | ---: | ---: | ---: | ---: | ---:",
    ...rows,
  ].join("\n");
}

function criteriaRows(criteria: AlphaSourcePromotionCriteria["bySourceGroup"]): readonly string[] {
  return Object.entries(criteria)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([group, metrics]) =>
      Object.entries(metrics)
        .toSorted(([left], [right]) => Number(left) - Number(right))
        .map(([horizon, criterion]) =>
          [
            group,
            horizon,
            criterion.status,
            String(criterion.resolvedCount),
            formatRate(criterion.hitRate),
            formatReturn(criterion.averageExcessReturn),
            criterion.reason,
          ].join(" | "),
        ),
    );
}

function renderSourcePromotionCriteria(criteria: AlphaSourcePromotionCriteria): string {
  const rows = criteriaRows(criteria.bySourceGroup);
  const prereq = criteria.prerequisites;
  return [
    `Prerequisites: ${prereq.status}`,
    ...(prereq.providerHealthStatus !== undefined
      ? [`Provider health: ${prereq.providerHealthStatus}`]
      : []),
    ...(prereq.unmetRequiredCoverage.length > 0
      ? [`Unmet required coverage: ${prereq.unmetRequiredCoverage.join(", ")}`]
      : []),
    `Minimum resolved leads: ${String(criteria.thresholds.minimumResolvedCount)}`,
    `Promising threshold: hit rate >= ${formatRate(criteria.thresholds.promisingHitRate)} and avg excess return > 0%`,
    `Weak threshold: hit rate <= ${formatRate(criteria.thresholds.weakHitRate)} and avg excess return < 0%`,
    "",
    ...(rows.length === 0
      ? ["_No source-promotion criteria yet._"]
      : [
          "Source group | Horizon | Status | Resolved | Hit rate | Avg excess return | Reason",
          "--- | ---: | --- | ---: | ---: | ---: | ---",
          ...rows,
        ]),
  ].join("\n");
}

export function renderAlphaValidationSummaryMarkdown(summary: AlphaValidationSummary): string {
  const sourceGroups = Object.entries(summary.bySourceGroup).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return [
    "# Alpha Validation Summary",
    "",
    `Generated: ${summary.generatedAt}`,
    `Benchmark: ${summary.benchmarkSymbol}`,
    `Runs: ${String(summary.runCount)}`,
    `Leads: ${String(summary.leadCount)}`,
    "",
    "## Overall",
    "",
    renderMetricTable(summary.overall),
    "",
    "## By Source Group",
    "",
    ...(sourceGroups.length === 0
      ? ["_No source-group validation outcomes yet._"]
      : sourceGroups.flatMap(([group, metrics]) => [
          `### ${group}`,
          "",
          renderMetricTable(metrics),
          "",
        ])),
    "## Source Promotion Criteria",
    "",
    renderSourcePromotionCriteria(summary.sourcePromotionCriteria),
    "",
    "",
  ].join("\n");
}
