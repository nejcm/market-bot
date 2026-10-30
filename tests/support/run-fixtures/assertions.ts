import {
  classifyLatestSession,
  readYahooRegularSession,
  splitAdjustedObservationsFromYahooChart,
} from "../../../src/sources/yahoo";
import { ledgerTotals } from "../../../src/model/call-ledger";
import type {
  ValuationFundamentalInput,
  ValuationMetricKey,
} from "../../../src/sources/extended-evidence/valuation-workbench-contract";
import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveMarketSnapshotPriceAsOf } from "../../../src/domain/market-data";
import { readEarningsForecastTelemetry } from "../../../src/forecast/earnings-eligibility";
import { claimKey, parseObservableExpression } from "../../../src/forecast/observable";
import { isRecord, readNumber, readString } from "../../../src/guards";
import type { ResearchReport } from "../../../src/domain/report";
import type { ModelRequest } from "../../../src/model/types";
import { projectEquityReader } from "../../../src/report/equity-reader";
import { readGapTriage } from "../../../src/report/gap-triage";
import { assertSafeReportLanguage, validateResearchReport } from "../../../src/report/schema";
import { renderMarkdownReport } from "../../../src/report/markdown";
import {
  assertNoUnresolvedMetricReferences,
  referenceMetricSections,
} from "../../../src/research/metric-references";
import { hasNoPriceHistory } from "../../../src/report/valuation-workbench-markdown";
import { RUN_ARTIFACT_FILES } from "../../../src/run-artifact-layout";
import { loadRunArtifact } from "../../../src/run-artifacts";
import { depositoryIssuerSic } from "../../../src/sources/extended-evidence/industry-classification";
import type { MetricSectionsExtra } from "../../../src/report/report-extras-contract";
import {
  canonicalizeSecForm,
  isAnnualReportForm,
  readSecFactPeriodMetadata,
  type FinancialStatementFact,
  type FinancialStatementSeriesKey,
  type FinancialStatementsArtifact,
  type FinancialStatementTaxonomy,
} from "../../../src/sources/extended-evidence/financial-statements-contract";
import {
  conceptScope,
  CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES,
  DEPRECIATION_AND_AMORTIZATION_COMPONENTS,
  DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE,
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
  MIN_ANNUAL_DURATION_MONTHS,
  MAX_ANNUAL_DURATION_MONTHS,
  isDebtPresenceConcept,
  scopedLabel,
} from "../../../src/sources/extended-evidence/financial-statement-definitions";
import {
  compareFinancialStatementFacts,
  financialStatementFacts,
  financialStatementSeriesByKey,
  financialStatementPeriodMonths,
} from "../../../src/sources/extended-evidence/financial-statement-selection";
import type { MetricInput } from "../../../src/sources/extended-evidence/metric-engine";
import { formatMetricValue } from "../../../src/sources/extended-evidence/value-format";
import {
  RANGE_REFERENCE_OUTSIDE_PROBABILITY,
  rangeReferenceBand,
  rangeReferenceOutsideProbability,
  rangeVolatilityReference,
} from "../../../src/research/range-volatility-reference";
import { deterministicSourceGaps } from "../../../src/research/deterministic-gaps";
import { deriveCanonicalInstrumentIdentity } from "../../../src/sources/instrument-identity";
import { isNewsRelevantByTitleOrSymbol } from "../../../src/sources/news-relevance";
import { isResearchCommand } from "../../../src/cli/args";
import { FORECAST_BASELINE_VERSION } from "../../../src/forecast/baseline";
import { eventGrid } from "../../../src/research/event-grid";
import { fixtureCommand, isDeepFixture, type FixtureMeta, type RunFixtureResult } from ".";
import { assertFinancialRunInvariants } from "./financial-invariants";

function asWritten(value: unknown): unknown {
  const written = JSON.stringify(value);
  return JSON.parse(written) as unknown;
}

// Assembly adds these after synthesis, so the synthesis prompt never sees them.
const FORECAST_BOOK_GAP_SOURCES = new Set([
  "event-grid",
  "forecast-baseline",
  "earnings-forecasts",
]);

export function assertMetricPromptCatalog(
  result: RunFixtureResult,
  meta: FixtureMeta,
  requests: readonly ModelRequest[],
): void {
  const command = fixtureCommand(meta);
  if (command.jobType !== "equity") {
    throw new Error("Metric catalog invariant requires an equity fixture");
  }
  for (const request of requests) {
    const user = request.messages.findLast(({ role }) => role === "user")!.content;
    const prompt = JSON.parse(user);
    if (
      ![
        "specialist-analysis",
        "instrument-evidence-analysis",
        "market-behavior-analysis",
        "critique",
        "final-synthesis",
      ].includes(prompt.stage)
    ) {
      continue;
    }
    const catalog = prompt.evidence.metricReferences as {
      id: string;
      defaults?: Record<string, unknown>;
      metrics: Record<string, unknown>[];
    }[];
    const sections = referenceMetricSections(result.collectedSources);
    expect(catalog.map(({ id }) => id)).toEqual(sections.map(({ id }) => id));
    expect(catalog.some(({ id }) => id === "market-session")).toBe(
      result.collectedSources.verifiedMarketSnapshot !== undefined,
    );
    for (const [index, section] of sections.entries()) {
      const projected = catalog[index]!;
      expect(projected.metrics).toHaveLength(section.metrics.length);
      for (const [rowIndex, metric] of section.metrics.entries()) {
        const {
          id,
          inputs: _inputs,
          reason: _reason,
          cause: _cause,
          change: _change,
          value,
          ...preserved
        } = metric;
        expect(asWritten({ ...projected.defaults, ...projected.metrics[rowIndex] })).toEqual(
          asWritten({
            ...preserved,
            reference: `<<metric:${section.id}.${id}>>`,
            ...(metric.status === "value"
              ? { value: formatMetricValue(value, metric.unit, metric.currency) }
              : {}),
          }),
        );
      }
    }
    expect(prompt.evidence.sourceGaps).toEqual(
      deterministicSourceGaps(command, {
        ...result.collectedSources,
        sourceGaps: result.collectedSources.sourceGaps.filter(
          ({ source }) => !FORECAST_BOOK_GAP_SOURCES.has(source),
        ),
      }),
    );
    expect(user).toBe(JSON.stringify(prompt));
  }
}

// Equity-aapl-brief's cassette carries controlled model gaps: the anchored options restatement
// Must disappear; every genuine gap (issuer/company estimates, peers, methodology, transcript) survives.
export function assertProviderGapRestatementsDropped(result: RunFixtureResult): void {
  const gaps = result.report.dataGaps;
  expect(gaps).not.toContain("Options IV evidence is unavailable.");
  expect(gaps).toContain("Issuer EPS estimates are not supplied.");
  expect(gaps).toContain("Company earnings per share estimates are not provided.");
  expect(gaps).toContain("Usable peers are unavailable.");
  expect(gaps).toContain("Peer comparisons are unavailable.");
  expect(gaps).toContain("Estimated dividends are not supplied.");
  expect(gaps).toContain("Consensus dividends are not available.");
  expect(gaps).toContain("Analyst estimate ranges are not supplied.");
  expect(gaps).toContain("Estimate ranges are not available.");
  expect(gaps).toContain("The methodology behind analyst estimates is missing.");
  expect(gaps).toContain(
    "Analyst estimates are not supplied, but the methodology behind the forward P/E is unspecified.",
  );
  expect(gaps).toContain("Issuer transcript unavailable.");
}

function assertForecastBookInvariants(result: RunFixtureResult, meta: FixtureMeta): void {
  const { report } = result;
  const command = fixtureCommand(meta);
  if (!isResearchCommand(command)) {
    throw new Error("Fixture command must be a research run");
  }
  const grid = eventGrid(command, result.collectedSources);
  const gridPredictions = report.predictions.filter(({ origin }) => origin === "grid");
  expect(report.predictions.every(({ origin }) => origin === "grid" || origin === "model")).toBe(
    true,
  );
  expect(result.analytics.predictions.gridCount).toBe(gridPredictions.length);
  for (const event of grid.events) {
    const issued = gridPredictions.find(({ id }) => id === event.id);
    if (issued === undefined) {
      expect(
        report.dataGaps.some((gap) => gap.startsWith("event-grid: ") && gap.includes(event.id)),
        `${event.id} neither issued nor declared`,
      ).toBe(true);
    } else {
      expect(issued.measurableAs).toBe(event.measurableAs);
      expect(result.markdown).toContain(`Event Grid: ${issued.claim}`);
    }
  }
  expect(gridPredictions.every(({ id }) => grid.events.some((event) => event.id === id))).toBe(
    true,
  );
  const knownSourceIds = new Set(report.sources.map((source) => source.id));
  const foldableKeys = new Set(
    grid.events
      .filter((event) => event.sourceIds.some((id) => knownSourceIds.has(id)))
      .map((event) => claimKey(event.measurableAs)),
  );
  expect(
    report.predictions.filter(
      ({ origin, measurableAs }) => origin === "model" && foldableKeys.has(claimKey(measurableAs)),
    ),
    "model prediction restates a grid event",
  ).toEqual([]);
  expect(report.dataGaps.filter((gap) => gap.includes("not issued separately"))).toEqual([]);
  for (const gap of report.dataGaps) {
    const source = gap.split(": ", 1)[0]!;
    if (FORECAST_BOOK_GAP_SOURCES.has(source)) {
      expect(readGapTriage(gap, result.collectedSources.sourceGaps), gap).toBe("diagnostic");
      expect(result.analytics.sourceFunnel.sourceGaps.bySource[source], gap).toBeGreaterThan(0);
    }
  }
  const earningsGateSuppressed =
    readEarningsForecastTelemetry(report)?.suppressionReason === "event-date-not-confirmed";
  expect(
    result.collectedSources.sourceGaps.some(
      ({ source, capability, triage }) =>
        source === "earnings-forecasts" &&
        capability === "forecast-book" &&
        triage === "diagnostic",
    ),
    "earnings-forecasts gap declared exactly when the gate suppresses",
  ).toBe(earningsGateSuppressed);
  expect(report.dataGaps.some((gap) => gap.startsWith("earnings-forecasts: "))).toBe(
    earningsGateSuppressed,
  );
  for (const prediction of report.predictions) {
    const expression = parseObservableExpression(prediction.measurableAs);
    if (prediction.baselineProbability !== undefined) {
      expect(prediction.baselineVersion).toBe(FORECAST_BASELINE_VERSION);
      expect(prediction.infoCutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    } else if (["range", "direction", "relative"].includes(expression.kind)) {
      expect(
        report.dataGaps.some(
          (gap) => gap.startsWith("forecast-baseline: ") && gap.includes(prediction.id),
        ),
        `${prediction.id} baseline neither stamped nor declared`,
      ).toBe(true);
    }
  }
}

export async function assertInvariants(
  result: RunFixtureResult,
  meta: FixtureMeta,
  fixtureName: string,
): Promise<void> {
  const { runDir } = result.artifacts;
  expect(await Bun.file(join(runDir, RUN_ARTIFACT_FILES.failure)).exists()).toBe(false);
  const loaded = await loadRunArtifact(runDir);
  expect(loaded.status.report).toBe("ok");
  // The reader rejects a bundle whose source ids do not resolve against the report.
  expect(loaded.status.evidenceBundle).toBe(isDeepFixture(meta) ? "ok" : undefined);
  const persisted = async (file: string): Promise<unknown> =>
    JSON.parse(await readFile(join(runDir, file), "utf8")) as unknown;
  const persistedReport = await persisted(RUN_ARTIFACT_FILES.report);
  expect(persistedReport).toEqual(asWritten(result.report));
  expect(asWritten(loaded.artifact?.report.predictions), "reader drops a Prediction field").toEqual(
    asWritten(result.report.predictions),
  );
  expect(await readFile(join(runDir, RUN_ARTIFACT_FILES.reportMarkdown), "utf8")).toBe(
    result.markdown,
  );
  expect(await persisted(RUN_ARTIFACT_FILES.analytics)).toEqual(asWritten(result.analytics));
  const command = fixtureCommand(meta);
  if (command.jobType === "equity" && result.collectedSources.newsAnalytics !== undefined) {
    const name = deriveCanonicalInstrumentIdentity(
      result.collectedSources.marketSnapshots,
      command.symbol,
    ).identity?.displayName;
    const targets = [
      {
        symbol: command.symbol,
        ...(name !== undefined ? { name } : {}),
        allowLowercaseSymbolMention: true,
      },
    ];
    expect(result.analytics.newsDedupe.floorEligibleSelectedCount).toBe(
      result.collectedSources.newsSources.filter((source) =>
        isNewsRelevantByTitleOrSymbol(source, targets),
      ).length,
    );
  } else {
    expect(result.analytics.newsDedupe).not.toHaveProperty("floorEligibleSelectedCount");
  }
  const modelPredictions = result.report.predictions.filter(({ origin }) => origin !== "grid");
  const citationClasses: Record<string, number> = {};
  for (const prediction of modelPredictions) {
    for (const id of prediction.sourceIds) {
      const kind = result.report.sources.find((source) => source.id === id)?.kind ?? "unknown";
      citationClasses[kind] = (citationClasses[kind] ?? 0) + 1;
    }
  }
  expect(result.analytics.predictions.citedSourceClasses).toEqual(citationClasses);
  expect(
    Object.values(result.analytics.predictions.citedSourceClasses).reduce(
      (total, count) => total + count,
      0,
    ),
  ).toBe(modelPredictions.reduce((total, prediction) => total + prediction.sourceIds.length, 0));
  expect(result.analytics.predictions.citedSourceClasses).not.toHaveProperty("unknown");
  const rangeSnapshot = result.collectedSources.verifiedMarketSnapshot;
  const reference = rangeVolatilityReference(rangeSnapshot);
  expect(result.analytics.predictions.nearBaseRateCount).toBe(
    modelPredictions.filter((prediction) => {
      const expression = parseObservableExpression(prediction.measurableAs);
      const band =
        reference !== undefined && !("gap" in reference)
          ? rangeReferenceBand(reference, prediction.horizonTradingDays)
          : undefined;
      const matchesReference =
        prediction.kind === "range" &&
        expression.kind === "range" &&
        expression.subject === rangeSnapshot?.symbol &&
        prediction.subject === rangeSnapshot?.symbol &&
        expression.horizonTradingDays === prediction.horizonTradingDays &&
        band !== undefined &&
        expression.lo === band[0] &&
        expression.hi === band[1];
      const centre =
        matchesReference && rangeSnapshot !== undefined && !("gap" in reference!)
          ? (rangeReferenceOutsideProbability(
              rangeSnapshot,
              reference!,
              prediction.horizonTradingDays,
            )?.probability ?? RANGE_REFERENCE_OUTSIDE_PROBABILITY)
          : 0.5;
      return Math.abs(prediction.probability - centre) <= 0.1 + Number.EPSILON;
    }).length,
  );
  expect(result.analytics.predictions).not.toHaveProperty("replacementAttempted");
  expect(result.trace).not.toHaveProperty("predictionReplacementAttempted");
  expect(result.analytics.providerEndpointAvailability).toHaveProperty("massiveNews");
  if (result.collectedSources.newsSources.some(({ provider }) => provider === "massive")) {
    expect(result.analytics.providerEndpointAvailability?.massiveNews?.status).toBe("available");
  }
  expect(await persisted(RUN_ARTIFACT_FILES.outcomes)).toEqual(asWritten(result.outcomes));
  if (result.deepEquityEvidenceBundle !== undefined) {
    expect(await persisted(RUN_ARTIFACT_FILES.evidenceBundle)).toEqual(
      asWritten(result.deepEquityEvidenceBundle),
    );
  }
  const { capitalOwnership } = result.collectedSources;
  if (capitalOwnership !== undefined) {
    for (const field of ["dilutedShares", "buybacks", "dividendsPaid"]) {
      expect(capitalOwnership).not.toHaveProperty(field);
      expect(loaded.artifact?.capitalOwnership).not.toHaveProperty(field);
    }
    expect(loaded.artifact?.capitalOwnership?.stockBasedCompensation).toEqual(
      capitalOwnership.stockBasedCompensation,
    );
  }
  const report = validateResearchReport(persistedReport as ResearchReport);
  assertNoUnresolvedMetricReferences(report, result.collectedSources);
  const marketSnapshot = result.collectedSources.marketSnapshots.find(
    (snapshot) =>
      snapshot.assetClass === report.assetClass &&
      snapshot.symbol.toUpperCase() === report.symbol?.toUpperCase(),
  );
  expect(result.markdown).toBe(
    renderMarkdownReport(report, marketSnapshot, result.collectedSources),
  );
  assertSafeReportLanguage(report);
  assertValuationWorkbenchInvariants(result, meta, fixtureName);
  assertMetricSectionInvariants(result, report);
  assertFinancialLensMetricInvariants(result, report, fixtureName);
  assertOperatingRatioInvariants(result, report);
  assertPricePerformanceInvariants(result, report);
  assertBusinessFrameworkMetricInvariants(result, report);
  expect(report.reportIntegrity, "integrity audit pruned report content").toBe("high");
  for (const prediction of report.predictions) {
    expect(() => parseObservableExpression(prediction.measurableAs)).not.toThrow();
  }
  const { targetCount } = result.analytics.predictions;
  expect(report.predictionShortfall).toEqual(
    modelPredictions.length < targetCount
      ? {
          emittedCount: modelPredictions.length,
          targetCount,
          missingCount: targetCount - modelPredictions.length,
        }
      : undefined,
  );
  assertForecastBookInvariants(result, meta);
  expect(result.markdown.match(/Research-only note/gu)?.length).toBe(1);
  // Two cassettes still return model spotlights; only market-update runs carry them (ADR 0003).
  expect(report.extras?.spotlights).toBeUndefined();
  expect(result.markdown).not.toContain("## Market Spotlights");
  expect(result.sourcePlan).toBeDefined();
  expect(result.evidenceLanes.summary.plannedLaneCount).toBeGreaterThan(0);
  expect(result.analytics.sourcePlan?.plannedLaneCount).toBeGreaterThan(0);
  expect(result.stageOutputs.every((output) => (output.durationMs ?? 0) > 0)).toBe(true);
  expect(result.trace.stageRecords?.every((record) => (record.durationMs ?? 0) > 0)).toBe(true);
  expect(result.analytics.runShape.stages.every((stage) => (stage.durationMs ?? 0) > 0)).toBe(true);
  // Every model call records usage; a cassette without it replays as explicit "unknown", never 0.
  expect(result.stageOutputs.every((output) => output.usage !== undefined)).toBe(true);
  // The provider-seam ledger sees every stage output's call plus collection calls with no output.
  const { modelCalls } = result.analytics.runShape;
  for (const stage of new Set(result.stageOutputs.map((output) => output.stage))) {
    expect(modelCalls.filter((call) => call.stage === stage).length).toBeGreaterThanOrEqual(
      result.stageOutputs.filter((output) => output.stage === stage).length,
    );
  }
  expect(
    modelCalls
      .filter((call) => call.stage === "web-gather" || call.stage === "evidence-request")
      .every((call) => /^round-\d+$/u.test(call.step ?? "")),
  ).toBe(true);
  expect(result.analytics.runShape.usageByStage.reduce((total, row) => total + row.calls, 0)).toBe(
    modelCalls.length,
  );
  expect(result.trace.tokenEstimate).toBe(ledgerTotals(modelCalls).tokenEstimate);
  if (isDeepFixture(meta)) {
    expect(result.stageOutputs.map((output) => output.stage)).toEqual(
      expect.arrayContaining(["instrument-evidence-analysis", "market-behavior-analysis"]),
    );
    if ((meta.challengerModels ?? []).length > 0) {
      expect(result.trace.forecastDisagreement?.challengerModelCount).toBe(
        meta.challengerModels?.length,
      );
    }
  }
  await assertFinancialRunInvariants(result, meta);
}

const DAY_MS = 86_400_000;
const RELATIVE_TOLERANCE = 1e-9;

function days(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / DAY_MS;
}

function expectClose(actual: unknown, expected: number, label: string): void {
  expect(typeof actual, label).toBe("number");
  expect(Math.abs((actual as number) - expected), label).toBeLessThanOrEqual(
    RELATIVE_TOLERANCE * Math.max(1, Math.abs(expected)),
  );
}

interface ResolvedInput {
  readonly value: number | string;
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly periodKey?: string;
  readonly periodType?: string;
  readonly currency?: string;
}

type MetricInvariantRun = Pick<
  RunFixtureResult,
  "collectedSources" | "markdown" | "deepEquityEvidenceBundle"
>;

function isAnnualSpan(
  resolved: Pick<ResolvedInput, "periodStart" | "periodEnd"> | undefined,
): boolean {
  const span = days(resolved?.periodStart ?? "", resolved?.periodEnd ?? "");
  return span >= 350 && span <= 380;
}

const FILED_VALUATION_KEYS = new Set(["annualizedRevenue", "netDebt"]);

// Valuation evidence also cites peers; a target figure cites its filing, plus the quote if price-relative.
function evidenceLineage(
  run: MetricInvariantRun,
  input: MetricInput,
  itemSourceIds: readonly string[],
): readonly string[] {
  if (input.category !== "valuation" || input.key === "valuationSupportability") {
    return itemSourceIds;
  }
  const { extendedEvidence, financialStatements, marketSnapshots } = run.collectedSources;
  const filed =
    financialStatements === undefined
      ? (extendedEvidence?.items.find(({ category }) => category === "sec-edgar")?.sourceIds ?? [])
      : [financialStatements.sourceId];
  const symbol = extendedEvidence?.instrument?.symbol.toUpperCase();
  const quote = marketSnapshots.find(
    (snapshot) => snapshot.assetClass === "equity" && snapshot.symbol.toUpperCase() === symbol,
  )?.sourceId;
  return FILED_VALUATION_KEYS.has(input.key ?? "") || quote === undefined
    ? filed
    : [quote, ...filed];
}

// Looks the input up in its own artifact; the input's lineage must equal what the artifact holds.
function resolveInput(
  run: MetricInvariantRun,
  input: MetricInput,
  label: string,
  annualFlowsOnly = true,
  strictLineage = true,
): ResolvedInput | undefined {
  const {
    financialStatements,
    capitalOwnership,
    marketSnapshots,
    resolvedInstrumentIdentity,
    extendedEvidence,
  } = run.collectedSources;
  let resolved: ResolvedInput | undefined = undefined;
  if (input.artifact === "statements" && input.series === undefined) {
    const fact = Object.values(financialStatements?.enterpriseValueBridge ?? {})
      .flat()
      .find(
        (candidate) =>
          candidate.concept === input.key &&
          candidate.periodKey === input.periodKey &&
          candidate.periodType === input.periodType,
      );
    const cashSeries = financialStatementSeriesByKey(financialStatements!, "cash");
    const cash =
      fact?.concept === "CashCashEquivalentsAndShortTermInvestments"
        ? [...(cashSeries?.annual ?? []), ...(cashSeries?.interim ?? [])].find(
            (candidate) => candidate.periodEnd === fact.periodEnd,
          )?.value
        : 0;
    resolved = fact &&
      cash !== undefined && {
        value: fact.value - cash,
        periodEnd: fact.periodEnd,
        periodKey: fact.periodKey,
        periodType: fact.periodType,
        ...(fact.currency !== null ? { currency: fact.currency } : {}),
      };
  } else if (input.artifact === "statements") {
    const series =
      financialStatements === undefined
        ? undefined
        : financialStatementSeriesByKey(
            financialStatements,
            input.series as FinancialStatementSeriesKey,
          );
    const fact = [...(series?.annual ?? []), ...(series?.interim ?? [])].find(
      (candidate) =>
        candidate.periodKey === input.periodKey && candidate.periodType === input.periodType,
    );
    resolved = fact && {
      value: fact.value,
      ...(fact.periodStart !== undefined ? { periodStart: fact.periodStart } : {}),
      periodEnd: fact.periodEnd,
      periodKey: fact.periodKey,
      periodType: fact.periodType,
      ...(fact.currency !== null ? { currency: fact.currency } : {}),
    };
    if (fact?.periodStart !== undefined) {
      if (annualFlowsOnly) {
        expect(fact.periodType, `${label} flow input is annual`).toBe("annual");
      }
      if (fact.periodType === "annual") {
        expect(isAnnualSpan(resolved), `${label} spans 350-380 days`).toBe(true);
      }
    }
  } else if (input.artifact === "evidence") {
    const item = extendedEvidence?.items.find(({ category }) => category === input.category);
    const value = item?.metrics?.[input.key ?? ""];
    resolved = value === undefined ? undefined : { value };
    expect(input.sourceIds, `${label} cites its own lineage`).toEqual(
      evidenceLineage(run, input, item?.sourceIds ?? []),
    );
  } else if (input.artifact === "capitalOwnership") {
    const fact = capitalOwnership?.stockBasedCompensation.find(
      (candidate) =>
        candidate.periodStart === input.periodStart && candidate.periodEnd === input.periodEnd,
    );
    resolved = fact && {
      value: fact.value,
      ...(fact.periodStart !== undefined ? { periodStart: fact.periodStart } : {}),
      periodEnd: fact.periodEnd,
      periodType: "annual",
      currency: fact.unit,
    };
    expect(isAnnualSpan(resolved), `${label} spans 350-380 days`).toBe(true);
  } else if (input.artifact === "verifiedSnapshot") {
    const snapshot = run.collectedSources.verifiedMarketSnapshot;
    const value =
      input.key === "latestClose"
        ? snapshot?.ohlcv.close
        : snapshot?.indicators?.[input.key as "sma50"];
    const periodEnd = snapshot?.latestSessionDate;
    resolved =
      value === undefined || value === null
        ? undefined
        : { value, ...(periodEnd !== undefined ? { periodEnd } : {}) };
  } else if (input.artifact === "subsequentFinancing") {
    const bridge = run.collectedSources.subsequentFinancing;
    resolved =
      bridge === undefined
        ? undefined
        : { value: bridge.events.filter((event) => !event.reconciled).length };
  } else {
    const snapshot = marketSnapshots.find((candidate) => candidate.sourceId === input.sourceIds[0]);
    const currency = resolvedInstrumentIdentity?.quoteCurrency ?? snapshot?.identity?.quoteCurrency;
    resolved =
      snapshot?.marketCap !== undefined
        ? {
            value: snapshot.marketCap,
            periodEnd: resolveMarketSnapshotPriceAsOf(snapshot).instant,
            ...(currency !== undefined ? { currency } : {}),
          }
        : undefined;
  }
  expect(resolved, `${label} resolves in ${input.artifact}`).toBeDefined();
  if (!strictLineage) {
    expect(resolved?.value, `${label} matches its artifact value`).toEqual(input.value);
    return resolved;
  }
  const lineage: Partial<ResolvedInput> = {
    value: input.value,
    ...(["periodStart", "periodEnd", "periodKey", "periodType", "currency"] as const).reduce(
      (fields, key) => (input[key] === undefined ? fields : { ...fields, [key]: input[key] }),
      {},
    ),
  };
  expect(lineage, `${label} lineage matches its artifact`).toEqual(
    resolved as Partial<ResolvedInput>,
  );
  return resolved;
}

function targetCompanyFacts(run: MetricInvariantRun): Record<string, unknown> | undefined {
  const cik = /CIK(\d+)\.json/u.exec(
    run.collectedSources.financialStatements?.sourceUrl ?? "",
  )?.[1];
  const payload = run.collectedSources.rawSnapshots.find(
    ({ adapter, payload: candidate }) =>
      adapter === "sec-companyfacts" &&
      isRecord(candidate) &&
      cik !== undefined &&
      Number(candidate.cik) === Number(cik),
  )?.payload;
  return isRecord(payload) && isRecord(payload.facts) ? payload.facts : undefined;
}

const CAPITAL_RETURN_INPUTS: Readonly<Record<string, readonly FinancialStatementSeriesKey[]>> = {
  buybacksLatestFy: ["shareRepurchases"],
  dividendsLatestFy: ["dividendsPaid"],
  shareCountChange1y: ["dilutedShares"],
  shareCountChange3y: ["dilutedShares"],
  shareCountChange5y: ["dilutedShares"],
  shareCountTrend: ["dilutedShares"],
  buybackYield: ["shareRepurchases"],
  dividendYieldFiled: ["dividendsPaid"],
  shareholderYield: ["dividendsPaid", "shareRepurchases"],
  fcfPayoutRatio: ["dividendsPaid", "operatingCashFlow", "capitalExpenditure"],
  totalPayoutToFcf: [
    "dividendsPaid",
    "shareRepurchases",
    "operatingCashFlow",
    "capitalExpenditure",
  ],
  dpsLatestFy: ["dividendsPerShare"],
  dpsCagr3y: ["dividendsPerShare"],
  dpsCagr5y: ["dividendsPerShare"],
  earliestDividendFyInHistory: ["dividendsPerShare"],
};

const FRAMEWORK_INPUTS: Readonly<Record<string, readonly FinancialStatementSeriesKey[]>> = {
  currentRatio: ["currentAssets", "currentLiabilities"],
  debtToMarketCap: ["debt"],
  revenue: ["revenue"],
  grossProfit: ["grossProfit"],
  operatingIncome: ["operatingIncome"],
  shareRepurchases: ["shareRepurchases"],
  revenueDeltaPercent: ["revenue"],
  operatingIncomeDeltaPercent: ["operatingIncome"],
  netIncomeDeltaPercent: ["netIncome"],
  grossMargin: ["grossProfit", "revenue"],
  operatingMargin: ["operatingIncome", "revenue"],
};

function rawFiledCount(
  facts: Record<string, unknown>,
  taxonomy: string,
  concept: string,
  cutoff: string,
): number {
  const root = isRecord(facts[taxonomy]) ? facts[taxonomy] : {};
  const units = isRecord(root[concept]) ? root[concept].units : undefined;
  return (isRecord(units) ? Object.values(units) : [])
    .flatMap((values) => (Array.isArray(values) ? values : []))
    .filter((fact) => {
      if (!isRecord(fact) || typeof fact.filed !== "string" || fact.filed <= cutoff) {
        return true;
      }
      const date = new Date(`${fact.filed}T00:00:00.000Z`);
      return (
        !/^\d{4}-\d{2}-\d{2}$/u.test(fact.filed) ||
        Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== fact.filed
      );
    }).length;
}

// A not-filed metric needs one of its own inputs unfiled (raw-checked) and no own input filed but filtered.
function assertNotFiledCause(
  run: MetricInvariantRun,
  label: string,
  required: readonly FinancialStatementSeriesKey[] | undefined,
  filedInputsFailure: (
    statements: FinancialStatementsArtifact,
    filed: readonly FinancialStatementSeriesKey[],
  ) => string | undefined,
): void {
  expect(required, `${label} not-filed needs known statement inputs`).toBeDefined();
  const statements = run.collectedSources.financialStatements;
  const unfiled = (required ?? []).filter((key) => statements?.unfiledSeries?.includes(key));
  expect(unfiled.length, `${label} not-filed needs one of its own inputs unfiled`).toBeGreaterThan(
    0,
  );
  const filed = (required ?? []).filter((key) => !unfiled.includes(key));
  if (statements !== undefined) {
    expect(filedInputsFailure(statements, filed), `${label} not-filed but filed inputs fail`).toBe(
      undefined,
    );
  }
  const facts = targetCompanyFacts(run);
  if (facts === undefined || statements === undefined) {
    return;
  }
  const cutoff = statements.analysisAsOf.slice(0, 10);
  for (const { key, concepts } of FINANCIAL_STATEMENT_SERIES_DEFINITIONS) {
    for (const [taxonomy, names] of unfiled.includes(key) ? Object.entries(concepts) : []) {
      const debtConcepts = Object.keys(isRecord(facts[taxonomy]) ? facts[taxonomy] : {}).filter(
        (concept) =>
          key === "debt" && isDebtPresenceConcept(taxonomy as FinancialStatementTaxonomy, concept),
      );
      for (const concept of [...names, ...debtConcepts]) {
        expect(
          rawFiledCount(facts, taxonomy, concept, cutoff),
          `${label}: ${key} unfiled but ${taxonomy}:${concept} has facts`,
        ).toBe(0);
      }
      if (key === "depreciationAndAmortization" && taxonomy === "us-gaap") {
        expect(
          DEPRECIATION_AND_AMORTIZATION_COMPONENTS.every((aliases) =>
            aliases.some((concept) => rawFiledCount(facts, taxonomy, concept, cutoff) > 0),
          ),
          `${label}: D&A unfiled but every component has facts`,
        ).toBe(false);
      }
    }
  }
}

function assertDepreciationAndAmortizationSelection(run: MetricInvariantRun): void {
  const statements = run.collectedSources.financialStatements;
  const root = targetCompanyFacts(run)?.["us-gaap"];
  if (statements === undefined || !isRecord(root)) {
    return;
  }
  const cutoff = statements.analysisAsOf.slice(0, 10);
  const series = statements.statements.cashFlowStatement.depreciationAndAmortization;
  const totals = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    ({ key }) => key === "depreciationAndAmortization",
  )!.concepts["us-gaap"];
  const unit = statements.reportingCurrency;
  const retainedEnds = new Set(
    Object.values(statements.statements)
      .flatMap((group) => Object.values(group))
      .filter((other) => other !== series)
      .flatMap((other) => other.annual.map(({ periodEnd }) => periodEnd)),
  );
  const annualRows = (concept: string) => {
    const units = isRecord(root[concept]) ? root[concept].units : undefined;
    const rows = isRecord(units) && unit !== undefined ? units[unit] : undefined;
    return (Array.isArray(rows) ? rows : []).filter(
      (row): row is Record<string, unknown> =>
        isRecord(row) &&
        readString(row, "form") === "10-K" &&
        (readString(row, "filed") ?? "") <= cutoff &&
        typeof row.start === "string" &&
        typeof row.end === "string" &&
        Date.parse(row.end) - Date.parse(row.start) > 300 * 86_400_000,
    );
  };
  const depreciationPeriods = new Set(
    [...annualRows("Depreciation"), ...annualRows("DepreciationNonproduction")].map(
      (row) => `${String(row.start)}|${String(row.end)}`,
    ),
  );
  for (const row of [
    ...annualRows("AmortizationOfIntangibleAssets"),
    ...CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES.flatMap(annualRows),
  ]) {
    const end = String(row.end);
    if (!retainedEnds.has(end) || !depreciationPeriods.has(`${String(row.start)}|${end}`)) {
      continue;
    }
    expect(
      series.annual.some((fact) => fact.periodEnd === end) ||
        statements.omissionNotes.some(
          (note) =>
            note.code === "incomplete-composite-series" &&
            note.seriesKey === "depreciationAndAmortization" &&
            note.periodKey?.endsWith(end),
        ),
      `D&A FY ending ${end} has filed components, so it is published or carries a gap`,
    ).toBe(true);
  }
  for (const fact of financialStatementFacts(series).filter(
    (item) => item.taxonomy === "us-gaap",
  )) {
    const { periodStart } = fact;
    if (periodStart === undefined) {
      continue;
    }
    const selectRawFact = (aliases: readonly string[]) => {
      const components = aliases.map((concept) => {
        const units = isRecord(root[concept]) ? root[concept].units : undefined;
        const rows = isRecord(units) ? units[fact.unit] : undefined;
        return (Array.isArray(rows) ? rows : []).flatMap((row) => {
          if (!isRecord(row)) {
            return [];
          }
          const value = readNumber(row, "val");
          const period = readSecFactPeriodMetadata(row);
          const form = canonicalizeSecForm(readString(row, "form") ?? "");
          const months = financialStatementPeriodMonths(fact) ?? 0;
          if (
            value === undefined ||
            period === undefined ||
            form === undefined ||
            row.start !== fact.periodStart ||
            period.end !== fact.periodEnd ||
            period.filed > cutoff ||
            (isAnnualReportForm(form.canonicalForm) &&
              months >= MIN_ANNUAL_DURATION_MONTHS &&
              months <= MAX_ANNUAL_DURATION_MONTHS) !==
              (fact.periodType === "annual")
          ) {
            return [];
          }
          return [
            {
              value,
              ...form,
              periodStart,
              periodEnd: period.end,
              filedAt: period.filed,
              accessionNumber: readString(row, "accn") ?? null,
            },
          ];
        });
      });
      return components
        .find((rows) => rows.length > 0)
        ?.toSorted(compareFinancialStatementFacts)[0];
    };
    const components = DEPRECIATION_AND_AMORTIZATION_COMPONENTS.flatMap((aliases) => {
      const component = selectRawFact(aliases);
      return component === undefined ? [] : [component];
    });
    const cashFlowLines = CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES.flatMap((concept) => {
      const line = selectRawFact([concept]);
      return line === undefined ? [] : [line.value];
    });
    const cashFlowSum = cashFlowLines.reduce((sum, value) => sum + value, 0);
    expect(
      cashFlowLines.length === 0 ||
        cashFlowSum - fact.value <=
          Math.abs(cashFlowSum) * DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE,
      `D&A ${fact.periodKey} must not fall below the filed cash-flow D&A lines`,
    ).toBe(true);
    if (fact.composite !== undefined) {
      const total = selectRawFact(totals);
      if (total !== undefined) {
        expect(
          components.some(
            (component) =>
              component.value - total.value >
              Math.abs(component.value) * DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE,
          ),
          `D&A ${fact.periodKey} must retain the combined fact within ${String(DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE * 100)}% component tolerance`,
        ).toBe(true);
      }
    } else {
      for (const component of components) {
        expect(
          component.value - fact.value,
          `D&A ${fact.periodKey} must dominate each selected component within ${String(DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE * 100)}% rounding tolerance`,
        ).toBeLessThanOrEqual(
          Math.abs(component.value) * DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE,
        );
      }
    }
  }
}

function annualFacts(
  statements: FinancialStatementsArtifact,
  key: FinancialStatementSeriesKey,
): readonly FinancialStatementFact[] {
  return (financialStatementSeriesByKey(statements, key)?.annual ?? []).filter(
    (fact) => fact.periodType === "annual" && isAnnualSpan(fact),
  );
}

// Next annual filing due: FY end + 16 months (month-end kept) + 7 days.
function annualFilingDue(periodEnd: string): string {
  const [year, month, day] = periodEnd.slice(0, 10).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const monthEnd = new Date(Date.UTC(year, month, 0)).getUTCDate() === day;
  const targetDays = new Date(Date.UTC(year, month + 16, 0)).getUTCDate();
  const due = Date.UTC(year, month + 15, monthEnd ? targetDays : Math.min(day, targetDays));
  return new Date(due + 7 * 86_400_000).toISOString().slice(0, 10);
}

const YIELD_METRICS = new Set(["buybackYield", "dividendYieldFiled", "shareholderYield"]);
const FCF_METRICS = new Set(["fcfPayoutRatio", "totalPayoutToFcf"]);
const MARGIN_METRICS = new Set(["grossMargin", "operatingMargin"]);

function quoteFailure(
  run: MetricInvariantRun,
  statements: FinancialStatementsArtifact,
  reportingCurrency: string | null | undefined,
): string | undefined {
  const snapshot = run.collectedSources.marketSnapshots.find(
    (candidate) =>
      candidate.assetClass === "equity" &&
      candidate.symbol.toUpperCase() === statements.symbol.toUpperCase(),
  );
  const currency =
    run.collectedSources.resolvedInstrumentIdentity?.quoteCurrency ??
    snapshot?.identity?.quoteCurrency;
  if (snapshot?.marketCap === undefined) {
    return "no quote market cap";
  }
  if (currency === undefined || currency !== (reportingCurrency ?? statements.reportingCurrency)) {
    return "quote currency differs from reporting";
  }
  return snapshot.marketCap <= 0 ? "market cap not positive" : undefined;
}

// Capital Return: filed inputs join on the first one's latest fresh year-aligned FY, then the metric's gates.
function capitalReturnFiledFailure(
  run: MetricInvariantRun,
  metricId: string,
  statements: FinancialStatementsArtifact,
  filed: readonly FinancialStatementSeriesKey[],
): string | undefined {
  const [anchorKey, ...joinedKeys] = filed;
  const anchor =
    anchorKey === undefined
      ? undefined
      : annualFacts(statements, anchorKey)
          .toSorted((left, right) => right.periodEnd.localeCompare(left.periodEnd))
          .at(0);
  if (anchorKey !== undefined && anchor === undefined) {
    return `no annual ${anchorKey}`;
  }
  if (
    anchor !== undefined &&
    statements.analysisAsOf.slice(0, 10) > annualFilingDue(anchor.periodEnd)
  ) {
    return `stale ${anchorKey}`;
  }
  const joined = new Map<FinancialStatementSeriesKey, FinancialStatementFact>(
    anchorKey === undefined || anchor === undefined ? [] : [[anchorKey, anchor]],
  );
  for (const key of joinedKeys) {
    const match = annualFacts(statements, key).find(
      (fact) => fact.periodEnd === anchor?.periodEnd && fact.periodStart === anchor.periodStart,
    );
    if (match === undefined) {
      return `no same-period ${key}`;
    }
    joined.set(key, match);
  }
  const ocf = joined.get("operatingCashFlow");
  const capex = joined.get("capitalExpenditure");
  if (FCF_METRICS.has(metricId) && ocf !== undefined && capex !== undefined) {
    if (capex.value < 0) {
      return "capital expenditure negative";
    }
    if (ocf.value - capex.value <= 0) {
      return "free cash flow not positive";
    }
  }
  return YIELD_METRICS.has(metricId) ? quoteFailure(run, statements, anchor?.currency) : undefined;
}

// Framework: each filed input needs a usable fact; a margin's lone filed denominator must be positive.
function frameworkFiledFailure(
  metricId: string,
  statements: FinancialStatementsArtifact,
  filed: readonly FinancialStatementSeriesKey[],
): string | undefined {
  const latest = (key: FinancialStatementSeriesKey) => {
    const series = financialStatementSeriesByKey(statements, key);
    return [...(series?.annual ?? []), ...(series?.interim ?? [])]
      .filter((fact) => fact.periodType === "interim" || isAnnualSpan(fact))
      .toSorted((left, right) => right.periodEnd.localeCompare(left.periodEnd))
      .at(0);
  };
  const unusable = filed.find((key) => latest(key) === undefined);
  if (unusable !== undefined) {
    return unusable;
  }
  const [denominatorKey] = filed;
  const denominator = denominatorKey === undefined ? undefined : latest(denominatorKey);
  return MARGIN_METRICS.has(metricId) &&
    filed.length === 1 &&
    denominatorKey === "revenue" &&
    (denominator?.value ?? 0) <= 0
    ? "denominator not positive"
    : undefined;
}

// Diagnostic iff every missing metric is not-filed, and each not-filed cause is checked against its own inputs.
function assertSectionGapTriage(
  run: MetricInvariantRun,
  id: string,
  metrics: MetricSectionsExtra[number]["metrics"],
): void {
  const missing = metrics.filter(({ status }) => status === "missing");
  if (missing.length === 0) {
    return;
  }
  const notFiled = missing.filter(({ cause }) => cause === "not-filed");
  expect(
    run.collectedSources.sourceGaps.find(({ source }) => source === id)?.triage,
    `${id} gap is diagnostic only when every missing metric is not-filed`,
  ).toBe(notFiled.length === missing.length ? "diagnostic" : "material");
  const capitalReturn = id === "capital-return";
  for (const metric of notFiled) {
    assertNotFiledCause(
      run,
      `${id}.${metric.id}`,
      (capitalReturn ? CAPITAL_RETURN_INPUTS : FRAMEWORK_INPUTS)[metric.id],
      (statements, filed) =>
        capitalReturn
          ? capitalReturnFiledFailure(run, String(metric.id), statements, filed)
          : frameworkFiledFailure(String(metric.id), statements, filed),
    );
  }
}

const LENS_SECTION_TITLES: Readonly<Record<string, string>> = {
  "financial-lens-quality": "Financial Lens: Quality",
  "financial-lens-growth": "Financial Lens: Growth",
  "financial-lens-financial-strength": "Financial Lens: Financial Strength",
  "financial-lens-value": "Financial Lens: Value",
  "financial-lens-momentum": "Financial Lens: Momentum",
};

const LENS_REQUIRED_METRICS: Readonly<Record<string, readonly string[]>> = {
  Quality: [
    "grossMargin",
    "operatingMargin",
    "netMargin",
    "freeCashFlowProxy",
    "cashConversion",
    "roe",
    "roa",
  ],
  Growth: [
    "revenueDeltaPercent",
    "grossProfitDeltaPercent",
    "operatingIncomeDeltaPercent",
    "netIncomeDeltaPercent",
    "dilutedEpsDeltaPercent",
    "continuingIncomeDeltaPercent",
    "continuingDilutedEpsDeltaPercent",
    "operatingCashFlowDeltaPercent",
    "capexDeltaPercent",
  ],
  "Financial Strength": [
    "cash",
    "debt",
    "netDebt",
    "debtToMarketCap",
    "netDebtToMarketCap",
    "currentRatio",
    "debtToEquity",
    "payoutRatio",
    "dividendYield",
  ],
  Value: ["pcfRatio"],
};

// The lens reads the latest reported period, so its statement inputs are annual or interim by design.
function lensRequiredMetricSeries(metric: string): string | undefined {
  if (metric === "pcfRatio") {
    return "operatingCashFlow";
  }
  if (metric !== "capexDeltaPercent" && metric.endsWith("DeltaPercent")) {
    return metric.replace("DeltaPercent", "");
  }
  return LENS_METRIC_SERIES[metric]?.[0];
}

const LENS_METRIC_SERIES: Readonly<Record<string, readonly FinancialStatementSeriesKey[]>> = {
  grossMargin: ["grossProfit", "revenue"],
  operatingMargin: ["operatingIncome", "revenue"],
  netMargin: ["netIncome", "revenue"],
  freeCashFlowProxy: ["operatingCashFlow", "capitalExpenditure"],
  capexDeltaPercent: ["capitalExpenditure"],
  cashConversion: ["operatingCashFlow", "netIncome"],
  roe: ["netIncome", "stockholdersEquity"],
  roa: ["netIncome", "totalAssets"],
  cash: ["cash"],
  debt: ["debt"],
  netDebt: ["debt", "cash"],
  currentRatio: ["currentAssets", "currentLiabilities"],
  debtToEquity: ["debt", "stockholdersEquity"],
  debtToMarketCap: ["debt"],
  netDebtToMarketCap: ["debt", "cash"],
  payoutRatio: ["dividendsPaid", "netIncome"],
};

const AAPL_LENS_VALUES = {
  grossMargin: 0.476_190_476_190_476_16,
  operatingMargin: 0.333_333_333_333_333_3,
  netMargin: 0.276_190_476_190_476_2,
  freeCashFlowProxy: 58_000_000_000,
  cashConversion: 1.120_689_655_172_413_7,
  revenueDeltaPercent: 11.111_111_111_111_11,
  grossProfitDeltaPercent: 13.636_363_636_363_635,
  operatingIncomeDeltaPercent: 16.666_666_666_666_664,
  netIncomeDeltaPercent: 16,
  dilutedEpsDeltaPercent: 18.749_999_999_999_99,
  operatingCashFlowDeltaPercent: 12.068_965_517_241_379,
  capexDeltaPercent: 16.666_666_666_666_664,
  cash: 60_000_000_000,
  debt: 100_000_000_000,
  netDebt: 40_000_000_000,
  debtToMarketCap: 0.033_333_333_333_333_33,
  netDebtToMarketCap: 0.013_333_333_333_333_334,
  enterpriseValue: 3_040_000_000_000,
  annualizedRevenue: 426_000_000_000,
  evToAnnualizedRevenue: 7.136_150_234_741_784,
  marketCapToAnnualizedRevenue: 7.042_253_521_126_761,
  valuationSupportability: "supported",
  peRatio: 31,
  forwardPe: 28,
  priceToBook: 45,
  pcfRatio: 23.076_923_076_923_077,
};

const EXPECTED_LENS_VALUES: Readonly<Record<string, Readonly<Record<string, number | string>>>> = {
  "equity-aapl-brief": {},
  "equity-aapl-deep": AAPL_LENS_VALUES,
  "equity-earnings-release-deep": {
    grossMargin: 0.490_678_098_677_945,
    operatingMargin: 0.336_022_088_226_656_8,
    netMargin: 0.278_474_133_885_173_06,
    freeCashFlowProxy: 110_197_000_000,
    cashConversion: 1.153_078_924_544_666,
    roe: 1.258_234_126_984_126_8,
    roa: 0.352_980_262_620_042_8,
    revenueDeltaPercent: 16.150_082_086_102_742,
    grossProfitDeltaPercent: 21.736_347_541_876_615,
    operatingIncomeDeltaPercent: 21.673_971_159_675_222,
    netIncomeDeltaPercent: 20.013_247_539_742_62,
    dilutedEpsDeltaPercent: 22.419_928_825_622_77,
    operatingCashFlowDeltaPercent: 43.107_370_893_167_31,
    capexDeltaPercent: -28.227_594_215_137_756,
    cash: 39_544_000_000,
    debt: 84_344_000_000,
    netDebt: 21_945_000_000,
    currentRatio: 1.003_294_804_655_585_8,
    debtToEquity: 0.784_449_404_761_904_7,
    payoutRatio: 0.116_080_580_304_344_4,
  },
  "equity-nbis-deep": {
    operatingMargin: -1.154_586_636_466_591,
    // FY2025 20-F (0001104659-26-052948): continuing income 9.8M / revenue 529.8M; total 82.5M adds 72.7M discontinued.
    netMargin: 0.018_497_546_243_865_61,
    // Continuing OCF 401.9M less capex 4,066.0M; the 384.8M total OCF nets 17.1M discontinued outflow.
    freeCashFlowProxy: -3_664_100_000,
    cashConversion: 41.010_204_081_632_65,
    roe: 0.017_958_206_356_116_675,
    roa: 0.006_636_847_778_868_277,
    revenueDeltaPercent: 479.016_393_442_622_9,
    operatingIncomeDeltaPercent: -53.078_078_078_078_07,
    netIncomeDeltaPercent: 112.862_488_306_828_81,
    dilutedEpsDeltaPercent: 114.473_684_210_526_33,
    continuingIncomeDeltaPercent: 102.784_090_909_090_9,
    continuingDilutedEpsDeltaPercent: 103.2,
    operatingCashFlowDeltaPercent: 248.907_002_593_553_2,
    capexDeltaPercent: 403.529_411_764_705_86,
    cash: 3_678_100_000,
    payoutRatio: 0,
    valuationCaveat:
      "Revenue multiples are not a valid basis for this issuer; the peer set is size/sector-comparable only.",
    evDateBasis: "EV mixes market cap (quote 2026-07-22) with cash/debt (balance sheet 2025-12-31)",
    enterpriseValue: 57_652_861_440,
    annualizedRevenue: 529_800_000,
    evToAnnualizedRevenue: 108.820_048_018_120_05,
    marketCapToAnnualizedRevenue: 107.971_425_896_564_74,
    valuationSupportability: "not-meaningful",
    peRatio: 87.325_584,
    forwardPe: "-139.64x (negative earnings)",
    epsForward: -1.613_41,
    priceToBook: 7.968_733_3,
    pcfRatio: 142.332_076_237_870_13,
  },
  "equity-fpi-quarterly": {
    grossMargin: 0.85,
    operatingMargin: 0.7,
    netMargin: 0.55,
    cashConversion: 1.090_909_090_909_090_8,
    roe: 0.987_179_487_179_487_3,
    roa: 0.592_307_692_307_692_4,
    revenueDeltaPercent: 40,
    grossProfitDeltaPercent: 40,
    operatingIncomeDeltaPercent: 40,
    netIncomeDeltaPercent: 40.000_000_000_000_02,
    dilutedEpsDeltaPercent: 40.000_000_000_000_01,
    operatingCashFlowDeltaPercent: 40,
    cash: 780_000_000,
    debt: 3_900_000_000,
    netDebt: 3_120_000_000,
    debtToMarketCap: 0.195,
    netDebtToMarketCap: 0.156,
    debtToEquity: 4.166_666_666_666_667,
    enterpriseValue: 23_120_000_000,
    annualizedRevenue: 1_620_000_000,
    evToAnnualizedRevenue: 14.271_604_938_271_604,
    marketCapToAnnualizedRevenue: 12.345_679_012_345_679,
    valuationSupportability: "screening-only",
    peRatio: 31,
    forwardPe: 28,
    priceToBook: 45,
    pcfRatio: 19.841_269_841_269_842,
  },
  "equity-fpi-ifrs-semiannual": {
    grossMargin: 0.85,
    operatingMargin: 0.7,
    netMargin: 0.55,
    cashConversion: 1.090_909_090_909_090_8,
    roe: 0.916_666_666_666_666_9,
    roa: 0.55,
    revenueDeltaPercent: 25,
    grossProfitDeltaPercent: 25,
    operatingIncomeDeltaPercent: 24.999_999_999_999_986,
    netIncomeDeltaPercent: 25.000_000_000_000_018,
    dilutedEpsDeltaPercent: 25,
    operatingCashFlowDeltaPercent: 25,
    cash: 750_000_000,
    debt: 3_750_000_000,
    debtToMarketCap: 0.1875,
    debtToEquity: 4.166_666_666_666_667,
    evDateBasis:
      "EV mixes market cap (fetch time 2026-06-15) with cash/debt (balance sheet 2025-12-31)",
    annualizedRevenue: 1_500_000_000,
    marketCapToAnnualizedRevenue: 13.333_333_333_333_334,
    valuationSupportability: "not-supportable",
    peRatio: 31,
    forwardPe: 28,
    priceToBook: 45,
    pcfRatio: 22.222_222_222_222_22,
  },
  "equity-analysis-comprehensive": AAPL_LENS_VALUES,
  "equity-analysis-estimated-suppressed": AAPL_LENS_VALUES,
  "equity-web-fallback-deep": AAPL_LENS_VALUES,
  "equity-depository-deep": {
    netMargin: 0.238_337_134_563_549_66,
    cashConversion: 5.600_260_983_036_103,
    roe: 0.103_300_307_789_085_85,
    roa: 0.006_230_440_948_008_068,
    revenueDeltaPercent: 2.923_602_219_376_867,
    netIncomeDeltaPercent: 131.520_644_511_581_08,
    dilutedEpsDeltaPercent: 162.121_212_121_212_1,
    operatingCashFlowDeltaPercent: 171.968_736_797_634_14,
    cash: 8_732_000_000,
    payoutRatio: 0.846_153_846_153_846_1,
    dividendYield: 3.57,
    peRatio: 17.603_848,
    forwardPe: 13.759_627,
    priceToBook: 1.805_705_2,
    pcfRatio: 2.166_909_186_485_437,
  },
  "equity-iren-deep": {},
  "equity-iren-brief": {},
};

export function assertFinancialLensMetricInvariants(
  run: MetricInvariantRun,
  report: ResearchReport,
  fixtureName: string,
): void {
  const sections = (
    (report.extras?.metricSections as MetricSectionsExtra | undefined) ?? []
  ).filter(({ id }) => id !== undefined && LENS_SECTION_TITLES[id] !== undefined);
  const pinnedValues = EXPECTED_LENS_VALUES[fixtureName];
  expect(pinnedValues, `${fixtureName} has pinned lens values`).toBeDefined();
  for (const [id, value] of Object.entries(pinnedValues!)) {
    expect(
      sections.flatMap((section) => section.metrics).find((row) => row.id === id),
      `${fixtureName}.${id} retains its replayed value`,
    ).toMatchObject({ status: "value", value });
  }
  const statements = run.collectedSources.financialStatements;
  const filedFacts =
    statements !== undefined &&
    Object.values({
      ...statements.statements.incomeStatement,
      ...statements.statements.balanceSheet,
      ...statements.statements.cashFlowStatement,
    }).some((series) => series.annual.length + series.interim.length > 0);
  if (filedFacts) {
    expect(sections.length, "filed statements imply lens Metric Sections").toBeGreaterThan(0);
  }
  for (const [id, title] of Object.entries(LENS_SECTION_TITLES)) {
    const section = sections.find((candidate) => candidate.id === id);
    const name = title.replace("Financial Lens: ", "");
    const required = LENS_REQUIRED_METRICS[name] ?? [];
    if (
      statements !== undefined &&
      required.some((metric) => {
        const key = lensRequiredMetricSeries(metric);
        const series =
          key === undefined
            ? undefined
            : financialStatementSeriesByKey(statements, key as FinancialStatementSeriesKey);
        return series !== undefined && series.annual.length + series.interim.length > 0;
      })
    ) {
      expect(section, `${name} filed inputs require its Metric Section`).toBeDefined();
    }
    expect(
      run.markdown.includes(`### ${title}\n`),
      `${title} markdown follows its Metric Section`,
    ).toBe(section !== undefined);
    if (section === undefined) {
      continue;
    }
    for (const metric of required) {
      expect(
        section.metrics.some(({ id: metricId }) => metricId === metric),
        `${name}.${metric} remains present`,
      ).toBe(true);
    }
    const projected = run.collectedSources.financialLenses?.lenses.find(
      (lens) => lens.name === name,
    );
    expect(projected, `${name} has its artifact lens`).toBeDefined();
    expect(
      projected?.metrics.map(({ key }) => key),
      `${name} projects every value row`,
    ).toEqual(
      section.metrics
        .filter(({ status }) => status === "value")
        .map(({ id: metricId }) => metricId),
    );
    const lensItem = run.collectedSources.extendedEvidence?.items.find(
      ({ category }) => category === "financial-lens",
    );

    for (const row of projected?.metrics ?? []) {
      expect(lensItem?.metrics?.[row.key], `${name}.${row.key} reaches Extended Evidence`).toEqual(
        row.value,
      );
      expect(
        lensItem?.metrics?.[`${row.key}PeriodEnd`],
        `${name}.${row.key} retains its period`,
      ).toBe(row.periodEnd);

      expect(
        section.metrics.find(({ id: metricId }) => metricId === row.key),
        `${name}.${row.key} matches its projection`,
      ).toMatchObject({
        status: "value",
        value: row.value,
        sourceIds: [...row.sourceIds],
        ...(row.periodEnd === undefined ? {} : { periodEnd: row.periodEnd }),
      });
    }
    expect(section.metrics.length, `${id} carries metrics`).toBeGreaterThan(0);
    const unresolved = section.metrics.filter(({ status }) => status !== "value");
    expect(
      report.dataGaps.some((gap) => gap.startsWith(`${id}: `)),
      `${id} surfaces its section gap`,
    ).toBe(unresolved.length > 0);
    if (unresolved.some(({ status }) => status === "missing")) {
      expect(
        run.collectedSources.sourceGaps.find(({ source }) => source === id)?.triage,
        `${id} gap is diagnostic only when every missing metric is not-filed`,
      ).toBe(
        unresolved
          .filter(({ status }) => status === "missing")
          .every(({ cause }) => cause === "not-filed")
          ? "diagnostic"
          : "material",
      );
    }
  }
  const reportSourceIds = new Set(report.sources.map(({ id }) => id));
  for (const section of sections) {
    const id = String(section.id);
    for (const metric of section.metrics) {
      const label = `${id}.${String(metric.id)}`;
      expect([...metric.sourceIds].toSorted(), `${label} retains every input citation`).toEqual(
        [...new Set(metric.inputs.flatMap(({ sourceIds }) => sourceIds))].toSorted(),
      );

      for (const sourceId of metric.sourceIds) {
        expect(reportSourceIds.has(sourceId), `${label} cites ${sourceId}`).toBe(true);
      }
      for (const input of metric.inputs) {
        resolveInput(run, input, `${label} ${input.label}`, false, input.artifact === "statements");
      }
      if (metric.status !== "value") {
        continue;
      }
      expect(
        (typeof metric.value === "number" && Number.isFinite(metric.value)) ||
          (typeof metric.value === "string" && metric.value !== ""),
        `${label} carries a finite number or non-empty text`,
      ).toBe(true);
      const metricId = String(metric.id);
      const resolved = metric.inputs.map((input) =>
        resolveInput(run, input, `${label} ${input.label}`, false, input.artifact === "statements"),
      );
      const statementFacts = resolved.filter(
        (_fact, index) => metric.inputs[index]?.artifact === "statements",
      );
      if (statementFacts.length > 0) {
        expect(metric.periodEnd, `${label} ends at its anchor period`).toBe(
          statementFacts
            .map((fact) => fact?.periodEnd ?? "")
            .toSorted()
            .at(-1),
        );
      }
      const durations = statementFacts.filter((fact) => fact?.periodStart !== undefined);
      // A YoY metric compares two adjacent periods of one series; every other join shares one period.
      if (!metricId.endsWith("DeltaPercent")) {
        expect(
          new Set(durations.map((fact) => `${String(fact?.periodKey)}/${String(fact?.periodType)}`))
            .size,
          `${label} flow inputs join one period`,
        ).toBeLessThanOrEqual(1);
      }
      const valueOf = (series: string): number =>
        Number(resolved[metric.inputs.findIndex((input) => input.series === series)]?.value);
      switch (metricId) {
        case "grossMargin":
        case "operatingMargin":
        case "netMargin": {
          const [defaultNumerator] = LENS_METRIC_SERIES[metricId] ?? [];
          const numerator =
            metricId === "netMargin" ? String(metric.inputs[0]?.series) : String(defaultNumerator);
          if (metricId === "netMargin") {
            expect(
              [
                "netIncome",
                "consolidatedNetIncome",
                "continuingIncome",
                "consolidatedContinuingIncome",
              ],
              `${label} uses an income numerator`,
            ).toContain(numerator);
            expect(metric.label.includes("continuing operations"), `${label} names its scope`).toBe(
              numerator.endsWith("ContinuingIncome") || numerator === "continuingIncome",
            );
          }
          expectClose(metric.value, valueOf(numerator) / valueOf("revenue"), label);
          break;
        }
        case "freeCashFlowProxy": {
          expect(
            valueOf("capitalExpenditure"),
            `${label} capex is a filed outflow`,
          ).toBeGreaterThanOrEqual(0);
          expectClose(
            metric.value,
            valueOf("operatingCashFlow") - valueOf("capitalExpenditure"),
            label,
          );
          break;
        }
        case "netDebt":
        case "netDebtToMarketCap": {
          const onMarketCap = metricId === "netDebtToMarketCap" ? valueOf("marketCap") : undefined;
          const shortTermInvestments = metric.inputs.findIndex(
            (input) => input.artifact === "statements" && input.series === undefined,
          );
          const netDebt =
            valueOf("debt") -
            valueOf("cash") -
            (shortTermInvestments === -1 ? 0 : Number(resolved[shortTermInvestments]?.value));
          expectClose(
            metric.value,
            onMarketCap === undefined ? netDebt : netDebt / onMarketCap,
            label,
          );
          break;
        }
        case "currentRatio": {
          expectClose(
            metric.value,
            valueOf("currentAssets") / valueOf("currentLiabilities"),
            label,
          );
          break;
        }
        case "debtToEquity": {
          expectClose(metric.value, valueOf("debt") / valueOf("stockholdersEquity"), label);
          break;
        }
        case "debtToMarketCap": {
          expectClose(metric.value, valueOf("debt") / valueOf("marketCap"), label);
          break;
        }
        case "payoutRatio": {
          if (!metric.inputs.some(({ series }) => series === "dividendsPaid")) {
            break;
          }
          expectClose(
            metric.value,
            Math.abs(valueOf("dividendsPaid")) / valueOf("netIncome"),
            label,
          );
          break;
        }
        case "cashConversion": {
          const incomeSeries = metric.inputs
            .map(({ series }) => series)
            .find((series) => series !== "operatingCashFlow");
          expectClose(
            metric.value,
            valueOf("operatingCashFlow") / valueOf(String(incomeSeries)),
            label,
          );
          break;
        }
        case "roe":
        case "roa": {
          const [numerator, denominator] = LENS_METRIC_SERIES[metricId] ?? [];
          const incomeInput = metric.inputs.find((input) => input.series === numerator);
          const incomeSeries =
            statements === undefined || incomeInput?.series === undefined
              ? undefined
              : financialStatementSeriesByKey(
                  statements,
                  incomeInput.series as FinancialStatementSeriesKey,
                );
          const incomeFact = [
            ...(incomeSeries?.annual ?? []),
            ...(incomeSeries?.interim ?? []),
          ].find((fact) => fact.periodKey === incomeInput?.periodKey);
          const months =
            incomeFact === undefined ? undefined : financialStatementPeriodMonths(incomeFact);
          expect(months, `${label} annualizes by net income's own period`).toBeGreaterThan(0);
          const numeratorValue = valueOf(String(numerator));
          const expected =
            months === undefined
              ? numeratorValue
              : (numeratorValue * (12 / months)) / valueOf(String(denominator));
          expectClose(metric.value, expected, label);
          break;
        }
        default: {
          if (metric.inputs.length !== 2 || !metricId.endsWith("DeltaPercent")) {
            break;
          }
          const [prior, latest] = [Number(resolved[0]?.value), Number(resolved[1]?.value)];
          const comparedSeries = metric.inputs.map((input) => input.series);
          expect(comparedSeries[0], `${label} compares one series`).toBe(comparedSeries[1]);
          expectClose(metric.value, ((latest - prior) / Math.abs(prior)) * 100, label);
        }
      }
    }
  }
}

export function assertMetricSectionInvariants(
  run: MetricInvariantRun,
  report: ResearchReport,
): void {
  const sections = report.extras?.metricSections as MetricSectionsExtra | undefined;
  const statements = run.collectedSources.financialStatements;
  const capitalReturn = sections?.find(({ id }) => id === "capital-return");
  expect(capitalReturn, "every equity run declares Capital Return").toBeDefined();
  expect(run.markdown.includes("### Capital Return\n")).toBe(capitalReturn !== undefined);
  const bundle = run.deepEquityEvidenceBundle;
  if (bundle !== undefined) {
    expect(asWritten(bundle.derived.metricSections)).toEqual(asWritten(sections));
  }
  if (statements === undefined) {
    expect(capitalReturn?.metrics.some(({ status }) => status === "missing")).toBe(true);
    expect(
      run.collectedSources.sourceGaps.find(({ source }) => source === "capital-return")?.triage,
    ).toBe("material");
    return;
  }
  if (capitalReturn === undefined) {
    return;
  }
  const unresolved = capitalReturn.metrics.filter(({ status }) => status !== "value");
  expect(
    report.dataGaps.some((gap) => gap.startsWith("capital-return: ")),
    "an unresolved Capital Return metric must surface its section gap",
  ).toBe(unresolved.length > 0);
  assertSectionGapTriage(run, "capital-return", capitalReturn.metrics);
  const reportSourceIds = new Set(report.sources.map(({ id }) => id));
  const splitPeriodEnds = (series: string) =>
    statements.omissionNotes
      .filter((note) => note.code === "earlier-share-basis" && note.seriesKey === series)
      .map((note) => note.periodKey?.split("|").at(-1) ?? "");
  for (const metric of capitalReturn.metrics) {
    const label = `capital-return.${metric.id}`;
    for (const sourceId of metric.sourceIds) {
      expect(reportSourceIds.has(sourceId), `${label} cites ${sourceId}`).toBe(true);
    }
    const resolved = metric.inputs.map((input) =>
      resolveInput(run, input, `${label} ${input.label}`),
    );
    if (metric.cause === "not-filed") {
      const filedFacts = resolved.filter(
        (_fact, index) => metric.inputs[index]?.artifact === "statements",
      );
      expect(
        new Set(filedFacts.map((fact) => `${fact?.periodKey}/${fact?.periodType}`)).size,
        `${label} not-filed filed inputs join one period`,
      ).toBeLessThanOrEqual(1);
      expect(metric.periodEnd, `${label} not-filed ends at its filed anchor`).toBe(
        filedFacts[0]?.periodEnd,
      );
    }
    if (metric.status !== "value") {
      continue;
    }
    expect(
      (typeof metric.value === "number" && Number.isFinite(metric.value)) ||
        (typeof metric.value === "string" && metric.value !== ""),
      `${label} carries a finite number or non-empty text`,
    ).toBe(true);
    expect(metric.sourceIds.length, `${label} cites a source`).toBeGreaterThan(0);
    expect(metric.periodEnd, `${label} carries its FY end`).toBeDefined();
    const resolvedOf = (series: string): ResolvedInput | undefined =>
      resolved[metric.inputs.findIndex((input) => input.series === series)];
    const valueOf = (series: string): number => Number(resolvedOf(series)?.value ?? Number.NaN);
    const statementFacts = resolved.filter(
      (_fact, index) => metric.inputs[index]?.artifact === "statements",
    );
    const joined = (): void => {
      expect(
        new Set(statementFacts.map((fact) => `${fact?.periodKey}/${fact?.periodType}`)).size,
        `${label} joins one period`,
      ).toBe(1);
    };
    const marketCap = valueOf("marketCap");
    const dividends = Math.abs(valueOf("dividendsPaid"));
    const repurchases = Math.abs(valueOf("shareRepurchases"));
    const freeCashFlow = valueOf("operatingCashFlow") - valueOf("capitalExpenditure");
    const endpoint = /^(shareCountChange|dpsCagr)(\d)y$/u.exec(metric.id);
    const endpointYears = endpoint?.[2] ?? (metric.id === "shareCountTrend" ? "3" : undefined);
    if (endpointYears !== undefined) {
      const [earlier, later] = statementFacts;
      const endpointSeries = endpoint?.[1] === "dpsCagr" ? "dividendsPerShare" : "dilutedShares";
      expect(metric.inputs.map(({ series }) => series)).toEqual([endpointSeries, endpointSeries]);
      const earlierEnd = earlier?.periodEnd ?? "";
      const laterEnd = later?.periodEnd ?? "";
      expect(
        Math.abs(days(earlierEnd, laterEnd) - Number(endpointYears) * 365),
        `${label} endpoints are ${endpointYears}y apart`,
      ).toBeLessThanOrEqual(15);
      expect(metric.periodEnd, `${label} ends at its later endpoint`).toBe(laterEnd);
      expect(
        splitPeriodEnds(endpointSeries).filter((end) => end >= earlierEnd && end <= laterEnd),
        `${label} window has no earlier share basis`,
      ).toEqual([]);
      const ratio = Number(later?.value ?? Number.NaN) / Number(earlier?.value ?? Number.NaN);
      if (endpointSeries === "dividendsPerShare") {
        expectClose(metric.value, ratio ** (1 / Number(endpointYears)) - 1, label);
      } else if (metric.id !== "shareCountTrend") {
        expectClose(metric.value, ratio - 1, label);
      }
    } else if (statementFacts.length > 0) {
      expect(metric.periodEnd, `${label} ends at its anchor FY`).toBe(statementFacts[0]?.periodEnd);
    }
    switch (metric.id) {
      case "fcfPayoutRatio": {
        joined();
        expect(
          valueOf("capitalExpenditure"),
          `${label} capex is a filed outflow`,
        ).toBeGreaterThanOrEqual(0);
        expectClose(metric.value, dividends / freeCashFlow, label);
        break;
      }
      case "totalPayoutToFcf": {
        joined();
        expect(
          valueOf("capitalExpenditure"),
          `${label} capex is a filed outflow`,
        ).toBeGreaterThanOrEqual(0);
        expectClose(metric.value, (dividends + repurchases) / freeCashFlow, label);
        break;
      }
      case "buybackYield": {
        expectClose(metric.value, repurchases / marketCap, label);
        break;
      }
      case "dividendYieldFiled": {
        expectClose(metric.value, dividends / marketCap, label);
        break;
      }
      case "shareholderYield": {
        joined();
        expectClose(metric.value, (dividends + repurchases) / marketCap, label);
        break;
      }
      case "dpsLatestFy": {
        expectClose(metric.value, valueOf("dividendsPerShare"), label);
        break;
      }
      case "earliestDividendFyInHistory": {
        const [earliest] = (
          financialStatementSeriesByKey(statements, "dividendsPerShare")?.annual ?? []
        )
          .filter((fact) => fact.value > 0 && isAnnualSpan(fact))
          .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
        expect(metric.value, `${label} names the earliest positive FY`).toBe(
          `FY${String(earliest?.fiscalYear)}`,
        );
        expect(metric.periodEnd, `${label} ends at that FY`).toBe(earliest?.periodEnd);
        break;
      }
      default:
    }
    const quote = resolvedOf("marketCap");
    if (quote !== undefined) {
      expect(quote.currency, `${label} quote currency matches reporting`).toBe(
        statementFacts[0]?.currency,
      );
    }
  }
}

const OPERATING_RATIO_INPUTS: Readonly<Record<string, readonly FinancialStatementSeriesKey[]>> = {
  freeCashFlowMargin: ["operatingCashFlow", "capitalExpenditure", "revenue"],
  interestCoverage: ["operatingIncome", "interestExpense"],
  ebitdaProxy: ["operatingIncome", "depreciationAndAmortization"],
  effectiveTaxRate: ["incomeTaxExpense", "pretaxIncome"],
  roic: [
    "operatingIncome",
    "incomeTaxExpense",
    "pretaxIncome",
    "stockholdersEquity",
    "debt",
    "cash",
  ],
};
const INVESTED_CAPITAL = new Set<string>(["stockholdersEquity", "debt", "cash"]);
const OPERATING_RATIO_DEPOSITORY = new Set(["freeCashFlowMargin", "interestCoverage", "roic"]);

// Denominator bounds re-checked over raw values; a not-meaningful metric must hit one, a value must not.
function operatingRatioBound(
  metricId: string,
  valueOf: (key: string) => number | undefined,
): string | undefined {
  const below = (key: string, inclusive = true) => {
    const value = valueOf(key);
    return value !== undefined && (inclusive ? value <= 0 : value < 0);
  };
  const [tax, pretax] = [valueOf("incomeTaxExpense"), valueOf("pretaxIncome")];
  const [equity, debt, cash] = [valueOf("stockholdersEquity"), valueOf("debt"), valueOf("cash")];
  const shortTermInvestments = valueOf("shortTermInvestments") ?? 0;
  switch (metricId) {
    case "freeCashFlowMargin": {
      if (below("capitalExpenditure", false)) {
        return "capital expenditure negative";
      }
      return below("revenue") ? "revenue not positive" : undefined;
    }
    case "interestCoverage": {
      return below("interestExpense") ? "interest expense not positive" : undefined;
    }
    case "ebitdaProxy": {
      return below("depreciationAndAmortization", false) ? "D&A negative" : undefined;
    }
    case "effectiveTaxRate": {
      return below("pretaxIncome") ? "pretax income not positive" : undefined;
    }
    case "roic": {
      if (below("pretaxIncome")) {
        return "pretax income not positive";
      }
      if (tax !== undefined && pretax !== undefined && (tax / pretax < 0 || tax / pretax > 1)) {
        return "effective tax rate outside 0-100%";
      }
      return equity !== undefined &&
        debt !== undefined &&
        cash !== undefined &&
        equity + debt - cash - shortTermInvestments <= 0
        ? "invested capital not positive"
        : undefined;
    }
    default: {
      return undefined;
    }
  }
}

function instantFact(
  statements: FinancialStatementsArtifact,
  key: FinancialStatementSeriesKey,
  periodEnd: string,
): FinancialStatementFact | undefined {
  const series = financialStatementSeriesByKey(statements, key);
  const matches = [...(series?.annual ?? []), ...(series?.interim ?? [])].filter(
    (fact) => fact.periodKey === `instant|${periodEnd}`,
  );
  return matches.find((fact) => fact.periodType === "annual") ?? matches[0];
}

// Operating Ratios: flows join like Capital Return; filed instants sit at the anchor's own end.
function operatingRatioFiledFailure(
  run: MetricInvariantRun,
  metricId: string,
  statements: FinancialStatementsArtifact,
  filed: readonly FinancialStatementSeriesKey[],
  withBounds = true,
): string | undefined {
  const flows = filed.filter((key) => !INVESTED_CAPITAL.has(key));
  const joinFailure = capitalReturnFiledFailure(run, metricId, statements, flows);
  const [anchorKey] = flows;
  if (joinFailure !== undefined || anchorKey === undefined) {
    return joinFailure;
  }
  const anchor = annualFacts(statements, anchorKey)
    .toSorted((left, right) => right.periodEnd.localeCompare(left.periodEnd))
    .at(0)!;
  const facts = new Map(
    filed.map((key) => [
      key,
      INVESTED_CAPITAL.has(key)
        ? instantFact(statements, key, anchor.periodEnd)
        : annualFacts(statements, key).find(
            (fact) =>
              fact.periodEnd === anchor.periodEnd && fact.periodStart === anchor.periodStart,
          ),
    ]),
  );
  const absent = filed.find((key) => facts.get(key) === undefined);
  if (absent !== undefined) {
    return `no ${absent} at ${anchor.periodEnd}`;
  }
  return withBounds
    ? operatingRatioBound(metricId, (key) => facts.get(key as FinancialStatementSeriesKey)?.value)
    : undefined;
}

export function assertOperatingRatioInvariants(
  run: MetricInvariantRun,
  report: ResearchReport,
): void {
  assertDepreciationAndAmortizationSelection(run);
  const sections = report.extras?.metricSections as MetricSectionsExtra | undefined;
  const statements = run.collectedSources.financialStatements;
  const section = sections?.find(({ id }) => id === "operating-ratios");
  expect(section, "every equity run declares Operating Ratios").toBeDefined();
  expect(run.markdown.includes("### Operating Ratios\n")).toBe(section !== undefined);
  if (statements === undefined) {
    expect(section?.metrics.some(({ status }) => status === "missing")).toBe(true);
    expect(
      run.collectedSources.sourceGaps.find(({ source }) => source === "operating-ratios")?.triage,
    ).toBe("material");
    return;
  }
  if (section === undefined) {
    return;
  }
  expect(
    report.dataGaps.some((gap) => gap.startsWith("operating-ratios: ")),
    "an unresolved Operating Ratios metric must surface its section gap",
  ).toBe(section.metrics.some(({ status }) => status !== "value"));
  expect(
    run.collectedSources.sourceGaps
      .filter(({ source }) => source === "operating-ratios")
      .every(({ evidenceQualityImpact }) => evidenceQualityImpact === "no-cap"),
  ).toBe(true);
  const missing = section.metrics.filter(({ status }) => status === "missing");
  if (missing.length > 0) {
    expect(
      run.collectedSources.sourceGaps.find(({ source }) => source === "operating-ratios")?.triage,
      "operating-ratios gap is diagnostic only when every missing metric is not-filed",
    ).toBe(missing.every(({ cause }) => cause === "not-filed") ? "diagnostic" : "material");
  }
  expect(
    section.metrics.map(({ id }) => id),
    "operating-ratios carries every metric in order",
  ).toEqual(Object.keys(OPERATING_RATIO_INPUTS));
  const depositorySic = depositoryIssuerSic(run.collectedSources.extendedEvidence);
  const reportSourceIds = new Set(report.sources.map(({ id }) => id));
  for (const metric of section.metrics) {
    const id = String(metric.id);
    const label = `operating-ratios.${id}`;
    const required = OPERATING_RATIO_INPUTS[id];
    expect(required, `${label} is a known metric`).toBeDefined();
    expect(
      metric.status === "not-applicable",
      `${label} is not-applicable iff the issuer is a depository`,
    ).toBe(depositorySic !== undefined && OPERATING_RATIO_DEPOSITORY.has(id));
    if (metric.status === "not-applicable") {
      expect(metric.reason, `${label} names the depository SIC`).toContain(
        `SIC ${String(depositorySic)}`,
      );
      expect(metric.inputs, `${label} has no inputs`).toEqual([]);
      continue;
    }
    for (const sourceId of metric.sourceIds) {
      expect(reportSourceIds.has(sourceId), `${label} cites ${sourceId}`).toBe(true);
    }
    // Short-term investment rows carry no series; ROIC subtracts them as the EV bridge resolved them.
    const seriesInputs = metric.inputs.filter(({ series }) => series !== undefined);
    const shortTermInvestments = metric.inputs
      .filter(({ series, artifact }) => series === undefined && artifact !== "evidence")
      .reduce((sum, { value }) => sum + Number(value), 0);
    const resolved = seriesInputs.map((input) =>
      resolveInput(run, input, `${label} ${input.label}`),
    );
    expect(
      seriesInputs.every(({ series }) => required?.includes(series as FinancialStatementSeriesKey)),
      `${label} reads only its own inputs`,
    ).toBe(true);
    const flows = resolved.filter((fact) => fact?.periodStart !== undefined);
    const instants = resolved.filter((fact) => fact?.periodStart === undefined);
    expect(
      new Set(flows.map((fact) => `${fact?.periodKey}/${fact?.periodType}`)).size,
      `${label} flow inputs join one period`,
    ).toBeLessThanOrEqual(1);
    const anchorEnd = flows[0]?.periodEnd;
    for (const instant of instants) {
      expect(instant?.periodKey, `${label} instants sit at the flow period end`).toBe(
        `instant|${String(anchorEnd)}`,
      );
    }
    if (anchorEnd !== undefined) {
      expect(metric.periodEnd, `${label} ends at its anchor FY`).toBe(anchorEnd);
    }
    const valueOf = (key: string): number | undefined => {
      if (key === "shortTermInvestments") {
        return shortTermInvestments;
      }
      const index = seriesInputs.findIndex(({ series }) => series === key);
      return index === -1 ? undefined : Number(resolved[index]?.value);
    };
    const pretax = metric.inputs.find(({ series }) => series === "pretaxIncome");
    const pretaxFact =
      pretax === undefined
        ? undefined
        : financialStatementSeriesByKey(statements, "pretaxIncome")?.annual.find(
            (fact) => fact.periodKey === pretax.periodKey,
          );
    const pretaxLabel = scopedLabel("pretax income", conceptScope(pretaxFact?.concept));
    if (pretax !== undefined) {
      expect(pretax.label, `${label} labels pretax income by its concept scope`).toBe(pretaxLabel);
    }
    expect(
      metric.basis.endsWith(`; pretax income is ${pretaxLabel}`),
      `${label} basis names the pretax scope`,
    ).toBe(pretaxLabel !== "pretax income");
    if (id === "ebitdaProxy" && metric.status === "value") {
      const da = metric.inputs.find(({ series }) => series === "depreciationAndAmortization");
      const fact = statements.statements.cashFlowStatement.depreciationAndAmortization.annual.find(
        (candidate) => candidate.periodKey === da?.periodKey,
      );
      expect(
        /D&A basis: (depreciation \+ intangible|cash-flow depreciation and amortization \+) amortization/u.test(
          metric.basis,
        ),
        `${label} names its component basis`,
      ).toBe(fact?.composite !== undefined);
    }
    if (metric.cause === "not-filed") {
      assertNotFiledCause(run, label, required, (artifact, filed) =>
        operatingRatioFiledFailure(run, id, artifact, filed),
      );
    } else if (metric.status === "missing") {
      const unfiled = new Set(statements.unfiledSeries);
      expect(
        operatingRatioFiledFailure(
          run,
          id,
          statements,
          (required ?? []).filter((key) => !unfiled.has(key)),
          false,
        ),
        `${label} missing has a filed input that fails to resolve`,
      ).toBeDefined();
    }
    if (metric.status === "not-meaningful") {
      expect(
        operatingRatioBound(id, valueOf),
        `${label} not-meaningful hits a bound`,
      ).toBeDefined();
      continue;
    }
    if (metric.status !== "value") {
      continue;
    }
    expect(
      seriesInputs.map(({ series }) => series),
      `${label} joins every input`,
    ).toEqual([...(required ?? [])]);
    const at = (key: string): number => valueOf(key) ?? Number.NaN;
    const statutoryPercent = /NOPAT at the (\d+)% US federal statutory rate/u.exec(
      metric.basis,
    )?.[1];
    const effectiveRate = at("incomeTaxExpense") / at("pretaxIncome");
    const incorporation = metric.inputs.filter(({ artifact }) => artifact === "evidence");
    expect(
      incorporation.map(({ key }) => key),
      `${label} cites incorporation only for the statutory fallback`,
    ).toEqual(statutoryPercent === undefined ? [] : ["stateOfIncorporation"]);
    for (const input of incorporation) {
      expect(
        resolveInput(run, input, `${label} ${input.label}`)?.value,
        `${label} incorporation matches the sec-edgar item`,
      ).toBe(input.value);
      expect(metric.basis, `${label} basis names the incorporation`).toContain(
        `(issuer incorporated in ${String(input.value)})`,
      );
    }
    if (statutoryPercent !== undefined) {
      expect(id, `${label} statutory fallback is ROIC only`).toBe("roic");
      expect(
        effectiveRate < 0 || effectiveRate > 1,
        `${label} statutory fallback only replaces an out-of-range effective rate`,
      ).toBe(true);
    }
    expect(
      operatingRatioBound(id, (key) =>
        statutoryPercent !== undefined && key === "incomeTaxExpense" ? undefined : valueOf(key),
      ),
      `${label} value passes its bounds`,
    ).toBeUndefined();
    const roicTaxRate =
      statutoryPercent === undefined ? effectiveRate : Number(statutoryPercent) / 100;
    const expected = {
      freeCashFlowMargin: (at("operatingCashFlow") - at("capitalExpenditure")) / at("revenue"),
      interestCoverage: at("operatingIncome") / at("interestExpense"),
      ebitdaProxy: at("operatingIncome") + at("depreciationAndAmortization"),
      effectiveTaxRate: at("incomeTaxExpense") / at("pretaxIncome"),
      roic:
        (at("operatingIncome") * (1 - roicTaxRate)) /
        (at("stockholdersEquity") + at("debt") - at("cash") - at("shortTermInvestments")),
    }[id];
    expectClose(metric.value, expected ?? Number.NaN, label);
    if (metric.unit === "currency") {
      expect(metric.currency, `${label} carries its filed currency`).toBe(flows[0]?.currency);
    }
  }
}

const FRAMEWORK_RATIOS: Readonly<Record<string, readonly [string, string]>> = {
  grossMargin: ["grossProfit", "revenue"],
  operatingMargin: ["operatingIncome", "revenue"],
};

const LENS_CITED_FRAMEWORK_METRICS: Readonly<Record<string, readonly [string, string]>> = {
  "business-framework-risk.currentRatio": ["financial-lens-financial-strength", "currentRatio"],
  "business-framework-risk.debtToMarketCap": [
    "financial-lens-financial-strength",
    "debtToMarketCap",
  ],
  "business-framework-valuation.evToAnnualizedRevenue": [
    "financial-lens-value",
    "evToAnnualizedRevenue",
  ],
};

export function assertBusinessFrameworkMetricInvariants(
  run: MetricInvariantRun,
  report: ResearchReport,
): void {
  const framework = run.collectedSources.businessFramework;
  if (framework === undefined) {
    return;
  }
  const sections = (report.extras?.metricSections as MetricSectionsExtra | undefined) ?? [];
  const reportSourceIds = new Set(report.sources.map(({ id }) => id));
  const secMetrics = run.collectedSources.extendedEvidence?.items.find(
    ({ category }) => category === "sec-edgar",
  )?.metrics;
  expect(
    Object.keys(secMetrics ?? {}).filter((key) => /Selected|payoutRatioNonPositive/u.test(key)),
  ).toEqual([]);
  const lensStrength = sections.find(({ id }) => id === "financial-lens-financial-strength");
  const frameworkRisk = sections.find(({ id }) => id === "business-framework-risk");
  for (const id of ["currentRatio", "debtToMarketCap"]) {
    const lens = lensStrength?.metrics.find((metric) => metric.id === id);
    const own = frameworkRisk?.metrics.find((metric) => metric.id === id);
    if (lens?.cause === "not-filed") {
      expect(own?.cause).toBe("not-filed");
    }
    if (lens?.status === "value" && own?.status === "value") {
      expect(own.periodEnd, `business-framework-risk.${id} dates by the lens balance sheet`).toBe(
        lens.periodEnd,
      );
    }
  }
  const metricIn = (sectionId: string, metricId: string) =>
    sections.find(({ id }) => id === sectionId)?.metrics.find(({ id }) => id === metricId);
  for (const [frameworkId, lensId] of [
    ["evToAnnualizedRevenue", "evToAnnualizedRevenue"],
    ["forwardPE", "forwardPe"],
  ] as const) {
    const own = metricIn("business-framework-valuation", frameworkId);
    const lens = metricIn("financial-lens-value", lensId);
    if (own?.status === "value" && lens?.status === "value") {
      expect(
        own.periodEnd,
        `business-framework-valuation.${frameworkId} dates as the lens does`,
      ).toBe(lens.periodEnd);
      expect(own.periodMonths).toBe(lens.periodMonths);
    }
  }
  const phase = sections
    .find(({ id }) => id === "business-framework-phase")
    ?.metrics.find(({ id }) => id === "phase");
  if (phase?.status === "value") {
    expect(phase.sourceIds.length).toBeGreaterThan(0);
  }
  for (const frameworkSection of framework.sections) {
    for (const id of frameworkSection.metricSectionIds) {
      const section = sections.find((candidate) => candidate.id === id);
      expect(section, `${frameworkSection.name} references Metric Section ${id}`).toBeDefined();
      expect(run.markdown.includes(`### ${section?.title ?? id}\n`)).toBe(true);
      const unresolved = section?.metrics.filter(({ status }) => status !== "value") ?? [];
      assertSectionGapTriage(run, id, section?.metrics ?? []);
      expect(
        report.dataGaps.some((gap) => gap.startsWith(`${id}: `)),
        `${id} surfaces its section gap iff a metric is unresolved`,
      ).toBe(unresolved.length > 0);
      for (const metric of section?.metrics ?? []) {
        const label = `${id}.${metric.id}`;
        for (const sourceId of metric.sourceIds) {
          expect(reportSourceIds.has(sourceId), `${label} cites ${sourceId}`).toBe(true);
        }
        const lens = LENS_CITED_FRAMEWORK_METRICS[`${id}.${metric.id}`];
        if (lens !== undefined) {
          const counterpart = metricIn(lens[0], lens[1]);
          const cited = counterpart?.status === "value" ? counterpart : undefined;
          expect(metric.inputs, `${label} cites its lens counterpart's inputs`).toEqual(
            cited?.inputs ?? [],
          );
          expect(metric.sourceIds, `${label} cites its lens counterpart's sources`).toEqual(
            cited?.sourceIds ?? [],
          );
          if (metric.status === "value") {
            expect(cited, `${label} passes through a cited lens value`).toBeDefined();
            expectClose(metric.value, Number(cited?.value), label);
          }
          continue;
        }
        const resolved = metric.inputs.map((input) =>
          resolveInput(run, input, `${label} ${input.label}`, false),
        );
        if (metric.status !== "value" || typeof metric.value !== "number") {
          continue;
        }
        const [first, second] = resolved.map((input) => Number(input?.value));
        const ratio = FRAMEWORK_RATIOS[metric.id];
        // SEC-summary pass-through (no statements): inputs name evidence keys and YoY is filed.
        const passThrough = metric.inputs.every(({ artifact }) => artifact === "evidence");
        if (ratio !== undefined && !passThrough) {
          expect(resolved[0]?.periodKey, `${label} joins one period`).toBe(resolved[1]?.periodKey);
        }
        if (ratio !== undefined) {
          expect(metric.inputs.map(({ series, key }) => (passThrough ? key : series))).toEqual<
            readonly (string | undefined)[]
          >(ratio);
          expectClose(metric.value, (first ?? Number.NaN) / (second ?? Number.NaN), label);
        } else if (metric.id.endsWith("DeltaPercent") && !passThrough) {
          const prior = first ?? Number.NaN;
          expectClose(
            metric.value,
            (((second ?? Number.NaN) - prior) / Math.abs(prior)) * 100,
            label,
          );
        } else if (metric.id !== "phase") {
          expectClose(metric.value, first ?? Number.NaN, label);
        }
        if (metric.inputs[0]?.artifact === "statements") {
          expect(metric.periodEnd, `${label} ends at its anchor`).toBe(
            resolved.at(-1)?.periodEnd ?? resolved[0]?.periodEnd,
          );
        }
      }
    }
  }
}

export function factTaxonomies(result: RunFixtureResult): readonly string[] {
  const snapshot = result.collectedSources.rawSnapshots.find(
    (candidate) => candidate.adapter === "sec-companyfacts",
  );
  if (!isRecord(snapshot?.payload) || !isRecord(snapshot.payload.facts)) {
    return [];
  }
  return Object.keys(snapshot.payload.facts);
}

export function factForms(result: RunFixtureResult): ReadonlySet<string> {
  const snapshot = result.collectedSources.rawSnapshots.find(
    (candidate) => candidate.adapter === "sec-companyfacts",
  );
  const forms = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (typeof value.form === "string") {
      forms.add(value.form);
    }
    Object.values(value).forEach((item) => visit(item));
  };
  visit(snapshot?.payload);
  return forms;
}

interface UnsupportedInputManifest {
  readonly inputs: readonly {
    readonly file: string;
    readonly form: string;
    readonly role: string;
    readonly sha256: string;
    readonly bytes: number;
    readonly structuredSupport: string;
  }[];
}

export async function assertNbisUnsupportedInputs(): Promise<void> {
  const root = join(import.meta.dir, "../../fixtures/runs/equity-nbis-deep");
  const manifest = JSON.parse(
    await readFile(join(root, "unsupported-inputs.json"), "utf8"),
  ) as UnsupportedInputManifest;
  expect(manifest.inputs.map((input) => [input.form, input.role])).toEqual([
    ["20-F", "annual-filing"],
    ["6-K", "filing-index"],
    ["6-K", "interim-filing"],
    ["6-K", "interim-exhibit"],
    ["6-K", "interim-exhibit"],
    ["6-K", "current-report"],
    ["6-K", "current-report"],
  ]);
  for (const input of manifest.inputs) {
    const body = await readFile(join(root, "unsupported-inputs", input.file));
    expect(body.byteLength).toBe(input.bytes);
    expect(createHash("sha256").update(body).digest("hex")).toBe(input.sha256);
    expect(["unsupported", "discovery", "phase-3-candidate"]).toContain(input.structuredSupport);
  }
}

// A depository issuer must not produce a numeric enterprise value anywhere in the run. Check every
// Producer separately because valuation evidence, lenses, the framework, workbench, reverse DCF,
// Peer comparison, and rendering can regress independently.
const EV_REVENUE_COLUMN = 6;
const NUMERIC_CELL = /\d/u;

// IREN 10-K 0001878848-26-000052 tags iren:PaymentsRelatedToComputerHardware beside the PP&E line.
export function assertIrenExtensionCapexWithheld(result: RunFixtureResult): void {
  const { financialStatements, fundamentalHistory, sourceGaps } = result.collectedSources;
  const capex = financialStatements?.statements.cashFlowStatement.capitalExpenditure;
  expect(capex?.annual.map(({ periodEnd, value }) => [periodEnd, value])).toEqual([
    ["2023-06-30", 116_064_000],
  ]);
  expect(capex?.interim).toEqual([]);
  expect(
    fundamentalHistory?.series.freeCashFlowProxy.annual.map(({ periodEnd }) => periodEnd),
  ).toEqual(["2023-06-30"]);
  expect(
    financialStatements?.omissionNotes?.some(({ code }) => code === "unchecked-extension-capex"),
  ).toBe(false);
  for (const [start, end, hardware] of [
    ["2023-07-01", "2024-06-30", 338_054_000],
    ["2024-07-01", "2025-06-30", 799_171_000],
    ["2025-07-01", "2026-06-30", 1_335_081_000],
  ] as const) {
    expect(sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "sec-edgar",
        triage: "material",
        message: expect.stringMatching(
          new RegExp(
            `^SEC capital expenditure for ${start} to ${end} omitted: 10-K 0001878848-26-000052 .*iren:PaymentsRelatedToComputerHardware ${String(hardware)} `,
            "u",
          ),
        ),
      }),
    );
    const omission = sourceGaps.find(
      ({ source, message }) =>
        source === "sec-edgar" &&
        message.startsWith(`SEC capital expenditure for ${start} to ${end} omitted:`),
    );
    expect(result.report.dataGaps).toContain(`sec-edgar: ${omission?.message}`);
    expect(result.markdown).toContain(
      `- **Material:** sec-edgar: SEC capital expenditure for ${start} to ${end} omitted:`,
    );
    const workbench = result.collectedSources.valuationWorkbench?.historicalMultiples.observations
      .filter(({ periodEnd }) => periodEnd === end)
      .map(({ metrics }) => metrics.priceToFreeCashFlow);
    expect(workbench).toEqual([
      expect.objectContaining({ status: "missing", reason: "free-cash-flow-unavailable" }),
    ]);
  }
  const fcfMetrics = (
    (result.report.extras?.metricSections as MetricSectionsExtra | undefined) ?? []
  )
    .flatMap(({ metrics }) => metrics)
    .filter(({ id }) => id === "freeCashFlowProxy" || id === "freeCashFlowMargin");
  expect(fcfMetrics.map(({ id, status, periodEnd }) => [id, status, periodEnd])).toEqual([
    ["freeCashFlowProxy", "missing", "2026-06-30"],
    ["freeCashFlowMargin", "missing", "2026-06-30"],
  ]);
}

export function assertDepositoryEnterpriseValueAbsent(result: RunFixtureResult): void {
  const sic = depositoryIssuerSic(result.report.extendedEvidence);
  expect(sic, "fixture issuer must classify as a depository institution").toMatch(/^60\d{2}$/u);

  const bundle = result.deepEquityEvidenceBundle;
  const evidenceItems = bundle?.evidence.extendedEvidence?.items ?? [];
  const evidenceGaps = bundle?.evidence.extendedEvidence?.gaps ?? [];
  expect(
    evidenceItems.length,
    "depository fixture must carry extended-evidence items",
  ).toBeGreaterThan(0);
  expect(
    evidenceGaps.length,
    "depository fixture must carry explicit evidence gaps",
  ).toBeGreaterThan(0);
  expect(
    evidenceItems.find((item) => item.category === "valuation") ??
      evidenceGaps.find((gap) => gap.source === "valuation"),
    "valuation producer must emit evidence or an explicit gap",
  ).toBeDefined();
  expect(
    evidenceGaps.find((gap) => gap.source === "valuation"),
    "recorded valuation gap must preserve its missing-debt cause",
  ).toMatchObject({
    source: "valuation",
    cause: "provider-data-missing",
    message: expect.stringContaining("missing debt"),
  });
  expect(
    evidenceItems.find(
      (item) =>
        item.metrics?.enterpriseValue !== undefined ||
        item.metrics?.evToAnnualizedRevenue !== undefined,
    ),
    "extended evidence must omit enterprise-value metrics",
  ).toBeUndefined();

  const lenses = bundle?.derived.financialLenses?.lenses ?? [];
  expect(lenses.length, "depository fixture must carry financial lenses").toBeGreaterThan(0);
  const valueLens = lenses.find((lens) => lens.name === "Value");
  expect(valueLens, "depository fixture must carry the Value lens").toBeDefined();
  expect(valueLens?.metrics.length, "Value lens must carry non-EV metrics").toBeGreaterThan(0);
  expect(
    valueLens?.metrics.find(
      (metric) => metric.key === "enterpriseValue" || metric.key === "evToAnnualizedRevenue",
    ),
    "Value lens must omit enterprise-value metrics",
  ).toBeUndefined();

  const frameworkSections = bundle?.derived.businessFramework?.sections ?? [];
  expect(
    frameworkSections.length,
    "depository fixture must carry framework sections",
  ).toBeGreaterThan(0);
  const valuationMetrics =
    bundle?.derived.metricSections?.find(({ id }) => id === "business-framework-valuation")
      ?.metrics ?? [];
  expect(
    valuationMetrics.some(({ status }) => status === "value"),
    "Valuation framework must carry non-EV metrics",
  ).toBe(true);
  expect(
    valuationMetrics.find((metric) => metric.id === "evToAnnualizedRevenue")?.status,
    "Valuation framework EV/revenue must be not-applicable",
  ).toBe("not-applicable");

  const strengthMetrics = bundle?.derived.metricSections?.flatMap(({ metrics }) => metrics) ?? [];
  for (const id of ["netDebt", "netDebtToMarketCap"]) {
    expect(
      strengthMetrics.find((metric) => metric.id === id),
      `depository ${id} must be not-applicable with a declared reason`,
    ).toMatchObject({ status: "not-applicable", reason: expect.stringContaining(`SIC ${sic}`) });
  }

  const capitalReturn = bundle?.derived.metricSections?.find(({ id }) => id === "capital-return");
  for (const id of ["fcfPayoutRatio", "totalPayoutToFcf"]) {
    expect(
      capitalReturn?.metrics.find((metric) => metric.id === id)?.status,
      `depository ${id} must be not-applicable`,
    ).toBe("not-applicable");
  }

  const workbench = bundle?.derived.valuationWorkbench;
  expect(workbench, "depository fixture must carry a valuation workbench").toBeDefined();
  expect(workbench?.peerComparison, "depository peer comparison must be suppressed").toMatchObject({
    status: "suppressed",
    reason: "enterprise-value-not-applicable",
  });
  expect(bundle?.derived.reverseDcf, "depository reverse DCF must be suppressed").toMatchObject({
    status: "suppressed",
    reason: "enterprise-value-not-applicable",
  });

  const observations = workbench?.historicalMultiples.observations ?? [];
  expect(
    observations.length,
    "depository fixture must carry workbench observations",
  ).toBeGreaterThan(0);
  for (const observation of observations) {
    expect(
      observation.metrics.enterpriseValueToRevenue,
      `${observation.basis} ${observation.periodEnd} EV/revenue`,
    ).toMatchObject({ status: "not-applicable" });
  }

  const pricedObservations = observations.filter((observation) => !hasNoPriceHistory(observation));
  const rows = result.markdown
    .split("\n")
    .filter((line) => line.startsWith("ANNUAL | ") || line.startsWith("TTM | "));
  expect(rows.length, "workbench table must render priced rows").toBe(pricedObservations.length);
  const unpricedPeriods = observations.length - pricedObservations.length;
  if (unpricedPeriods > 0) {
    expect(result.markdown).toContain(
      `${String(unpricedPeriods)} period${unpricedPeriods === 1 ? "" : "s"} without price history:`,
    );
  }
  for (const row of rows) {
    const cell = row.split(" | ")[EV_REVENUE_COLUMN];
    expect(cell, row).toBe(
      "not applicable (deposit-funded issuer; enterprise value is not defined)",
    );
    expect(NUMERIC_CELL.test(cell ?? ""), row).toBe(false);
  }
}

// BNS conversions provide an independent oracle for inverted FX rates (ADR 0005).
const CONVERTED_ROW = /converted at USD\/CAD /gu;
const PINNED_CONVERSIONS = [
  { periodEnd: "2025-10-31", rate: 1.4, close: 70.55, pe: 98.77, ps: 123_264_963_232 },
  { periodEnd: "2026-01-31", rate: 1.3694, close: 75.38, pe: 103.22 },
] as const;
const RATE_TOLERANCE = 0.05;
const CLOSE_TOLERANCE = 2;
const MARKET_CAP_TOLERANCE = 5e9;

function expectNear(
  actual: number | undefined,
  expected: number,
  tolerance: number,
  label: string,
): void {
  expect(actual, `${label} must be a recorded number`).toBeNumber();
  expect(
    Math.abs((actual ?? Number.NaN) - expected),
    `${label} must be within ${tolerance} of ${expected}, got ${actual}`,
  ).toBeLessThanOrEqual(tolerance);
}

export function assertCurrencyConvertedValuation(result: RunFixtureResult): void {
  const workbench = result.deepEquityEvidenceBundle?.derived.valuationWorkbench;
  expect(workbench?.reportingCurrency, "fixture issuer must report in CAD").toBe("CAD");
  expect(workbench?.quoteCurrency, "fixture issuer must quote in USD").toBe("USD");

  const observations = workbench?.historicalMultiples.observations ?? [];
  expect(observations.length, "fixture must carry workbench observations").toBeGreaterThan(0);
  const converted = observations.flatMap((observation) =>
    observation.fxConversion === undefined
      ? []
      : [{ observation, fx: observation.fxConversion, price: observation.price }],
  );
  expect(
    converted.length,
    "fixture must carry currency-converted workbench observations",
  ).toBeGreaterThan(0);

  for (const { observation, fx, price } of converted) {
    const label = `${observation.basis} ${observation.periodEnd}`;
    expect(price, `${label} converted observation must carry a quoted close`).not.toBeNull();
    expect(price?.currency, `${label} close must be quoted in USD`).toBe("USD");
    expect(fx.pair, `${label} FX pair`).toBe("USDCAD=X");
    expect(fx.sourceId, `${label} FX source`).toBe("market-yahoo-fx-usdcad");
    expect(
      result.report.sources.some((source) => source.id === fx.sourceId),
      `${label} FX source must be cited in the report`,
    ).toBe(true);
    expect(
      fx.rateDate.localeCompare(price?.sessionDate ?? ""),
      `${label} FX rate date`,
    ).toBeLessThanOrEqual(0);
    expect(Number.isFinite(fx.rate) && fx.rate > 0, `${label} FX rate must be usable`).toBe(true);
    expect(fx.rate, `${label} FX rate must actually move the close`).not.toBe(1);

    // The exact converted numerators: close × rate for P/E, and that again × diluted shares for
    // P/S. An unconverted close would suppress both, and a wrong rate would miss both numbers.
    const convertedClose = (price?.close ?? 0) * fx.rate;
    const dilutedShares = observation.inputs.dilutedShares?.value;
    expect(observation.metrics.priceToEarnings, `${label} P/E`).toMatchObject({
      status: "value",
      value: convertedClose / (observation.inputs.dilutedEps?.value ?? Number.NaN),
    });
    // IFRS TTM has no filed share count, and consolidated ProfitLoss cannot derive one.
    expect(observation.metrics.priceToSales, `${label} P/S`).toMatchObject(
      dilutedShares === undefined
        ? { status: "missing", reason: "diluted-shares-unavailable" }
        : {
            status: "value",
            value:
              (convertedClose * dilutedShares) / (observation.inputs.revenue?.value ?? Number.NaN),
          },
    );
  }

  const fy2024 = observations.find(
    (observation) => observation.basis === "annual" && observation.periodEnd === "2024-10-31",
  );
  expect(fy2024?.publicAt, "FY2024 dates to its first filing").toBe("2024-12-03");
  expect(fy2024?.metrics.priceToEarnings).toMatchObject({
    status: "missing",
    reason: "price-history-unavailable",
  });

  // The synthetic USDCAD cassette entry has no closes before 2025-11-25.
  expect(result.report.dataGaps).toContain(
    "market-yahoo-fx-usdcad: Yahoo FX close unavailable for USDCAD=X on or before 2025-08-26",
  );

  for (const pinned of PINNED_CONVERSIONS) {
    const match = converted.find(({ observation }) => observation.periodEnd === pinned.periodEnd);
    expect(match, `pinned ${pinned.periodEnd} must be a converted observation`).toBeDefined();
    const priceToEarnings = match?.observation.metrics.priceToEarnings;
    const priceToSales = match?.observation.metrics.priceToSales;
    expectNear(match?.fx.rate, pinned.rate, RATE_TOLERANCE, `pinned ${pinned.periodEnd} USD/CAD`);
    expectNear(
      match?.price?.close,
      pinned.close,
      CLOSE_TOLERANCE,
      `pinned ${pinned.periodEnd} quoted close`,
    );
    expectNear(
      priceToEarnings?.status === "value"
        ? Number(priceToEarnings.value) *
            (match?.observation.inputs.dilutedEps?.value ?? Number.NaN)
        : undefined,
      pinned.pe,
      CLOSE_TOLERANCE,
      `pinned ${pinned.periodEnd} converted close`,
    );
    if (!("ps" in pinned)) {
      continue;
    }
    expectNear(
      priceToSales?.status === "value"
        ? Number(priceToSales.value) * (match?.observation.inputs.revenue?.value ?? Number.NaN)
        : undefined,
      pinned.ps,
      MARKET_CAP_TOLERANCE,
      `pinned ${pinned.periodEnd} converted market cap`,
    );
  }

  expect(
    result.markdown.match(CONVERTED_ROW)?.length,
    "every converted observation must render its rate",
  ).toBe(converted.length);
  expect(result.markdown, "workbench header must name both currencies").toContain(
    "Reporting currency: CAD. Quote currency: USD.",
  );
}

export function assertMarketRegimeRendered(result: RunFixtureResult): void {
  const regime = result.report.extras?.marketRegime;
  expect(regime, "fixture must carry a market regime").toBeDefined();
  if (!isRecord(regime)) {
    return;
  }
  expect(result.markdown, "market regime heading").toContain("## Market Regime");
  const sourcesIndex = result.markdown.indexOf("### Sources");
  expect(sourcesIndex, "Sources heading").toBeGreaterThanOrEqual(0);
  const sourcesSection = result.markdown.slice(sourcesIndex);
  const sourceIds = Array.isArray(regime.sourceIds)
    ? regime.sourceIds.filter((sourceId): sourceId is string => typeof sourceId === "string")
    : [];
  expect(sourceIds.length, "market regime must cite sources").toBeGreaterThan(0);
  const drivers = Array.isArray(regime.drivers) ? regime.drivers.filter(isRecord) : [];
  expect(drivers.length, "market regime drivers").toBeGreaterThan(0);
  for (const driver of drivers) {
    const driverSourceIds = Array.isArray(driver.sourceIds) ? driver.sourceIds : [];
    expect(
      driverSourceIds.length,
      `regime driver ${String(driver.text)} cites a source`,
    ).toBeGreaterThan(0);
    expect(result.markdown, `regime driver ${String(driver.text)} cited in report.md`).toContain(
      `- ${String(driver.text)} [${String(driverSourceIds[0])}]`,
    );
  }
  for (const sourceId of sourceIds) {
    if (result.report.sources.some((source) => source.id === sourceId)) {
      expect(sourcesSection, `market regime source ${sourceId} in Sources`).toContain(
        `- [${sourceId}]`,
      );
    }
  }
}

export function assertComprehensiveAnalysisPath(
  result: RunFixtureResult,
  modelRequests: readonly ModelRequest[],
): void {
  const finalSynthesisPrompt = modelRequests
    .find((request) => request.model === "fixture-synthesis")
    ?.messages.findLast((message) => message.role === "user")?.content;
  expect(finalSynthesisPrompt).toContain("earnings-direction");
  expect(finalSynthesisPrompt).toContain("earningsReturn(SUBJECT, YYYY-MM-DD, +N) > 0");

  expect(result.collectedSources.earningsSetup).toMatchObject({
    event: { symbol: "AAPL", eventDateStatus: "issuer-confirmed" },
  });
  expect(readEarningsForecastTelemetry(result.report)?.grammarEligible).toBe(true);
  const confirmationSourceId =
    result.collectedSources.earningsSetup?.event.dateConfirmation?.sourceId;
  expect(confirmationSourceId, "fixture must carry a date-confirmation source").toBeDefined();
  expect(result.collectedSources.earningsSetup?.event.confirmedBy).toMatchObject({
    sourceId: confirmationSourceId,
    sourceType: result.collectedSources.earningsSetup?.event.dateConfirmation?.sourceType,
  });
  expect(result.collectedSources.earningsSetup?.event.dateConflict).toBeUndefined();
  const consensus =
    projectEquityReader({ report: result.report }).defaultView.earningsConsensus ?? [];
  for (const kind of ["eps-consensus", "revenue-consensus"] as const) {
    const item = consensus.find((candidate) => candidate.kind === kind);
    expect(item, `${kind} must render`).toBeDefined();
    expect(
      item?.sourceIds ?? [],
      `${kind} must exclude the date-confirmation source`,
    ).not.toContain(confirmationSourceId);
  }
  expect(result.collectedSources.analystExpectations).toMatchObject({
    version: 1,
    symbol: "AAPL",
  });
  expect(result.collectedSources.analystExpectationsSignal?.status).toBe("available");
  expect(result.collectedSources.institutionalOwnership).toMatchObject({
    version: 1,
    symbol: "AAPL",
  });
  expect(result.collectedSources.institutionalOwnershipSignal?.status).toBe("available");

  for (const sourceId of [
    ...(result.report.equityAnalysisCompleteness?.dimensions.expectations.sourceIds ?? []),
    ...(result.collectedSources.analystExpectationsSignal?.sourceIds ?? []),
    ...(result.collectedSources.analystExpectations?.externalContext?.sourceIds ?? []),
    ...(result.collectedSources.institutionalOwnershipSignal?.sourceIds ?? []),
  ]) {
    expect(result.report.sources.some((source) => source.id === sourceId)).toBe(true);
  }
}

export function assertEstimatedEarningsSuppressionPath(
  result: RunFixtureResult,
  modelRequests: readonly ModelRequest[],
  modelOutputs: readonly string[],
): void {
  const finalSynthesisPrompt = modelRequests
    .find((request) => request.model === "fixture-synthesis")
    ?.messages.findLast((message) => message.role === "user")?.content;
  expect(finalSynthesisPrompt).toContain(
    "Do not emit earnings-direction, earnings-move, or earningsReturn grammar",
  );
  expect(finalSynthesisPrompt).not.toContain(
    "earnings-direction or earnings-move (event-anchored)",
  );
  expect(finalSynthesisPrompt).not.toContain("kind earnings-direction with measurableAs");
  expect(finalSynthesisPrompt).not.toContain("kind earnings-move with measurableAs");
  expect(JSON.parse(finalSynthesisPrompt!).requiredShape.predictions[0].kind).toBe(
    "direction|relative|iv|range|conditional",
  );
  expect(
    modelOutputs.some(
      (output) =>
        output.includes('"kind":"earnings-direction"') && output.includes('"kind":"earnings-move"'),
    ),
  ).toBe(true);

  expect(result.collectedSources.earningsSetup).toMatchObject({
    event: { symbol: "AAPL", eventDateStatus: "provider-estimated" },
  });
  expect(result.collectedSources.earningsSetup?.event.confirmedBy).toBeUndefined();
  expect(result.collectedSources.earningsSetup?.event.dateConflict).toBeUndefined();
  expect(result.collectedSources.analystExpectations).toBeUndefined();
  expect(result.collectedSources.analystExpectationsSignal?.status).toBe("forbidden");
  expect(result.collectedSources.institutionalOwnership).toBeUndefined();
  expect(result.collectedSources.institutionalOwnershipSignal?.status).toBe("forbidden");
}

function outsideOnly(section: {
  readonly metrics: readonly { readonly status: string; readonly cause?: string }[];
}): boolean {
  const unresolved = section.metrics.filter(({ status }) => status !== "value");
  return (
    unresolved.length > 0 &&
    unresolved.every(
      ({ status, cause }) => status === "missing" && cause === "outside-price-history-window",
    )
  );
}

function assertValuationWorkbenchInvariants(
  run: RunFixtureResult,
  meta: FixtureMeta,
  fixtureName: string,
): void {
  const { valuationWorkbench: workbench, financialStatements: statements } = run.collectedSources;
  expect(
    workbench,
    "equity collection publishes a workbench even without statements",
  ).toBeDefined();
  const { observations } = workbench!.historicalMultiples;
  const expected = EXPECTED_WORKBENCH_VALUES[fixtureName];
  expect(expected, `${fixtureName} has pinned valuation values and statuses`).toBeDefined();
  expect(
    observations.map(({ basis, periodEnd, publicAt }) => `${basis}|${periodEnd}|${publicAt}`),
  ).toEqual(Object.keys(expected!));
  const sections = (run.collectedSources.metricSections ?? []).filter(({ id }) =>
    id.startsWith("valuation-workbench-"),
  );
  expect(sections.map(({ id }) => id)).toEqual(
    observations.length === 0
      ? ["valuation-workbench-unavailable"]
      : observations.map(
          ({ basis, periodEnd, publicAt }) =>
            `valuation-workbench-${basis}-${periodEnd}-${publicAt}`,
        ),
  );
  expect(
    (run.report.extras?.metricSections as MetricSectionsExtra | undefined)?.filter(({ id }) =>
      id?.startsWith("valuation-workbench-"),
    ),
  ).toEqual(sections);
  const gaps = run.collectedSources.sourceGaps.filter(({ source }) =>
    source.startsWith("valuation-workbench-"),
  );
  const outsideSections = sections.filter((section) => outsideOnly(section));
  expect(gaps).toHaveLength(
    sections.filter(
      (section) =>
        !outsideOnly(section) && section.metrics.some(({ status }) => status !== "value"),
    ).length + (outsideSections.length > 0 ? 1 : 0),
  );
  for (const section of sections) {
    const unresolved = section.metrics.filter(({ status }) => status !== "value");
    const gap = gaps.find(
      ({ source }) =>
        source ===
        (outsideOnly(section) ? "valuation-workbench-outside-price-history-window" : section.id),
    );
    if (outsideOnly(section)) {
      expect(gap?.message).toContain(section.title.replace(/^Valuation Workbench /u, ""));
    }
    expect(gap !== undefined).toBe(unresolved.length > 0);
    if (gap !== undefined) {
      expect(gap.triage).toBe(
        unresolved.some(
          ({ status, cause }) =>
            status === "missing" &&
            cause !== "not-filed" &&
            cause !== "outside-price-history-window",
        )
          ? "material"
          : "diagnostic",
      );
      const missing = unresolved.filter(({ status }) => status === "missing");
      expect(gap.cause).toBe(
        missing.some(({ cause }) => cause !== "outside-price-history-window")
          ? "provider-data-missing"
          : "suppressed-by-design",
      );
      for (const metric of unresolved) {
        expect(gap.message).toContain(metric.label);
      }
    }
  }
  if (observations.length === 0) {
    expect(sections[0]?.metrics[0]?.status).toBe("missing");
  }
  const raw = run.collectedSources.rawSnapshots.find(
    ({ adapter, id }) => adapter === "yahoo-price-history" && id.endsWith(`-${workbench?.symbol}`),
  );
  const prices =
    raw === undefined
      ? []
      : splitAdjustedObservationsFromYahooChart(workbench!.symbol, raw.payload)
          .filter(
            ({ date }) =>
              date <= meta.now.slice(0, 10) &&
              classifyLatestSession(readYahooRegularSession(raw.payload), date, raw.fetchedAt)
                .status === "complete",
          )
          .map(({ date, value }) => ({ date, close: value }));
  const historyUrl = run.report.sources.find(
    ({ id }) => id === `price-history-${workbench!.symbol}`,
  )?.url;
  const requestedFrom =
    historyUrl === undefined
      ? undefined
      : new Date(Number(new URL(historyUrl).searchParams.get("period1")) * 1000)
          .toISOString()
          .slice(0, 10);
  const filedFact = (input: MetricInput): FinancialStatementFact => {
    const series =
      statements === undefined
        ? undefined
        : financialStatementSeriesByKey(statements, input.series as FinancialStatementSeriesKey);
    const fact = [
      ...(series?.annual ?? []),
      ...(series?.interim ?? []),
      ...Object.values(series?.ttm?.components ?? {}),
    ].find(
      (candidate) =>
        candidate.periodKey === input.periodKey &&
        candidate.periodType === input.periodType &&
        candidate.value === input.value &&
        candidate.periodStart === input.periodStart &&
        candidate.periodEnd === input.periodEnd &&
        candidate.unit === input.unit &&
        (candidate.currency ?? undefined) === input.currency &&
        JSON.stringify(candidate.sourceIds) === JSON.stringify(input.sourceIds),
    );
    expect(
      fact,
      `${fixtureName}.${input.series} resolves to the filed fact with full lineage`,
    ).toBeDefined();
    return fact!;
  };
  const bridgeFact = (input: MetricInput): FinancialStatementFact => {
    const fact = Object.values(statements?.enterpriseValueBridge ?? {})
      .flat()
      .find(
        (candidate) =>
          candidate.concept === input.key &&
          candidate.periodEnd === input.periodEnd &&
          JSON.stringify(candidate.sourceIds) === JSON.stringify(input.sourceIds),
      );
    expect(fact, `${fixtureName}.${input.key} resolves to a filed EV bridge fact`).toBeDefined();
    return fact!;
  };
  const statementFact = (input: MetricInput): FinancialStatementFact =>
    input.series === undefined ? bridgeFact(input) : filedFact(input);
  const bridgeValue = (input: ValuationFundamentalInput, cash: number | undefined): number =>
    (input.lineage ?? []).reduce((sum, row) => {
      const fact = bridgeFact(row);
      const derived = fact.concept === "CashCashEquivalentsAndShortTermInvestments";
      expect(row.value).toBe(derived ? fact.value - cash! : fact.value);
      return sum + (row.label.startsWith("shortTermInvestments") ? -1 : 1) * Number(row.value);
    }, 0);
  const fundamentalValue = (input: ValuationFundamentalInput): number => {
    const lineage = input.lineage ?? [];
    expect(lineage.length, "a filed fundamental retains its raw inputs").toBeGreaterThan(0);
    const facts = lineage.map((row) => filedFact(row));
    expect(input.periodEnd).toBe(
      facts
        .map(({ periodEnd }) => periodEnd)
        .toSorted()
        .at(-1)!,
    );
    expect(input.currency).toBe(
      input.derivation === "net income / diluted EPS" ? null : facts[0]!.currency,
    );
    expect(input.unit).toBe(
      input.derivation === "net income / diluted EPS" ? "shares" : facts[0]!.unit,
    );
    expect(input.publicAt).toBe(
      facts
        .map(({ firstPublicAt }) => firstPublicAt)
        .toSorted()
        .at(-1)!,
    );
    expect(input.sourceIds.toSorted()).toEqual(
      [...new Set(facts.flatMap(({ sourceIds }) => sourceIds))].toSorted(),
    );
    const valueOf = (series: string): number => {
      const rows = lineage.flatMap((row, index) => (row.series === series ? [facts[index]!] : []));
      if (rows.length === 1) {
        return rows[0]!.value;
      }
      expect(rows).toHaveLength(3);
      const annual = rows.find(({ periodType }) => periodType === "annual")!;
      const interim = rows
        .filter(({ periodType }) => periodType === "interim")
        .toSorted((a, b) => a.periodEnd.localeCompare(b.periodEnd));
      expect(interim).toHaveLength(2);
      return annual.value + interim[1]!.value - interim[0]!.value;
    };
    const inputSeries = [...new Set(lineage.map(({ series }) => series!))];
    if (input.derivation?.startsWith("operating cash flow") === true) {
      expect(
        input.derivation.includes("capital expenditure carries no operations-scope tag"),
        "scoped FCF states that capex is unscoped",
      ).toBe(input.scope !== undefined);
      expect(valueOf("capitalExpenditure"), "FCF capex is a filed outflow").toBeGreaterThanOrEqual(
        0,
      );
      return valueOf("operatingCashFlow") - valueOf("capitalExpenditure");
    }
    if (input.derivation === "net income / diluted EPS") {
      return valueOf("netIncome") / valueOf("dilutedEps");
    }
    return valueOf(inputSeries[0]!);
  };
  for (const [index, observation] of observations.entries()) {
    const { basis, periodEnd, publicAt, inputs, metrics, price, fxConversion: fx } = observation;
    const label = `${fixtureName}.${basis}.${periodEnd}.${publicAt}`;
    expect(
      WORKBENCH_METRICS.map((key) =>
        metrics[key].status === "value"
          ? metrics[key].value
          : { status: metrics[key].status, reason: metrics[key].reason },
      ),
      label,
    ).toEqual([...expected![`${basis}|${periodEnd}|${publicAt}`]!]);
    expect(sections[index]?.metrics).toEqual(WORKBENCH_METRICS.map((key) => metrics[key]));
    const selectedPrice =
      workbench!.quoteCurrency === null
        ? undefined
        : prices
            .filter(
              ({ date, close }) =>
                Number.isFinite(close) &&
                close > 0 &&
                days(publicAt, date) >= 0 &&
                days(publicAt, date) <= 7,
            )
            .toSorted((a, b) => a.date.localeCompare(b.date))[0];
    expect(price, `${label} uses the first eligible verified close`).toEqual(
      selectedPrice === undefined
        ? null
        : {
            close: selectedPrice.close,
            sessionDate: selectedPrice.date,
            currency: workbench!.quoteCurrency!,
            sourceId: `price-history-${workbench!.symbol}`,
          },
    );
    for (const [key, fundamental] of Object.entries(inputs)) {
      if (key === "enterpriseValueBridge") {
        expect(fundamental.periodEnd, `${label} EV bridge sits at the cash instant`).toBe(
          inputs.cash!.periodEnd,
        );
        expectClose(fundamental.value, bridgeValue(fundamental, inputs.cash?.value), label);
        expect(fundamental.publicAt <= publicAt).toBe(true);
        continue;
      }
      expectClose(
        fundamental.value,
        fundamentalValue(fundamental),
        `${label}.${key} derives from filed facts`,
      );
      expect(fundamental.publicAt <= publicAt).toBe(true);
      expect(fundamental.periodEnd <= periodEnd).toBe(true);
      if (key !== "cash" && key !== "debt") {
        expect(fundamental.periodEnd).toBe(periodEnd);
      }
    }
    const observationSourceIds = [
      ...Object.values(inputs).flatMap((input) => input.sourceIds),
      ...(price === null ? [] : [price.sourceId]),
      ...(fx === undefined ? [] : [fx.sourceId]),
    ];
    expect(observation.sourceIds.toSorted(), `${label} keeps all observation citations`).toEqual(
      [...new Set(observationSourceIds)].toSorted(),
    );
    if (fx !== undefined) {
      expect(fx.rateDate <= price!.sessionDate).toBe(true);
    }
    for (const key of WORKBENCH_METRICS) {
      const metric = metrics[key];
      if (metric.status === "missing" && metric.reason === "price-history-unavailable") {
        expect(metric.cause, `${label}.${key} classifies only proven out-of-window history`).toBe(
          requestedFrom !== undefined &&
            Date.parse(publicAt) + 7 * 86_400_000 < Date.parse(requestedFrom) &&
            prices.length > 0
            ? "outside-price-history-window"
            : undefined,
        );
      }
      expect(metric.sourceIds.toSorted()).toEqual(
        [...new Set(metric.inputs.flatMap(({ sourceIds }) => sourceIds))].toSorted(),
      );
      const required =
        key === "priceToEarnings"
          ? [inputs.dilutedEps]
          : [
              key === "priceToFreeCashFlow" ? inputs.freeCashFlow : inputs.revenue,
              inputs.dilutedShares,
              ...(key === "enterpriseValueToRevenue"
                ? [inputs.cash, inputs.debt, inputs.enterpriseValueBridge]
                : []),
            ];
      if (metric.status === "not-applicable") {
        expect(metric.inputs).toEqual([]);
        continue;
      }
      const requiredLineage = required.flatMap((input) => input?.lineage ?? []);
      const partialFcfSources =
        key === "priceToFreeCashFlow" && inputs.freeCashFlow === undefined
          ? (["operatingCashFlow", "capitalExpenditure"] as const).flatMap((seriesKey) => {
              const series = statements?.statements.cashFlowStatement[seriesKey];
              return [...(series?.annual ?? []), ...(series?.interim ?? [])]
                .filter(
                  (fact) =>
                    inputs.revenue?.lineage?.some(
                      (anchor) =>
                        anchor.periodKey === fact.periodKey &&
                        anchor.periodType === fact.periodType,
                    ) && fact.firstPublicAt <= publicAt,
                )
                .flatMap(({ sourceIds }) => sourceIds);
            })
          : [];
      expect(
        metric.sourceIds.toSorted(),
        `${label}.${key} keeps only its required citations`,
      ).toEqual(
        [
          ...new Set([
            ...requiredLineage.flatMap(({ sourceIds }) => sourceIds),
            ...partialFcfSources,
            ...(price === null ? [] : [price.sourceId]),
            ...(fx === undefined ? [] : [fx.sourceId]),
          ]),
        ].toSorted(),
      );
      expect(metric.inputs.filter(({ artifact }) => artifact === "statements")).toEqual(
        expect.arrayContaining(requiredLineage),
      );
      for (const row of metric.inputs) {
        if (row.artifact === "statements") {
          statementFact(row);
        } else if (row.artifact === "priceHistory") {
          expect(row).toMatchObject({
            value: price!.close,
            periodEnd: price!.sessionDate,
            currency: price!.currency,
            sourceIds: [price!.sourceId],
          });
        } else {
          expect(row.artifact).toBe("fx");
          expect(row).toMatchObject({
            value: fx!.rate,
            periodEnd: fx!.rateDate,
            sourceIds: [fx!.sourceId],
          });
        }
      }
      expect(metric.inputs.filter(({ artifact }) => artifact === "priceHistory")).toHaveLength(
        price === null ? 0 : 1,
      );
      expect(metric.inputs.filter(({ artifact }) => artifact === "fx")).toHaveLength(
        fx === undefined ? 0 : 1,
      );
      if (metric.status !== "value") {
        continue;
      }
      expect(metric.periodEnd).toBe(periodEnd);
      expect(metric.basis).toContain(
        "first verified close within 7 calendar days on or after publicAt",
      );
      expect(metric.basis).toContain(`close ${price!.sessionDate} ${price!.currency}`);
      const close = price!.close * (fx?.rate ?? 1);
      const cap = close * (inputs.dilutedShares?.value ?? 1);
      let numerator = cap;
      if (key === "priceToEarnings") {
        numerator = close;
      } else if (key === "enterpriseValueToRevenue") {
        numerator =
          cap +
          inputs.debt!.value -
          inputs.cash!.value +
          (inputs.enterpriseValueBridge?.value ?? 0);
      }
      let denominator = Number.NaN;
      if (key === "priceToEarnings") {
        denominator = inputs.dilutedEps!.value;
      } else if (key === "priceToFreeCashFlow") {
        denominator = inputs.freeCashFlow!.value;
      } else {
        denominator = inputs.revenue!.value;
      }
      expect(denominator).toBeGreaterThan(0);
      expectClose(metric.value, numerator / denominator, `${label}.${key} arithmetic`);
    }
  }
  expect(workbench!.sourceIds.toSorted(), `${fixtureName} keeps artifact citations`).toEqual(
    [
      ...new Set([
        ...observations.flatMap(({ sourceIds }) => sourceIds),
        ...(run.collectedSources.valuationComps?.sourceIds ?? []),
      ]),
    ].toSorted(),
  );
}

const WORKBENCH_METRICS = [
  "priceToEarnings",
  "priceToSales",
  "enterpriseValueToRevenue",
  "priceToFreeCashFlow",
] as const satisfies readonly ValuationMetricKey[];
type WorkbenchValues = Readonly<
  Record<
    string,
    readonly (
      | number
      | {
          readonly status: "missing" | "not-meaningful" | "not-applicable";
          readonly reason: string;
        }
    )[]
  >
>;
const MISSING_WORKBENCH_PRICE = { status: "missing", reason: "price-history-unavailable" } as const;
const IFRS_WORKBENCH_EV = { status: "missing", reason: "ev-bridge-incomplete" } as const;
const MISSING_WORKBENCH_DEBT = { status: "missing", reason: "debt-unavailable" } as const;
const MISSING_WORKBENCH_CASH = { status: "missing", reason: "cash-unavailable" } as const;
const NEGATIVE_WORKBENCH_DENOMINATOR = {
  status: "not-meaningful",
  reason: "negative-denominator",
} as const;
const MIXED_WORKBENCH_BALANCE_SHEET = {
  status: "missing",
  reason: "mixed-period-balance-sheet",
} as const;
const MISSING_WORKBENCH_FCF = { status: "missing", reason: "free-cash-flow-unavailable" } as const;
const DEPOSITORY_WORKBENCH_EV = {
  status: "not-applicable",
  reason: "deposit-funded issuer; enterprise value is not defined (SIC 6022)",
} as const;
const DEPOSITORY_WORKBENCH_FCF = {
  status: "not-applicable",
  reason: "depository issuer; capex-based free cash flow is not defined (SIC 6022)",
} as const;
const MISSING_WORKBENCH_SHARES = {
  status: "missing",
  reason: "diluted-shares-unavailable",
} as const;
const MISSING_WORKBENCH_FX = { status: "missing", reason: "fx-rate-unavailable" } as const;
const IREN_WORKBENCH_VALUES: WorkbenchValues = {
  "annual|2023-06-30|2025-08-28": [
    NEGATIVE_WORKBENCH_DENOMINATOR,
    16.713_687_295_404_736,
    MISSING_WORKBENCH_CASH,
    NEGATIVE_WORKBENCH_DENOMINATOR,
  ],
  "annual|2024-06-30|2025-08-28": [
    NEGATIVE_WORKBENCH_DENOMINATOR,
    12.264_022_436_984_416,
    10.067_715_970_896_122,
    MISSING_WORKBENCH_FCF,
  ],
  "annual|2025-06-30|2025-08-28": [
    59.076_925_424_429_085,
    10.266_155_452_798_57,
    MIXED_WORKBENCH_BALANCE_SHEET,
    MISSING_WORKBENCH_FCF,
  ],
  "annual|2026-06-30|2026-08-27": [
    NEGATIVE_WORKBENCH_DENOMINATOR,
    18.122_127_052_430_16,
    20.522_885_460_762_748,
    MISSING_WORKBENCH_FCF,
  ],
};
const AAPL_WORKBENCH_VALUES: WorkbenchValues = {
  "annual|2023-09-30|2023-11-01": [
    MISSING_WORKBENCH_PRICE,
    MISSING_WORKBENCH_PRICE,
    MISSING_WORKBENCH_CASH,
    MISSING_WORKBENCH_PRICE,
  ],
  "annual|2024-09-30|2024-11-01": [
    MISSING_WORKBENCH_PRICE,
    MISSING_WORKBENCH_PRICE,
    MISSING_WORKBENCH_CASH,
    MISSING_WORKBENCH_PRICE,
  ],
  "annual|2025-09-30|2025-11-01": [
    MISSING_WORKBENCH_PRICE,
    MISSING_WORKBENCH_PRICE,
    MISSING_WORKBENCH_CASH,
    MISSING_WORKBENCH_PRICE,
  ],
  "ttm|2026-03-31|2026-05-01": [
    28.499_999_999_999_996, 7.760_563_380_281_689, 7.854_460_093_896_712, 28.016_949_152_542_37,
  ],
};
const EXPECTED_WORKBENCH_VALUES: Readonly<Record<string, WorkbenchValues>> = {
  "equity-aapl-brief": {},
  "equity-aapl-deep": AAPL_WORKBENCH_VALUES,
  "equity-earnings-release-deep": {
    "annual|2017-09-30|2018-11-05": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2018-09-29|2020-10-30": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2019-09-28|2020-10-30": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2020-09-26|2020-10-30": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2021-09-25|2021-10-29": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2022-09-24|2022-10-28": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2023-09-30|2023-11-03": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2024-09-28|2024-11-01": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
    ],
    "ttm|2025-06-28|2025-08-01": [
      30.710_167_660_517_836, 7.461_377_657_598_557_5, 7.574_748_107_277_358, 31.698_675_926_725_97,
    ],
    "annual|2025-09-27|2025-10-31": [
      36.242_626_691_312, 9.748_198_064_270_506, 9.853_830_259_502_64, 41.074_648_968_024_52,
    ],
    "ttm|2025-12-27|2026-01-30": [
      32.845_571_010_927_61, 8.880_399_105_071_705, 8.934_579_727_040_086, 31.368_207_461_272_917,
    ],
    "ttm|2026-03-28|2026-05-01": [
      33.915_256_010_706_73, 9.208_630_356_750_982, 9.244_524_225_730_83, 32.182_656_769_259_89,
    ],
    "ttm|2026-06-27|2026-07-31": [
      35.425_459_135_563_01, 9.784_017_596_279_83, 9.831_026_848_180_443, 33.416_038_910_092_25,
    ],
  },
  "equity-nbis-deep": {
    "annual|2016-12-31|2017-03-22": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_CASH,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2017-12-31|2018-03-27": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2018-12-31|2019-04-19": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_DEBT,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2019-12-31|2020-04-02": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_DEBT,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2020-12-31|2021-04-01": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MIXED_WORKBENCH_BALANCE_SHEET,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2021-12-31|2022-04-20": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MIXED_WORKBENCH_BALANCE_SHEET,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2022-12-31|2025-04-30": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_DEBT,
      MISSING_WORKBENCH_PRICE,
    ],
    // FY2023 20-F (0001104659-26-052948): continuing OCF -222.0M; the 829.8M total includes divested Yandex.
    "annual|2023-12-31|2026-04-30": [
      212.661_531_888_521_64,
      5230.731_450_141_013,
      MISSING_WORKBENCH_DEBT,
      NEGATIVE_WORKBENCH_DENOMINATOR,
    ],
    "annual|2024-12-31|2026-04-30": [
      NEGATIVE_WORKBENCH_DENOMINATOR,
      424.517_499_337_662_85,
      MISSING_WORKBENCH_DEBT,
      NEGATIVE_WORKBENCH_DENOMINATOR,
    ],
    "annual|2025-12-31|2026-04-30": [
      418.878_774_931_936_56,
      64.622_117_548_843_16,
      65.470_739_670_398_46,
      NEGATIVE_WORKBENCH_DENOMINATOR,
    ],
  },
  "equity-fpi-quarterly": {
    "annual|2023-12-31|2024-03-15": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2024-12-31|2025-03-15": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
    ],
    "annual|2025-12-31|2026-03-15": [
      14.314_666_666_666_666,
      7.873_066_666_666_668,
      9.873_066_666_666_668,
      MISSING_WORKBENCH_FCF,
    ],
    "ttm|2026-03-31|2026-05-10": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
    ],
  },
  "equity-fpi-ifrs-semiannual": {
    "annual|2023-12-31|2024-03-15": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_SHARES,
      IFRS_WORKBENCH_EV,
      MISSING_WORKBENCH_SHARES,
    ],
    "annual|2024-12-31|2025-03-15": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_SHARES,
      IFRS_WORKBENCH_EV,
      MISSING_WORKBENCH_SHARES,
    ],
    "annual|2025-12-31|2026-03-15": [
      14.314_666_666_666_666,
      MISSING_WORKBENCH_SHARES,
      IFRS_WORKBENCH_EV,
      MISSING_WORKBENCH_SHARES,
    ],
  },
  "equity-analysis-comprehensive": AAPL_WORKBENCH_VALUES,
  "equity-analysis-estimated-suppressed": AAPL_WORKBENCH_VALUES,
  "equity-web-fallback-deep": AAPL_WORKBENCH_VALUES,
  "equity-iren-deep": IREN_WORKBENCH_VALUES,
  "equity-iren-brief": IREN_WORKBENCH_VALUES,
  "equity-depository-deep": {
    "annual|2016-10-31|2018-11-27": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
    "annual|2017-10-31|2018-11-27": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
    "annual|2018-10-31|2018-11-27": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
    "annual|2019-10-31|2019-11-26": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
    "annual|2020-10-31|2020-12-01": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
    "annual|2021-10-31|2021-11-30": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
    "annual|2022-10-31|2022-11-29": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
    "annual|2023-10-31|2024-12-03": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
    "annual|2024-10-31|2024-12-03": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_PRICE,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
    "ttm|2025-04-30|2025-05-27": [
      MISSING_WORKBENCH_PRICE,
      MISSING_WORKBENCH_SHARES,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
    "ttm|2025-07-31|2025-08-26": [
      MISSING_WORKBENCH_FX,
      MISSING_WORKBENCH_SHARES,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
    "annual|2025-10-31|2025-12-02": [
      17.419_753_543_283_562,
      3.266_075_706_336_382,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
    "ttm|2026-01-31|2026-02-24": [
      15.315_112_823_716_342,
      MISSING_WORKBENCH_SHARES,
      DEPOSITORY_WORKBENCH_EV,
      DEPOSITORY_WORKBENCH_FCF,
    ],
  },
};

export function assertPricePerformanceInvariants(
  run: MetricInvariantRun,
  report: ResearchReport,
): void {
  expect(
    run.collectedSources.sourceGaps.filter(({ source }) => source === "yahoo-verified-chart"),
  ).toEqual([]);
  const sections = report.extras?.metricSections as MetricSectionsExtra | undefined;
  const section = sections?.find(({ id }) => id === "price-performance");
  expect(
    section,
    "equity runs, including fixtures with price history, require Price Performance",
  ).toBeDefined();
  expect(run.markdown).toContain("### Price Performance\n");
  expect(section!.metrics.map(({ id }) => id)).toEqual([
    "priceReturn1y",
    "spyPriceReturn1y",
    "priceReturn3y",
    "spyPriceReturn3y",
    "priceReturn5y",
    "spyPriceReturn5y",
  ]);
  const unresolved = section!.metrics.some(({ status }) => status !== "value");
  expect(report.dataGaps.some((gap) => gap.startsWith("price-performance: "))).toBe(unresolved);
  const gaps = run.collectedSources.sourceGaps.filter(
    ({ source }) => source === "price-performance",
  );
  expect(gaps).toHaveLength(unresolved ? 1 : 0);
  if (unresolved) {
    const structural = section!.metrics
      .filter(({ status }) => status === "missing")
      .every(({ cause }) => cause === "insufficient-history");
    expect(gaps[0]).toMatchObject({
      triage: structural ? "diagnostic" : "material",
      evidenceQualityImpact: "no-cap",
    });
  }
  const reportIds = new Set(report.sources.map(({ id }) => id));
  const histories = run.collectedSources.rawSnapshots.filter(
    ({ adapter }) => adapter === "yahoo-price-history",
  );
  const rawFor = (symbol: string) => histories.find(({ id }) => id.endsWith(`-${symbol}`));
  if (rawFor(report.symbol ?? "") !== undefined && rawFor("SPY") === undefined) {
    for (const metric of section!.metrics.filter(({ id }) => !id.startsWith("spy"))) {
      expect(metric.reason ?? "", "issuer returns do not depend on SPY history").not.toContain(
        "SPY",
      );
    }
    expect(run.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "yahoo-price-history",
        message: expect.stringContaining("SPY"),
      }),
    );
  }
  for (const metric of section!.metrics) {
    expect(metric.sourceIds.toSorted()).toEqual(
      [...new Set(metric.inputs.flatMap(({ sourceIds }) => sourceIds))].toSorted(),
    );
    for (const id of metric.sourceIds) {
      expect(reportIds.has(id), `${metric.id} cites ${id}`).toBe(true);
    }
    for (const input of metric.inputs) {
      expect(input.artifact).toBe("priceHistory");
      expect(input.key).toBeUndefined();
      const raw = rawFor(input.symbol!);
      expect(raw, `${metric.id} input resolves to raw Yahoo history`).toBeDefined();
      const bars = splitAdjustedObservationsFromYahooChart(input.symbol!, raw!.payload);
      const bar = bars.find(({ date }) => date === input.periodEnd);
      expect(bar?.value).toBe(Number(input.value));
      expect(input.sourceIds).toEqual([`price-history-${input.symbol!}`]);
      expect(
        classifyLatestSession(
          readYahooRegularSession(raw!.payload),
          input.periodEnd!,
          raw!.fetchedAt,
        ).status,
      ).toBe("complete");
    }
    if (metric.status !== "value") {
      continue;
    }
    expect(metric.inputs).toHaveLength(2);
    const [start, end] = metric.inputs;
    const years = Number(metric.id.match(/(\d)y$/u)?.[1]);
    const anniversary = new Date(end!.periodEnd!);
    anniversary.setUTCFullYear(anniversary.getUTCFullYear() - years);
    expect(
      Math.abs(Date.parse(start!.periodEnd!) - anniversary.getTime()) / 86_400_000,
    ).toBeLessThanOrEqual(7);
    expect(days(end!.periodEnd!, report.generatedAt.slice(0, 10))).toBeLessThanOrEqual(7);
    expect(metric.periodEnd).toBe(end!.periodEnd);
    expectClose(metric.value, Number(end!.value) / Number(start!.value) - 1, metric.id);
    expect(metric.basis).toContain("price return, not total return");
    expect(metric.basis).toContain("split-adjusted");
    if (metric.id.startsWith("spy")) {
      expect(metric.label).toContain("SPY (S&P 500 proxy)");
      const subject = rawFor(report.symbol!);
      expect(subject).toBeDefined();
      const bars = splitAdjustedObservationsFromYahooChart(report.symbol!, subject!.payload);
      for (const input of metric.inputs) {
        expect(
          bars.some(
            ({ date }) =>
              date === input.periodEnd &&
              classifyLatestSession(
                readYahooRegularSession(subject!.payload),
                date,
                subject!.fetchedAt,
              ).status === "complete",
          ),
        ).toBe(true);
      }
    }
  }
}
