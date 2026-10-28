import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readWatchlistsNamed } from "../console-watchlists";
import { createRunId, publishRunArtifacts, writeJson } from "../artifacts";
import type { InstrumentCommand } from "../cli/args";
import { readCodeVersion } from "../code-version";
import type { AppConfig } from "../config";
import { resolveRunParams } from "../config/runs/resolver";
import type { Prediction } from "../domain/prediction";
import type { ResearchReport } from "../domain/report";
import { dedupeSourceGaps, sourceGap, sourceGapScopedReportText } from "../domain/source-gaps";
import type { Source, SourceGap, SourceGapCause } from "../domain/sources";
import { isRecord } from "../guards";
import { withUntrustedModelInputRule } from "../model/trust-guard";
import type { ModelParams, ModelProvider, ModelRequest } from "../model/types";
import { renderMarkdownReport } from "../report/markdown";
import { validateResearchReport } from "../report/schema";
import { eventGrid, issueForecastBook, plannedEventGridIds } from "../research/event-grid";
import { loadStagePrompt, type LoadedPrompt } from "../research/prompt-loader";
import { verifiedSnapshotSource } from "../research/verified-snapshot-contract";
import { readJsonFile } from "../run-artifact-json-reader";
import { readLatestSuccessfulInstrumentRuns } from "../run-artifact-index";
import { RUN_ARTIFACT_FILES } from "../run-artifact-layout";
import { readReport } from "../run-artifact-report-reader";
import { readReportMarketRegimeLabel } from "../run-artifacts";
import { CURRENT_SCORING_POLICY_VERSION } from "../scoring/policy";
import { compactOversizedRawSnapshots } from "../sources/raw-snapshots";
import { createCollectContext } from "../sources/source-request";
import type { FetchLike, RawSourceSnapshot } from "../sources/types";
import { collectPriceHistory } from "../sources/yahoo-price-history";

const STAGE = "forecast-grid";
const MEASURED_ALLOWANCE_RUN = "2026-10-20T17-15-13-848Z-144ec654";
// Fallback only: measured on MEASURED_ALLOWANCE_RUN (codex gpt-6-luna, 36,287 tokens / 2 calls); a matching past run replaces it.
const PER_CALL_UNSEEN_TOKEN_ALLOWANCE = 17_400;
const LATEST_RUN_FRESH_DAYS = 7;
const LATEST_RUN_SUMMARY_CHARS = 600;
const RETURN_SESSIONS = [1, 5, 20, 60] as const;
const BENCHMARK_RETURN_SESSIONS = [5, 20] as const;
const DAY_MS = 86_400_000;

export interface ForecastGridPlan {
  readonly watchlist: string;
  readonly symbols: readonly string[];
  readonly gaps: readonly SourceGap[];
}

interface ForecastGridFactSheet {
  readonly symbol: string;
  readonly asOf?: string;
  readonly lastClose?: number;
  readonly returnsPct: Readonly<Record<string, number>>;
  readonly realizedVol20dAnnualizedPct?: number;
  readonly benchmark: {
    readonly symbol: "SPY";
    readonly returnsPct: Readonly<Record<string, number>>;
  };
  readonly marketRegime?: string;
  readonly latestRun?: {
    readonly runId: string;
    readonly generatedAt: string;
    readonly summary: string;
  };
  readonly events: readonly {
    readonly id: string;
    readonly measurableAs: string;
    readonly horizonTradingDays: number;
  }[];
}

function gridJobGap(symbol: string, message: string, cause: SourceGapCause): SourceGap {
  return sourceGap({ source: STAGE, symbol, message, cause, evidenceQualityImpact: "no-cap" });
}

function forecastBookGap(symbol: string, message: string, cause: SourceGapCause): SourceGap {
  return {
    ...gridJobGap(symbol, message, cause),
    capability: "forecast-book",
    triage: "diagnostic",
  };
}

function equityCommand(symbol: string): InstrumentCommand {
  return { jobType: "equity", assetClass: "equity", symbol, depth: "brief" };
}

export function planForecastGrid(dataDir: string, watchlist: string): ForecastGridPlan {
  const stored = readWatchlistsNamed(dataDir, watchlist);
  if (stored.matches.length === 0) {
    throw new Error(`Unknown watchlist "${watchlist}"`);
  }
  if (stored.matches.length > 1) {
    throw new Error(
      `Watchlist name "${watchlist}" is ambiguous: ids ${stored.matches.map(({ id }) => String(id)).join(", ")}`,
    );
  }
  const symbols = [
    ...new Set(
      stored.items
        .filter(({ assetClass }) => assetClass === "equity")
        .map(({ symbol }) => symbol.toUpperCase()),
    ),
  ];
  const gaps = stored.items
    .filter(({ assetClass }) => assetClass !== "equity")
    .map(({ assetClass, symbol }) =>
      forecastBookGap(
        symbol,
        `Forecast Grid skipped ${assetClass} item ${symbol}: the Event Grid covers equities only`,
        "unsupported-coverage",
      ),
    );
  if (symbols.length === 0) {
    throw new Error(
      stored.items.length === 0
        ? `Watchlist "${watchlist}" is empty`
        : `Watchlist "${watchlist}" has no equity symbols; the Event Grid covers equities only`,
    );
  }
  return { watchlist, symbols, gaps };
}

export function forecastGridRequest(
  loaded: LoadedPrompt,
  model: string,
  params: ModelParams | undefined,
  factSheet: ForecastGridFactSheet,
): ModelRequest {
  return {
    stage: STAGE,
    model,
    ...(params !== undefined ? { params } : {}),
    responseFormat: "json",
    messages: [
      { role: "system", content: withUntrustedModelInputRule(loaded.system) },
      {
        role: "user",
        content: JSON.stringify(
          {
            stage: STAGE,
            instruction: loaded.instruction,
            goal: loaded.goal,
            factSheet,
            responseShape: { eventGrid: [{ id: "grid-event-id", probability: "number 0-1" }] },
          },
          undefined,
          2,
        ),
      },
    ],
  };
}

function requestTokenEstimate(request: ModelRequest): number {
  const chars = request.messages.reduce((total, message) => total + message.content.length, 0);
  return Math.ceil(chars / 4) + PER_CALL_UNSEEN_TOKEN_ALLOWANCE;
}

function placeholderFactSheet(symbol: string): ForecastGridFactSheet {
  const sampleReturns = Object.fromEntries(
    RETURN_SESSIONS.map((sessions) => [String(sessions), -12.34]),
  );
  return {
    symbol,
    asOf: "2000-01-01",
    lastClose: 1234.56,
    returnsPct: sampleReturns,
    realizedVol20dAnnualizedPct: 12.34,
    benchmark: { symbol: "SPY", returnsPct: sampleReturns },
    marketRegime: "placeholder regime label",
    latestRun: {
      runId: createRunId(new Date(0)),
      generatedAt: new Date(0).toISOString(),
      summary: "x".repeat(LATEST_RUN_SUMMARY_CHARS),
    },
    events: plannedEventGridIds(symbol).map((id) => ({
      id,
      measurableAs: `close(${symbol}, +20)/close(${symbol}, 0) > close(SPY, +20)/close(SPY, 0)`,
      horizonTradingDays: 20,
    })),
  };
}

interface ObservedTokensPerCall {
  readonly runId: string;
  readonly tokensPerCall: number;
}

// Shortcut: scans run dirs newest-first reading report.json; switch to the Run Artifact Index if dry runs get slow.
async function observedTokensPerCall(
  dataDir: string,
  provider: string,
  model: string,
): Promise<ObservedTokensPerCall | undefined> {
  const names = await readdir(dataDir).catch(() => [] as string[]);
  for (const name of names
    .filter((entry) => !entry.startsWith("."))
    .toSorted()
    .toReversed()) {
    // oxlint-disable-next-line no-await-in-loop -- Newest-first scan stops at the first match.
    const read = await readJsonFile(join(dataDir, name, RUN_ARTIFACT_FILES.report));
    const grid =
      read.status === "ok" &&
      isRecord(read.value) &&
      read.value.jobType === "forecast-grid" &&
      isRecord(read.value.extras)
        ? read.value.extras.forecastGrid
        : undefined;
    if (
      isRecord(grid) &&
      grid.provider === provider &&
      grid.model === model &&
      typeof grid.callCount === "number" &&
      grid.callCount > 0 &&
      typeof grid.tokenEstimate === "number" &&
      grid.tokenEstimate > 0
    ) {
      return { runId: name, tokensPerCall: Math.ceil(grid.tokenEstimate / grid.callCount) };
    }
  }
  return undefined;
}

// Reads only the prompt file, config and past run reports: no fetch, no provider, no lock, no write.
export async function renderForecastGridDryRun(
  plan: ForecastGridPlan,
  config: AppConfig,
): Promise<string> {
  const loaded = await loadStagePrompt(STAGE, equityCommand(plan.symbols[0]!), config.promptDir);
  const { quickModel, quickModelParams } = resolveRunParams(
    equityCommand(plan.symbols[0]!),
    config,
  );
  const observed = await observedTokensPerCall(config.dataDir, config.provider, quickModel);
  const perSymbol = plan.symbols.map((symbol) => ({
    symbol,
    ids: plannedEventGridIds(symbol),
    tokens:
      observed?.tokensPerCall ??
      requestTokenEstimate(
        forecastGridRequest(loaded, quickModel, quickModelParams, placeholderFactSheet(symbol)),
      ),
  }));
  const events = perSymbol.reduce((total, { ids }) => total + ids.length, 0);
  const tokens = perSymbol.reduce((total, entry) => total + entry.tokens, 0);
  const basis =
    observed === undefined
      ? `prompt chars/4 plus a ${String(PER_CALL_UNSEEN_TOKEN_ALLOWANCE)}-token per-call allowance measured on run ${MEASURED_ALLOWANCE_RUN}; no past Forecast Grid run for ${config.provider} ${quickModel}`
      : `observed ${String(observed.tokensPerCall)} tokens/call on run ${observed.runId} (${config.provider} ${quickModel})`;
  return [
    `Forecast Grid dry run for watchlist "${plan.watchlist}": ${String(plan.symbols.length)} symbol(s) x Event Grid = ${String(events)} event(s), ${String(plan.symbols.length)} ${quickModel} call(s), ~${String(tokens)} model tokens (estimate: ${basis})`,
    ...perSymbol.map(
      ({ symbol, ids, tokens: symbolTokens }) =>
        `  ${symbol}: ${ids.join(", ")} (~${String(symbolTokens)} tokens)`,
    ),
    ...plan.gaps.map((gap) => `  skipped: ${gap.message}`),
    "No provider call was made. Re-run with --yes to spend.",
  ].join("\n");
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

function returnsPct(
  closes: readonly number[],
  sessions: readonly number[],
): Record<string, number> {
  const last = closes.at(-1);
  return Object.fromEntries(
    sessions.flatMap((count) => {
      const base = closes.at(-1 - count);
      return last === undefined || base === undefined || closes.length <= count
        ? []
        : [[String(count), round((last / base - 1) * 100)]];
    }),
  );
}

function realizedVol20dAnnualizedPct(closes: readonly number[]): number | undefined {
  if (closes.length < 21) {
    return undefined;
  }
  const window = closes.slice(-21);
  const logReturns = window.slice(1).map((close, index) => Math.log(close / window[index]!));
  const mean = logReturns.reduce((total, value) => total + value, 0) / logReturns.length;
  const variance =
    logReturns.reduce((total, value) => total + (value - mean) ** 2, 0) / (logReturns.length - 1);
  return round(Math.sqrt(variance * 252) * 100);
}

async function latestRunContext(
  dataDir: string,
  symbol: string,
  now: Date,
): Promise<{
  readonly context: Pick<ForecastGridFactSheet, "marketRegime" | "latestRun">;
  readonly gap?: SourceGap;
}> {
  const [latest] =
    (await readLatestSuccessfulInstrumentRuns(dataDir, [{ assetClass: "equity", symbol }])) ?? [];
  const fresh =
    latest !== undefined &&
    latest !== null &&
    latest.generatedAt !== null &&
    now.getTime() - Date.parse(latest.generatedAt) <= LATEST_RUN_FRESH_DAYS * DAY_MS;
  const file = fresh
    ? await readJsonFile(join(dataDir, latest.runDirName, RUN_ARTIFACT_FILES.report))
    : undefined;
  const report = file?.status === "ok" ? readReport(file.value) : undefined;
  if (!fresh || report === undefined) {
    return {
      context: {},
      gap: forecastBookGap(
        symbol,
        `Forecast Grid fact sheet has no latest-run summary or regime for ${symbol}: no readable instrument run in the last ${String(LATEST_RUN_FRESH_DAYS)} days`,
        "provider-data-missing",
      ),
    };
  }
  const marketRegime = readReportMarketRegimeLabel(report);
  return {
    context: {
      ...(marketRegime !== undefined ? { marketRegime } : {}),
      latestRun: {
        runId: report.runId,
        generatedAt: report.generatedAt,
        summary: report.summary.slice(0, LATEST_RUN_SUMMARY_CHARS),
      },
    },
  };
}

interface PricedGrid {
  readonly eventGrid: unknown;
  readonly tokens: number;
  readonly gaps: readonly SourceGap[];
}

function parseModelGrid(content: string): unknown {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) && Array.isArray(parsed.eventGrid) ? parsed.eventGrid : undefined;
  } catch {
    return undefined;
  }
}

async function priceModelGrid(input: {
  readonly symbol: string;
  readonly command: InstrumentCommand;
  readonly config: AppConfig;
  readonly provider: ModelProvider;
  readonly loaded: LoadedPrompt;
  readonly priceHistory: Awaited<ReturnType<typeof collectPriceHistory>>["priceHistory"];
  readonly events: ReturnType<typeof eventGrid>["events"];
  readonly now: Date;
}): Promise<PricedGrid> {
  const { symbol, priceHistory } = input;
  const completedCloses = (subject: string) =>
    (priceHistory.find((history) => history.symbol.toUpperCase() === subject)?.bars ?? []).filter(
      (bar) => bar.completed,
    );
  const closes = completedCloses(symbol);
  const lastBar = closes.at(-1);
  const latest = await latestRunContext(input.config.dataDir, symbol, input.now);
  const vol = realizedVol20dAnnualizedPct(closes.map((bar) => bar.close));
  const factSheet: ForecastGridFactSheet = {
    symbol,
    ...(lastBar !== undefined ? { asOf: lastBar.date, lastClose: lastBar.close } : {}),
    returnsPct: returnsPct(
      closes.map((bar) => bar.close),
      RETURN_SESSIONS,
    ),
    ...(vol !== undefined ? { realizedVol20dAnnualizedPct: vol } : {}),
    benchmark: {
      symbol: "SPY",
      returnsPct: returnsPct(
        completedCloses("SPY").map((bar) => bar.close),
        BENCHMARK_RETURN_SESSIONS,
      ),
    },
    ...latest.context,
    events: input.events.map(({ id, measurableAs, horizonTradingDays }) => ({
      id,
      measurableAs,
      horizonTradingDays,
    })),
  };
  const contextGaps = latest.gap !== undefined ? [latest.gap] : [];
  const { quickModel, quickModelParams } = resolveRunParams(input.command, input.config);
  const response = await input.provider
    .generate(forecastGridRequest(input.loaded, quickModel, quickModelParams, factSheet))
    .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (response instanceof Error) {
    return {
      eventGrid: undefined,
      tokens: 0,
      gaps: [
        ...contextGaps,
        gridJobGap(
          symbol,
          `Forecast Grid model call failed for ${symbol} (${response.name})`,
          "fetch-failed",
        ),
      ],
    };
  }
  const eventGridValue = parseModelGrid(response.content);
  return {
    eventGrid: eventGridValue,
    tokens: response.tokenEstimate,
    gaps:
      eventGridValue === undefined
        ? [
            ...contextGaps,
            gridJobGap(
              symbol,
              `Forecast Grid model response for ${symbol} was not a JSON object with an eventGrid array`,
              "malformed-response",
            ),
          ]
        : contextGaps,
  };
}

interface SymbolGridResult {
  readonly predictions: readonly Prediction[];
  readonly sources: readonly Source[];
  readonly gaps: readonly SourceGap[];
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly tokens: number;
}

async function gridForSymbol(input: {
  readonly symbol: string;
  readonly config: AppConfig;
  readonly provider: ModelProvider;
  readonly loaded: LoadedPrompt;
  readonly fetchImpl: FetchLike | undefined;
  readonly now: Date;
}): Promise<SymbolGridResult> {
  const { symbol, config, now } = input;
  const command = equityCommand(symbol);
  const { context, staleFallbackGaps } = createCollectContext(
    command,
    config.sourceOptions,
    now,
    input.fetchImpl,
  );
  const collected = await collectPriceHistory(context, symbol);
  const { snapshot } = collected.verifiedSnapshot;
  const gridSources = {
    priceHistory: collected.priceHistory,
    ...(snapshot !== undefined ? { verifiedMarketSnapshot: snapshot } : {}),
  };
  const sources = [
    ...collected.sources,
    ...(snapshot !== undefined ? [verifiedSnapshotSource(snapshot)] : []),
  ];
  const { events } = eventGrid(command, gridSources);
  const priced: PricedGrid =
    events.length > 0
      ? await priceModelGrid({ ...input, command, priceHistory: collected.priceHistory, events })
      : { eventGrid: undefined, tokens: 0, gaps: [] };
  const book = issueForecastBook({
    command,
    collectedSources: gridSources,
    modelPredictions: [],
    modelEventGrid: priced.eventGrid,
    knownSourceIds: new Set(sources.map((source) => source.id)),
    pricedBy: "the forecast-grid model",
  });
  return {
    predictions: book.predictions.map((prediction) => ({
      ...prediction,
      id: `${prediction.id}-${symbol}`,
      scoringPolicyVersion: CURRENT_SCORING_POLICY_VERSION,
    })),
    sources,
    gaps: [
      ...staleFallbackGaps,
      ...collected.sourceGaps,
      ...collected.verifiedSnapshot.sourceGaps,
      ...priced.gaps,
      ...book.gaps,
    ],
    rawSnapshots: collected.rawSnapshots,
    tokens: priced.tokens,
  };
}

function uniqueById<T extends { readonly id: string }>(items: readonly T[]): readonly T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

// Spends one quick-model call per symbol with a grid; persists parsed probabilities only, never model text.
export async function runForecastGridJob(input: {
  readonly plan: ForecastGridPlan;
  readonly config: AppConfig;
  readonly provider: ModelProvider;
  readonly fetchImpl?: FetchLike;
  readonly now: Date;
}): Promise<string> {
  const { plan, config, now } = input;
  const loaded = await loadStagePrompt(STAGE, equityCommand(plan.symbols[0]!), config.promptDir);
  const results: SymbolGridResult[] = [];
  for (const symbol of plan.symbols) {
    const options = {
      symbol,
      config,
      provider: input.provider,
      loaded,
      fetchImpl: input.fetchImpl,
      now,
    };
    // oxlint-disable-next-line no-await-in-loop -- Sequential symbols keep per-process provider rate limits.
    results.push(await gridForSymbol(options));
  }
  const runId = createRunId(now);
  const predictions = results.flatMap((result) => result.predictions);
  const gaps = dedupeSourceGaps([...plan.gaps, ...results.flatMap((result) => result.gaps)]);
  const dataGaps = [...new Set(gaps.map((gap) => sourceGapScopedReportText(gap)))];
  const { quickModel } = resolveRunParams(equityCommand(plan.symbols[0]!), config);
  const report = validateResearchReport({
    runId,
    jobType: "forecast-grid",
    assetClass: "equity",
    generatedAt: now.toISOString(),
    summary: `Forecast Grid for watchlist "${plan.watchlist}": ${String(predictions.length)} Event Grid prediction(s) issued across ${String(plan.symbols.length)} symbol(s), ${String(dataGaps.length)} data gap(s) declared.`,
    keyFindings: [],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    evidenceQuality: "low",
    dataGaps,
    predictions,
    sources: uniqueById(results.flatMap((result) => result.sources)),
    notFinancialAdvice: true,
    extras: {
      forecastGrid: {
        watchlist: plan.watchlist,
        provider: config.provider,
        model: quickModel,
        symbols: plan.symbols,
        tokenEstimate: results.reduce((total, result) => total + result.tokens, 0),
        callCount: results.filter(({ tokens }) => tokens > 0).length,
        codeVersion: readCodeVersion(),
      },
    },
  } satisfies ResearchReport);
  const { runDir } = await publishRunArtifacts(
    config.dataDir,
    runId,
    async ({ runDir: staged }) => {
      await writeJson(join(staged, RUN_ARTIFACT_FILES.report), report);
      await writeFile(
        join(staged, RUN_ARTIFACT_FILES.reportMarkdown),
        renderMarkdownReport(report, undefined, { sourceGaps: gaps }),
        "utf8",
      );
      await writeJson(join(staged, RUN_ARTIFACT_FILES.sourceGaps), gaps);
      await writeJson(
        join(staged, RUN_ARTIFACT_FILES.rawSnapshots),
        compactOversizedRawSnapshots(results.flatMap((result) => result.rawSnapshots)),
      );
    },
  );
  return runDir;
}
