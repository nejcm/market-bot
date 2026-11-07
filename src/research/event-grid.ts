import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import type { Prediction } from "../domain/prediction";
import { sourceGap } from "../domain/source-gaps";
import type { SourceGap } from "../domain/sources";
import {
  FORECAST_BASELINE_RETURN_WINDOW,
  FORECAST_BASELINE_VERSION,
  forecastBaseline,
  type BaselineClose,
  type ForecastBaselineUnavailableReason,
} from "../forecast/baseline";
import {
  claimKey,
  instrumentsForMeasurableAs,
  parseObservableExpression,
  renderClaim,
} from "../forecast/observable";
import type { CollectedSources } from "../sources/types";
import { verifiedMarketSnapshotSourceId } from "../sources/verified-market-snapshot";
import { isRecord } from "../guards";
import { exchangeProfileFor } from "../domain/exchange-profile";
import { isNonSecEquityListing } from "../sources/identity-gate";
import {
  rangeReferenceBand,
  rangeVolatilityReference,
  scoredSessions,
} from "./range-volatility-reference";

const GRID_RANGE_HORIZONS = [1, 5, 20] as const;
const GRID_RELATIVE_HORIZON = 5;
const US_GRID_BENCHMARK = "SPY";

export function gridBenchmark(symbol: string): string {
  return exchangeProfileFor(symbol)?.benchmark ?? US_GRID_BENCHMARK;
}

type GridSources = Pick<
  CollectedSources,
  "verifiedMarketSnapshot" | "priceHistory" | "resolvedInstrumentIdentity"
>;

export interface EventGridEvent {
  readonly id: string;
  readonly kind: "range" | "relative";
  readonly subject: string;
  readonly measurableAs: string;
  readonly horizonTradingDays: number;
  readonly sourceIds: readonly string[];
}

// Ids eventGrid issues when every input is present; dry runs plan from this without fetching.
export function plannedEventGridIds(symbol: string): readonly string[] {
  return [
    ...GRID_RANGE_HORIZONS.map((horizon) => `grid-range-${String(horizon)}`),
    ...(symbol === gridBenchmark(symbol) ? [] : [`grid-relative-${String(GRID_RELATIVE_HORIZON)}`]),
  ];
}

function priceHistorySourceId(symbol: string): string {
  return `price-history-${symbol}`;
}

function gridGap(symbol: string, message: string): SourceGap {
  return sourceGap({
    source: "event-grid",
    symbol,
    message,
    capability: "forecast-book",
    cause: "suppressed-by-design",
    evidenceQualityImpact: "no-cap",
    triage: "diagnostic",
  });
}

// The fixed Event Grid every equity instrument run issues; bounds reuse the prompt's ±1σ reference bands.
export function eventGrid(
  command: ResearchCommand,
  collectedSources: GridSources,
): { readonly events: readonly EventGridEvent[]; readonly gaps: readonly SourceGap[] } {
  if (!isInstrumentCommand(command)) {
    return { events: [], gaps: [] };
  }
  const { symbol } = command;
  if (command.assetClass !== "equity") {
    return {
      events: [],
      gaps: [
        gridGap(
          symbol,
          "Event Grid not issued: crypto runs collect no split-adjusted close history for the fixed grid",
        ),
      ],
    };
  }
  const events: EventGridEvent[] = [];
  const gaps: SourceGap[] = [];
  const reference = rangeVolatilityReference(collectedSources.verifiedMarketSnapshot);
  if (reference === undefined || "gap" in reference) {
    gaps.push(
      gridGap(
        symbol,
        "Event Grid range events not issued: the ±1σ range reference that defines their bounds is unavailable",
      ),
    );
  } else {
    const degenerate: string[] = [];
    for (const horizon of GRID_RANGE_HORIZONS) {
      const band = rangeReferenceBand(reference, horizon);
      if (band === undefined) {
        degenerate.push(`grid-range-${String(horizon)}`);
        continue;
      }
      const [lo, hi] = band;
      events.push({
        id: `grid-range-${String(horizon)}`,
        kind: "range",
        subject: symbol,
        measurableAs: `close(${symbol}, +${String(horizon)}) outside [${String(lo)}, ${String(hi)}]`,
        horizonTradingDays: horizon,
        sourceIds: [verifiedMarketSnapshotSourceId(symbol), priceHistorySourceId(symbol)],
      });
    }
    if (degenerate.length > 0) {
      gaps.push(
        gridGap(
          symbol,
          `Event Grid events not issued: the ±1σ band rounds to zero width for ${degenerate.join(", ")}`,
        ),
      );
    }
  }
  const benchmark = gridBenchmark(symbol);
  if (symbol === benchmark) {
    gaps.push(
      gridGap(symbol, `Event Grid relative event not issued: ${benchmark} is its own benchmark`),
    );
  } else {
    const horizon = String(GRID_RELATIVE_HORIZON);
    events.push({
      id: `grid-relative-${horizon}`,
      kind: "relative",
      subject: `${symbol}:${benchmark}`,
      measurableAs: `close(${symbol}, +${horizon})/close(${symbol}, 0) > close(${benchmark}, +${horizon})/close(${benchmark}, 0)`,
      horizonTradingDays: GRID_RELATIVE_HORIZON,
      sourceIds: [priceHistorySourceId(symbol), priceHistorySourceId(benchmark)],
    });
  }
  return { events, gaps };
}

export function issuableGridEvents(
  events: readonly EventGridEvent[],
  knownSourceIds: ReadonlySet<string>,
  collectedSources: GridSources,
): readonly EventGridEvent[] {
  const closeSourceIds = collectedCloseSourceIds(knownSourceIds, collectedSources);
  return events.filter((event) => unissuableReason(event, closeSourceIds) === undefined);
}

// A price-history Source is published even when it returned no bars.
function collectedCloseSourceIds(
  knownSourceIds: ReadonlySet<string>,
  collectedSources: GridSources,
): ReadonlySet<string> {
  const empty = new Set(
    (collectedSources.priceHistory ?? [])
      .filter(({ bars }) => !bars.some((bar) => bar.completed))
      .map(({ sourceId }) => sourceId),
  );
  return new Set([...knownSourceIds].filter((id) => !empty.has(id)));
}

// Fails closed: an expression whose symbols do not parse cannot be resolved by the scorer.
function unissuableReason(
  event: EventGridEvent,
  knownSourceIds: ReadonlySet<string>,
): string | undefined {
  const legs = instrumentsForMeasurableAs(event.measurableAs);
  if (legs.length === 0) {
    return `its expression ${event.measurableAs} does not parse`;
  }
  const uncollected = legs.filter(
    (symbol) =>
      ![verifiedMarketSnapshotSourceId(symbol), priceHistorySourceId(symbol)].some(
        (id) => event.sourceIds.includes(id) && knownSourceIds.has(id),
      ),
  );
  return uncollected.length > 0
    ? `no close source was collected for ${uncollected.join(", ")}`
    : undefined;
}

function primarySymbol(event: EventGridEvent): string {
  return event.subject.split(":")[0]!;
}

export function modelGridProbabilities(value: unknown): ReadonlyMap<string, number> {
  const probabilities = new Map<string, number>();
  for (const item of Array.isArray(value) ? value : []) {
    if (
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.probability === "number" &&
      item.probability >= 0 &&
      item.probability <= 1 &&
      !probabilities.has(item.id)
    ) {
      probabilities.set(item.id, item.probability);
    }
  }
  return probabilities;
}

const UNAVAILABLE_REASON_TEXT: Record<ForecastBaselineUnavailableReason, string> = {
  "missing-closes": "no split-adjusted close history was collected",
  "short-history": `fewer than ${String(FORECAST_BASELINE_RETURN_WINDOW + 1)} split-adjusted closes were collected`,
  "split-signature": "a split-like jump in the split-adjusted closes makes volatility unreliable",
  "zero-volatility": "the split-adjusted closes show no price movement",
  "stale-closes": "its latest close is more than a few days older than the other leg's",
  "unscored-sessions":
    "the sessions scoring spans after its latest close are unknown (non-US listing or unverified latest session)",
};

function closesBySymbol(
  collectedSources: GridSources,
): ReadonlyMap<string, readonly BaselineClose[]> {
  const closes = new Map<string, readonly BaselineClose[]>(
    (collectedSources.priceHistory ?? []).map((history) => [
      history.symbol.toUpperCase(),
      history.bars.filter((bar) => bar.completed),
    ]),
  );
  // The ±1σ grid bands center on the snapshot's last close, which may be a session price history
  // Withholds as unverified; the newest bar's split-adjusted close equals its raw close.
  const snapshot = collectedSources.verifiedMarketSnapshot;
  const history = snapshot === undefined ? undefined : closes.get(snapshot.symbol.toUpperCase());
  const lastDate = history?.at(-1)?.date;
  if (snapshot !== undefined && history !== undefined && lastDate !== undefined) {
    closes.set(snapshot.symbol.toUpperCase(), [
      ...history,
      ...snapshot.recentCloses.filter(({ date }) => date > lastDate),
    ]);
  }
  return closes;
}

// A non-SEC listing without verified closes has no price to resolve an Observable Prediction against (ADR 0006).
export function forecastsWithheld(command: ResearchCommand, sources: GridSources): boolean {
  return (
    sources.verifiedMarketSnapshot === undefined &&
    isNonSecEquityListing(command, sources.resolvedInstrumentIdentity)
  );
}

function withheldForecastGap(
  command: ResearchCommand,
  sources: GridSources,
  droppedCount: number,
): SourceGap | undefined {
  if (!forecastsWithheld(command, sources) || !isInstrumentCommand(command)) {
    return undefined;
  }
  return sourceGap({
    source: "forecast-book",
    symbol: command.symbol,
    message: `No Observable Predictions issued for ${command.symbol}: no verified closes were collected for this non-SEC listing, so no prediction could be resolved from public price data${droppedCount > 0 ? ` (${String(droppedCount)} model prediction(s) dropped)` : ""}`,
    provider: "market-bot",
    capability: "forecast-book",
    cause: "suppressed-by-design",
    evidenceQualityImpact: "no-cap",
  });
}

function offExchangePredictions(
  command: ResearchCommand,
  predictions: readonly Prediction[],
): { readonly kept: readonly Prediction[]; readonly gaps: readonly SourceGap[] } {
  const profile = isInstrumentCommand(command) ? exchangeProfileFor(command.symbol) : undefined;
  if (!isInstrumentCommand(command) || profile === undefined) {
    return { kept: predictions, gaps: [] };
  }
  const offExchangeLegs = (prediction: Prediction) =>
    instrumentsForMeasurableAs(prediction.measurableAs)
      .filter((leg) => !leg.startsWith("FRED:"))
      .map((leg) => leg.replace(/^IV:/u, ""))
      .filter(
        (leg) => leg.toUpperCase() !== profile.benchmark && exchangeProfileFor(leg) !== profile,
      );
  const withheld = predictions.filter((prediction) => offExchangeLegs(prediction).length > 0);
  if (withheld.length === 0) {
    return { kept: predictions, gaps: [] };
  }
  const legs = [...new Set(withheld.flatMap(offExchangeLegs))].join(", ");
  return {
    kept: predictions.filter((prediction) => !withheld.includes(prediction)),
    gaps: [
      sourceGap({
        source: "forecast-book",
        symbol: command.symbol,
        message: `Model prediction(s) ${withheld.map(({ id }) => id).join(", ")} for ${command.symbol} withheld: they compare against ${legs}, which trades outside ${profile.exchange} in another currency or session calendar than the ${profile.currency} listing; relative events use ${profile.benchmark}`,
        provider: "market-bot",
        capability: "forecast-book",
        cause: "suppressed-by-design",
        evidenceQualityImpact: "no-cap",
        triage: "diagnostic",
      }),
    ],
  };
}

// Stamps origin and Forecast Baseline and appends priced Event Grid events; every omission is a gap.
// A model prediction restating a grid event is folded into that event (ADR 0003, amended 2026-10-23).
export function issueForecastBook(input: {
  readonly command: ResearchCommand;
  readonly collectedSources: GridSources;
  readonly modelPredictions: readonly Prediction[];
  readonly modelEventGrid: unknown;
  readonly knownSourceIds: ReadonlySet<string>;
  readonly generatedAt: string;
  readonly pricedBy?: string;
}): {
  readonly predictions: readonly Prediction[];
  readonly gaps: readonly SourceGap[];
  readonly withheld?: true;
} {
  const withheld = withheldForecastGap(
    input.command,
    input.collectedSources,
    input.modelPredictions.length,
  );
  if (withheld !== undefined) {
    return { predictions: [], gaps: [withheld], withheld: true };
  }
  const onExchange = offExchangePredictions(input.command, input.modelPredictions);
  const grid = eventGrid(input.command, input.collectedSources);
  const gaps: SourceGap[] = [...onExchange.gaps, ...grid.gaps];
  const pModel = modelGridProbabilities(input.modelEventGrid);
  const restated = new Map<string, Prediction>();
  const closeSourceIds = collectedCloseSourceIds(input.knownSourceIds, input.collectedSources);
  const issuable = issuableGridEvents(grid.events, input.knownSourceIds, input.collectedSources);
  const modelPredictions = onExchange.kept.filter((prediction) => {
    const event = issuable.find(
      (candidate) =>
        candidate.id === prediction.id ||
        claimKey(candidate.measurableAs) === claimKey(prediction.measurableAs),
    );
    if (event === undefined) {
      return true;
    }
    if (!restated.has(event.id)) {
      restated.set(event.id, prediction);
    }
    return false;
  });
  const unpriced: string[] = [];
  const gridPredictions: Prediction[] = [];
  for (const event of grid.events) {
    const sourceIds = event.sourceIds.filter((id) => closeSourceIds.has(id));
    const probability = pModel.get(event.id) ?? restated.get(event.id)?.probability;
    const unissuable = unissuableReason(event, closeSourceIds);
    if (unissuable !== undefined) {
      gaps.push(
        gridGap(primarySymbol(event), `Event Grid event ${event.id} not issued: ${unissuable}`),
      );
    } else if (probability === undefined) {
      unpriced.push(event.id);
    } else {
      gridPredictions.push({
        id: event.id,
        claim: renderClaim(parseObservableExpression(event.measurableAs)),
        kind: event.kind,
        subject: event.subject,
        measurableAs: event.measurableAs,
        horizonTradingDays: event.horizonTradingDays,
        probability,
        sourceIds,
        origin: "grid",
      });
    }
  }
  if (unpriced.length > 0) {
    gaps.push(
      gridGap(
        primarySymbol(grid.events[0]!),
        `Event Grid events not issued because ${input.pricedBy ?? "the final synthesis"} returned no valid eventGrid probability for them: ${unpriced.join(", ")}`,
      ),
    );
  }
  const closes = closesBySymbol(input.collectedSources);
  const splitDates = new Map(
    (input.collectedSources.priceHistory ?? []).flatMap(({ symbol, splitDates: dates }) =>
      dates === undefined ? [] : [[symbol.toUpperCase(), dates] as const],
    ),
  );
  const runDate = input.generatedAt.slice(0, 10);
  const snapshot = input.collectedSources.verifiedMarketSnapshot;
  // The resolver quarantines an unverified session, moving the primary's scoring origin before infoCutoff.
  const unverifiedSymbol =
    snapshot?.latestSessionStatus === "unverified" ? snapshot.symbol.toUpperCase() : undefined;
  const sessionsAfter = (symbol: string, infoCutoff: string, horizon: number) =>
    symbol.toUpperCase() === unverifiedSymbol
      ? undefined
      : scoredSessions(
          { symbol, assetClass: input.command.assetClass },
          infoCutoff,
          runDate,
          horizon,
        );
  const unavailable = new Map<
    string,
    { symbol: string; reason: ForecastBaselineUnavailableReason; ids: string[] }
  >();
  const predictions = [
    ...modelPredictions.map((prediction): Prediction => ({ ...prediction, origin: "model" })),
    ...gridPredictions,
  ].map((prediction): Prediction => {
    const baseline = forecastBaseline(
      parseObservableExpression(prediction.measurableAs),
      closes,
      sessionsAfter,
      splitDates,
    );
    if (baseline.status === "unavailable") {
      const key = `${baseline.symbol}|${baseline.reason}`;
      const entry = unavailable.get(key) ?? { ...baseline, ids: [] };
      unavailable.set(key, { ...entry, ids: [...entry.ids, prediction.id] });
    }
    return baseline.status === "computed"
      ? {
          ...prediction,
          baselineProbability: baseline.probability,
          baselineVersion: FORECAST_BASELINE_VERSION,
          infoCutoff: baseline.infoCutoff,
        }
      : prediction;
  });
  for (const { symbol, reason, ids } of unavailable.values()) {
    gaps.push(
      sourceGap({
        source: "forecast-baseline",
        symbol,
        message: `Forecast Baseline omitted for ${ids.join(", ")}: ${UNAVAILABLE_REASON_TEXT[reason]} for ${symbol}`,
        capability: "forecast-book",
        cause: reason === "missing-closes" ? "provider-data-missing" : "validation-failed",
        evidenceQualityImpact: "no-cap",
        triage: "diagnostic",
      }),
    );
  }
  return { predictions, gaps };
}
