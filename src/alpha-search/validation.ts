import type { ResearchReport } from "../domain/types";
import type { Observation, ObservationRepository } from "../scoring/observations";
import type { AlphaSearchDiscoverySource } from "./candidates";
import { readAlphaSearchLeads, type AlphaSearchLead } from "./report-extras";

export const ALPHA_VALIDATION_BENCHMARK_SYMBOL = "IWM";
export const ALPHA_VALIDATION_HORIZONS = [5, 20] as const;

export type AlphaValidationOutcome = "outperformed" | "did-not-outperform";
export type AlphaValidationUnresolvedReason = "horizon-not-elapsed" | "observation-unavailable";
export type AlphaValidationSourceGroup = "apewisdom-only" | "sec-only" | "apewisdom+sec";

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

export interface AlphaValidationOptions {
  readonly report: ResearchReport;
  readonly repository: ObservationRepository;
  readonly now?: Date;
  readonly benchmarkSymbol?: string;
  readonly horizons?: readonly number[];
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function isWeekday(date: Date): boolean {
  const dow = date.getDay();
  return dow !== 0 && dow !== 6;
}

function resolutionDate(generatedAt: string, horizonTradingDays: number): Date {
  let count = 0;
  let cursor = new Date(generatedAt);
  while (count < horizonTradingDays) {
    cursor = addDays(cursor, 1);
    if (isWeekday(cursor)) {
      count += 1;
    }
  }
  return cursor;
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
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

async function resolveLeadHorizon(input: {
  readonly lead: AlphaSearchLead;
  readonly report: ResearchReport;
  readonly repository: ObservationRepository;
  readonly now: Date;
  readonly benchmarkSymbol: string;
  readonly horizonTradingDays: number;
}): Promise<AlphaValidationHorizon> {
  const resolution = resolutionDate(input.report.generatedAt, input.horizonTradingDays);
  if (resolution > input.now) {
    return {
      status: "unresolved",
      horizonTradingDays: input.horizonTradingDays,
      benchmarkSymbol: input.benchmarkSymbol,
      reason: "horizon-not-elapsed",
    };
  }

  const from = new Date(input.report.generatedAt);
  const [candidateObservations, benchmarkObservations] = await Promise.all([
    input.repository.window(input.lead.symbol, "equity", from, input.now),
    input.repository.window(input.benchmarkSymbol, "equity", from, input.now),
  ]);
  const required = input.horizonTradingDays + 1;
  const candidateWindow = sortedWindow(candidateObservations, required);
  const benchmarkWindow = sortedWindow(benchmarkObservations, required);
  const missingInstruments = [
    ...(candidateWindow === undefined ? [input.lead.symbol] : []),
    ...(benchmarkWindow === undefined ? [input.benchmarkSymbol] : []),
  ];
  if (candidateWindow === undefined || benchmarkWindow === undefined) {
    return {
      status: "unresolved",
      horizonTradingDays: input.horizonTradingDays,
      benchmarkSymbol: input.benchmarkSymbol,
      reason: "observation-unavailable",
      ...(missingInstruments.length > 0 ? { missingInstruments } : {}),
    };
  }

  const candidateOrigin = candidateWindow[0] as Observation;
  const candidateHorizon = candidateWindow.at(-1) as Observation;
  const benchmarkOrigin = benchmarkWindow[0] as Observation;
  const benchmarkHorizon = benchmarkWindow.at(-1) as Observation;
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
  const leadResults = await Promise.all(
    leads.map(async (lead) => ({
      ...leadSnapshot(lead),
      sourceGroup: sourceGroup(lead.discoverySources),
      horizons: await Promise.all(
        horizons.map((horizonTradingDays) =>
          resolveLeadHorizon({
            lead,
            report: options.report,
            repository: options.repository,
            now,
            benchmarkSymbol,
            horizonTradingDays,
          }),
        ),
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
