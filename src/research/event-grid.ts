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
import { claimKey, parseObservableExpression, renderClaim } from "../forecast/observable";
import type { CollectedSources } from "../sources/types";
import { verifiedMarketSnapshotSourceId } from "../sources/verified-market-snapshot";
import { isRecord } from "../guards";
import { rangeReferenceBand, rangeVolatilityReference } from "./range-volatility-reference";

const GRID_RANGE_HORIZONS = [1, 5, 20] as const;
const GRID_RELATIVE_HORIZON = 5;
const GRID_BENCHMARK = "SPY";

type GridSources = Pick<CollectedSources, "verifiedMarketSnapshot" | "priceHistory">;

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
    ...(symbol === GRID_BENCHMARK ? [] : [`grid-relative-${String(GRID_RELATIVE_HORIZON)}`]),
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
    capability: "market-data",
    cause: "suppressed-by-design",
    evidenceQualityImpact: "no-cap",
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
    for (const horizon of GRID_RANGE_HORIZONS) {
      const [lo, hi] = rangeReferenceBand(reference, horizon)!;
      events.push({
        id: `grid-range-${String(horizon)}`,
        kind: "range",
        subject: symbol,
        measurableAs: `close(${symbol}, +${String(horizon)}) outside [${String(lo)}, ${String(hi)}]`,
        horizonTradingDays: horizon,
        sourceIds: [verifiedMarketSnapshotSourceId(symbol), priceHistorySourceId(symbol)],
      });
    }
  }
  if (symbol === GRID_BENCHMARK) {
    gaps.push(
      gridGap(
        symbol,
        `Event Grid relative event not issued: ${GRID_BENCHMARK} is its own benchmark`,
      ),
    );
  } else {
    const horizon = String(GRID_RELATIVE_HORIZON);
    events.push({
      id: `grid-relative-${horizon}`,
      kind: "relative",
      subject: `${symbol}:${GRID_BENCHMARK}`,
      measurableAs: `close(${symbol}, +${horizon})/close(${symbol}, 0) > close(${GRID_BENCHMARK}, +${horizon})/close(${GRID_BENCHMARK}, 0)`,
      horizonTradingDays: GRID_RELATIVE_HORIZON,
      sourceIds: [priceHistorySourceId(symbol), priceHistorySourceId(GRID_BENCHMARK)],
    });
  }
  return { events, gaps };
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

// Stamps origin and Forecast Baseline and appends priced Event Grid events; every omission is a gap.
export function issueForecastBook(input: {
  readonly command: ResearchCommand;
  readonly collectedSources: GridSources;
  readonly modelPredictions: readonly Prediction[];
  readonly modelEventGrid: unknown;
  readonly knownSourceIds: ReadonlySet<string>;
  readonly pricedBy?: string;
}): { readonly predictions: readonly Prediction[]; readonly gaps: readonly SourceGap[] } {
  const grid = eventGrid(input.command, input.collectedSources);
  const gaps: SourceGap[] = [...grid.gaps];
  const modelIds = new Set(input.modelPredictions.map((prediction) => prediction.id));
  const modelKeys = new Map(
    input.modelPredictions.map((prediction) => [claimKey(prediction.measurableAs), prediction.id]),
  );
  const pModel = modelGridProbabilities(input.modelEventGrid);
  const unpriced: string[] = [];
  const gridPredictions: Prediction[] = [];
  for (const event of grid.events) {
    const duplicateOf = modelIds.has(event.id)
      ? event.id
      : modelKeys.get(claimKey(event.measurableAs));
    const sourceIds = event.sourceIds.filter((id) => input.knownSourceIds.has(id));
    const probability = pModel.get(event.id);
    if (duplicateOf !== undefined) {
      gaps.push(
        gridGap(
          primarySymbol(event),
          `Event Grid event ${event.id} not issued separately: final-synthesis prediction ${duplicateOf} already uses its id or event`,
        ),
      );
    } else if (sourceIds.length === 0) {
      gaps.push(
        gridGap(
          primarySymbol(event),
          `Event Grid event ${event.id} not issued: none of its close sources were collected`,
        ),
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
  const unavailable = new Map<
    string,
    { symbol: string; reason: ForecastBaselineUnavailableReason; ids: string[] }
  >();
  const predictions = [
    ...input.modelPredictions.map((prediction): Prediction => ({ ...prediction, origin: "model" })),
    ...gridPredictions,
  ].map((prediction): Prediction => {
    const baseline = forecastBaseline(
      parseObservableExpression(prediction.measurableAs),
      closes,
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
        capability: "market-data",
        cause: reason === "missing-closes" ? "provider-data-missing" : "validation-failed",
        evidenceQualityImpact: "no-cap",
      }),
    );
  }
  return { predictions, gaps };
}
