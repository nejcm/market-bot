import { DAY_MS } from "../../config/shared";
import { exchangeProfileFor } from "../../domain/exchange-profile";
import {
  evaluateMetricSection,
  type MetricContext,
  type MetricDefinition,
  type MetricInput,
  type MetricOutcome,
} from "./metric-engine";

const ENDPOINT_TOLERANCE_DAYS = 7;
const SHORT_HISTORY_TOLERANCE_DAYS = 14;
type History = NonNullable<MetricContext["priceHistory"]>[number];

function priceInput(history: History, date: string): MetricInput {
  return {
    label: `${history.symbol} split-adjusted close`,
    artifact: "priceHistory",
    symbol: history.symbol,
    value: history.bars.find((bar) => bar.date === date)!.close,
    periodEnd: date,
    // Yahoo prefixes index symbols with "^"; an index level is points, not a per-share price.
    unit: history.symbol.startsWith("^") ? "index-points" : "currency-per-share",
    ...(history.currency === undefined ? {} : { currency: history.currency }),
    sourceIds: [history.sourceId],
  };
}

interface Benchmark {
  readonly symbol: string;
  readonly name: string;
  readonly idPrefix: string;
}

const US_BENCHMARK: Benchmark = {
  symbol: "SPY",
  name: "SPY (S&P 500 proxy)",
  idPrefix: "spyPriceReturn",
};

function benchmarkFor(symbol: string): Benchmark {
  const profile = exchangeProfileFor(symbol);
  return profile === undefined
    ? US_BENCHMARK
    : {
        symbol: profile.benchmark,
        name: `${profile.benchmarkName} (${profile.benchmark})`,
        idPrefix: "benchmarkPriceReturn",
      };
}

function priceReturn(
  ctx: MetricContext,
  years: number,
  benchmark: boolean,
  { symbol: benchmarkSymbol, name: benchmarkName }: Benchmark,
): MetricOutcome {
  const subject = ctx.priceHistory?.find(({ symbol }) => symbol === ctx.symbol.toUpperCase());
  const index = ctx.priceHistory?.find(({ symbol }) => symbol === benchmarkSymbol);
  const histories = benchmark ? [subject, index] : [subject];
  const missing = [
    subject === undefined || subject.bars.length === 0 ? ctx.symbol : undefined,
    benchmark && (index === undefined || index.bars.length === 0) ? benchmarkName : undefined,
  ].filter((label) => label !== undefined);
  if (missing.length > 0) {
    return {
      status: "missing",
      reason: `no completed price history for ${missing.join(" or ")}${histories.flatMap((history) => (history?.reason === undefined ? [] : [`; ${history.symbol}: ${history.reason}`])).join("")}`,
    };
  }
  const eligible = (history: History) =>
    history.bars.filter(
      ({ date, close, completed }) =>
        history.priceMode === "split-adjusted-close" &&
        completed === true &&
        Number.isFinite(Date.parse(date)) &&
        Number.isFinite(close) &&
        close > 0 &&
        date <= (ctx.asOf ?? "").slice(0, 10),
    );
  const benchmarkDates = new Set(benchmark ? eligible(index!).map(({ date }) => date) : []);
  const dates = eligible(subject!)
    .map(({ date }) => date)
    .filter((date) => !benchmark || benchmarkDates.has(date))
    .toSorted();
  const end = dates.at(-1);
  const sessions = benchmark
    ? `common completed sessions with ${benchmarkName}`
    : "issuer completed sessions";
  if (end === undefined) {
    return { status: "missing", reason: `no ${sessions}` };
  }
  const history = benchmark ? index! : subject!;
  const endInput = priceInput(history, end);
  const age = (Date.parse((ctx.asOf ?? "").slice(0, 10)) - Date.parse(end)) / DAY_MS;
  if (!Number.isFinite(age) || age > ENDPOINT_TOLERANCE_DAYS || age < 0) {
    return {
      status: "missing",
      reason: `stale ${sessions} as of ${end}`,
      periodEnd: end,
      inputs: [endInput],
    };
  }
  const anniversary = new Date(end);
  anniversary.setUTCFullYear(anniversary.getUTCFullYear() - years);
  const [start] = dates
    .filter(
      (date) =>
        date < end &&
        Math.abs(Date.parse(date) - anniversary.getTime()) <= ENDPOINT_TOLERANCE_DAYS * DAY_MS,
    )
    .toSorted(
      (a, b) =>
        Math.abs(Date.parse(a) - anniversary.getTime()) -
          Math.abs(Date.parse(b) - anniversary.getTime()) || a.localeCompare(b),
    );
  if (start === undefined) {
    const [firstSubject] = eligible(subject!)
      .map(({ date }) => date)
      .toSorted();
    const shortHistory =
      subject!.reason === undefined &&
      (!benchmark || index!.reason === undefined) &&
      firstSubject !== undefined &&
      Date.parse(firstSubject) > anniversary.getTime() + ENDPOINT_TOLERANCE_DAYS * DAY_MS &&
      Date.parse(firstSubject) <= anniversary.getTime() + SHORT_HISTORY_TOLERANCE_DAYS * DAY_MS &&
      (!benchmark ||
        eligible(index!).some(
          ({ date }) =>
            Math.abs(Date.parse(date) - anniversary.getTime()) <= ENDPOINT_TOLERANCE_DAYS * DAY_MS,
        ));
    return {
      status: "missing",
      reason: shortHistory
        ? `issuer price history begins ${firstSubject}, after the ${String(years)}-year anniversary`
        : `no ${sessions} within ±7 days of the ${String(years)}-year anniversary`,
      ...(shortHistory ? { cause: "insufficient-history" as const } : {}),
      periodEnd: end,
      inputs: [endInput],
    };
  }
  const startInput = priceInput(history, start);
  const value = Number(endInput.value) / Number(startInput.value) - 1;
  if (!Number.isFinite(value)) {
    return {
      status: "missing",
      reason: "price return is non-finite",
      periodEnd: end,
      inputs: [startInput, endInput],
    };
  }
  return {
    status: "value",
    value,
    periodEnd: end,
    basis: `${String(years)}-year cumulative price return, not total return; split-adjusted closes, ${start} to ${end}, ${sessions}; quote currency ${history.currency ?? "unknown"}, no FX conversion`,
    inputs: [startInput, endInput],
  };
}

const metrics = (index: Benchmark): readonly MetricDefinition[] =>
  [1, 3, 5].flatMap((years) =>
    [false, true].map(
      (benchmark): MetricDefinition => ({
        id: `${benchmark ? index.idPrefix : "priceReturn"}${String(years)}y`,
        label: `${benchmark ? index.name : "Issuer"} ${String(years)}-year price return`,
        unit: "ratio-percent",
        basis: `cumulative price return, not total return; ${benchmark ? "common" : "issuer"} completed sessions; anniversaries within ±7 days`,
        change: { over: `over ${String(years)}y` },
        compute: (ctx) => priceReturn(ctx, years, benchmark, index),
      }),
    ),
  );

export function pricePerformanceSection(
  ctx: MetricContext,
): ReturnType<typeof evaluateMetricSection> {
  return evaluateMetricSection(
    "price-performance",
    "Price Performance",
    metrics(benchmarkFor(ctx.symbol)),
    ctx,
  );
}
