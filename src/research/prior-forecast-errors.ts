import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import { marketUpdateHorizonBucketOf } from "../domain/types";
import { instrumentsForExpression, observableForecastFromPrediction } from "../forecast/observable";
import type {
  HistoricalPredictionSummary,
  HistoricalResearchContext,
  HistoricalRunContext,
} from "./historical-context";
import type { ResearchContext } from "./research-context-types";
import {
  commandResearchSubjectIdentity,
  isSameResearchSubjectIdentity,
} from "./research-subject-identity";

const MAX_PRIOR_MISS_BULLETS = 5;

interface PriorMiss {
  readonly runId: string;
  readonly generatedAt: string;
  readonly claim: string;
  readonly probability: number;
  readonly sourceId: string;
  readonly evidence?: Record<string, number | string>;
}

function missFrom(run: HistoricalRunContext, prediction: HistoricalPredictionSummary): PriorMiss {
  return {
    runId: run.runId,
    generatedAt: run.generatedAt,
    claim: prediction.claim,
    probability: prediction.probability,
    sourceId: run.sourceId,
    ...(prediction.scoreEvidence !== undefined ? { evidence: prediction.scoreEvidence } : {}),
  };
}

function sortedRecentMisses(misses: readonly PriorMiss[]): readonly PriorMiss[] {
  return misses
    .toSorted(
      (left, right) => generatedAtValue(right.generatedAt) - generatedAtValue(left.generatedAt),
    )
    .slice(0, MAX_PRIOR_MISS_BULLETS);
}

function predictionInstrumentsInclude(
  prediction: HistoricalPredictionSummary,
  symbol: string,
): boolean {
  const forecast = observableForecastFromPrediction({
    id: prediction.id,
    claim: prediction.claim,
    kind: prediction.kind,
    subject: prediction.subject,
    measurableAs: prediction.measurableAs,
    horizonTradingDays: prediction.horizonTradingDays,
    probability: prediction.probability,
    sourceIds: [],
  });
  if (!("expression" in forecast)) {
    return false;
  }
  return instrumentsForExpression(forecast.expression).some(
    (instrument) => instrument.toUpperCase() === symbol,
  );
}

function collectPriorMisses(
  command: ResearchCommand,
  historicalContext: HistoricalResearchContext | undefined,
): readonly PriorMiss[] {
  if (!isInstrumentCommand(command) || historicalContext === undefined) {
    return [];
  }
  const symbol = command.symbol.toUpperCase();
  const misses: PriorMiss[] = [];
  for (const run of historicalContext.runs) {
    if (run.symbol?.toUpperCase() !== symbol) {
      continue;
    }
    for (const prediction of run.predictions) {
      if (prediction.scoreOutcome === "miss" && predictionInstrumentsInclude(prediction, symbol)) {
        misses.push(missFrom(run, prediction));
      }
    }
  }
  return sortedRecentMisses(misses);
}

function isConfiguredMarketSubject(subject: string, subjectKeys: ReadonlySet<string>): boolean {
  const subjectParts = subject
    .split(":")
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0);
  return subjectParts.length > 0 && subjectParts.every((part) => subjectKeys.has(part));
}

function historicalRunHorizonBucket(run: HistoricalRunContext): string | undefined {
  if (typeof run.keyExtras?.marketUpdateHorizonBucket === "string") {
    return run.keyExtras.marketUpdateHorizonBucket;
  }
  return marketUpdateHorizonBucketOf(run);
}

function collectMarketForecastMisses(
  command: ResearchCommand,
  historicalContext: HistoricalResearchContext | undefined,
  predictionSubjects: readonly string[],
): readonly PriorMiss[] {
  if (
    (command.jobType !== "market-overview" &&
      command.jobType !== "daily" &&
      command.jobType !== "weekly") ||
    historicalContext === undefined
  ) {
    return [];
  }
  const subjectKeys = new Set(predictionSubjects.map((subject) => subject.trim().toUpperCase()));
  const commandBucket = marketUpdateHorizonBucketOf(command);
  const misses: PriorMiss[] = [];
  for (const run of historicalContext.runs) {
    if (
      run.assetClass !== command.assetClass ||
      historicalRunHorizonBucket(run) !== commandBucket
    ) {
      continue;
    }
    for (const prediction of run.predictions) {
      if (
        prediction.scoreOutcome === "miss" &&
        isConfiguredMarketSubject(prediction.subject, subjectKeys)
      ) {
        misses.push(missFrom(run, prediction));
      }
    }
  }
  return sortedRecentMisses(misses);
}

function isSameResearchRun(run: HistoricalRunContext, command: ResearchCommand): boolean {
  if (command.jobType !== "research" || run.jobType !== "research") {
    return false;
  }
  return isSameResearchSubjectIdentity(commandResearchSubjectIdentity(command), run);
}

function collectResearchForecastMisses(
  command: ResearchCommand,
  historicalContext: HistoricalResearchContext | undefined,
): readonly PriorMiss[] {
  if (command.jobType !== "research" || historicalContext === undefined) {
    return [];
  }
  const proxy = commandResearchSubjectIdentity(command).predictionProxySymbol;
  if (proxy === undefined) {
    return [];
  }
  const misses: PriorMiss[] = [];
  for (const run of historicalContext.runs) {
    if (run.assetClass !== command.assetClass || !isSameResearchRun(run, command)) {
      continue;
    }
    for (const prediction of run.predictions) {
      if (prediction.scoreOutcome === "miss" && prediction.subject.toUpperCase() === proxy) {
        misses.push(missFrom(run, prediction));
      }
    }
  }
  return sortedRecentMisses(misses);
}

function generatedAtValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim();
}

function formatObservedEvidence(evidence: Record<string, number | string> | undefined): string {
  if (evidence === undefined) {
    return "";
  }
  const parts = Object.entries(evidence).map(([key, value]) => {
    const rendered =
      typeof value === "number" ? String(Math.round(value * 10_000) / 10_000) : singleLine(value);
    return `${singleLine(key)}=${rendered}`;
  });
  return parts.length === 0 ? "" : ` (observed ${parts.join(" ")})`;
}

function renderMissBullet(miss: PriorMiss): string {
  const date = miss.generatedAt.slice(0, 10);
  return `  - run ${miss.runId} (${date}): claimed "${singleLine(miss.claim)}" at stated p=${miss.probability.toFixed(2)}, resolved MISS${formatObservedEvidence(miss.evidence)} — cite ${miss.sourceId}`;
}

export function buildPriorThesisErrorBlock(
  command: ResearchCommand,
  historicalContext: HistoricalResearchContext | undefined,
): string | undefined {
  const misses = collectPriorMisses(command, historicalContext);
  if (misses.length === 0 || !isInstrumentCommand(command)) {
    return undefined;
  }
  const symbol = command.symbol.toUpperCase();
  return [
    `Prior predictions on ${symbol} that resolved MISS. Treat each as error-correction signal: diagnose why the prior thesis was wrong before restating a similar view, and widen probabilities where the same setup recurs.`,
    ...misses.map((miss) => renderMissBullet(miss)),
  ].join("\n");
}

export function buildMarketForecastErrorBlock(
  command: ResearchCommand,
  context: ResearchContext,
): string | undefined {
  const misses = collectMarketForecastMisses(
    command,
    context.historicalContext,
    context.depthProfile.predictionSubjects,
  );
  if (misses.length === 0) {
    return undefined;
  }
  return [
    `Prior market-overview forecasts on configured market subjects that resolved MISS. Treat each as error-correction signal: diagnose why the prior market read was wrong before restating a similar view, and widen probabilities where the same regime setup recurs.`,
    ...misses.map((miss) => renderMissBullet(miss)),
  ].join("\n");
}

export function buildResearchForecastErrorBlock(
  command: ResearchCommand,
  historicalContext: HistoricalResearchContext | undefined,
): string | undefined {
  const misses = collectResearchForecastMisses(command, historicalContext);
  if (misses.length === 0 || command.jobType !== "research") {
    return undefined;
  }
  const identity = commandResearchSubjectIdentity(command);
  const subjectKey = identity.subjectKey ?? command.subject;
  const proxy = identity.predictionProxySymbol;
  return [
    `Prior research forecasts on ${subjectKey}${proxy === undefined ? "" : ` (${proxy})`} that resolved MISS. Treat each as thematic error-correction signal: diagnose why the prior segment read was wrong before restating a similar view, and widen probabilities where the same subject setup recurs.`,
    ...misses.map((miss) => renderMissBullet(miss)),
  ].join("\n");
}
