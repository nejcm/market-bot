import {
  evaluateMetricSection,
  type MetricContext,
  type MetricDefinition,
  type MetricInput,
  type MetricOutcome,
} from "./metric-engine";

const DAY_MS = 86_400_000;
const ENDPOINT_TOLERANCE_DAYS = 7;
const SHORT_HISTORY_TOLERANCE_DAYS = 14;
const BENCHMARK = "SPY (S&P 500 proxy)";
type History = NonNullable<MetricContext["priceHistory"]>[number];

function priceInput(history: History, date: string): MetricInput {
  return {
    label: `${history.symbol} split-adjusted close`,
    artifact: "priceHistory",
    symbol: history.symbol,
    value: history.bars.find((bar) => bar.date === date)!.close,
    periodEnd: date,
    unit: "currency-per-share",
    ...(history.currency === undefined ? {} : { currency: history.currency }),
    sourceIds: [history.sourceId],
  };
}

function priceReturn(ctx: MetricContext, years: number, benchmark: boolean): MetricOutcome {
  const subject = ctx.priceHistory?.find(({ symbol }) => symbol === ctx.symbol.toUpperCase());
  const spy = ctx.priceHistory?.find(({ symbol }) => symbol === "SPY");
  const histories = benchmark ? [subject, spy] : [subject];
  const missing = [
    subject === undefined || subject.bars.length === 0 ? ctx.symbol : undefined,
    benchmark && (spy === undefined || spy.bars.length === 0) ? BENCHMARK : undefined,
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
  const spyDates = new Set(benchmark ? eligible(spy!).map(({ date }) => date) : []);
  const dates = eligible(subject!)
    .map(({ date }) => date)
    .filter((date) => !benchmark || spyDates.has(date))
    .toSorted();
  const end = dates.at(-1);
  const sessions = benchmark
    ? `common completed sessions with ${BENCHMARK}`
    : "issuer completed sessions";
  if (end === undefined) {
    return { status: "missing", reason: `no ${sessions}` };
  }
  const history = benchmark ? spy! : subject!;
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
      (!benchmark || spy!.reason === undefined) &&
      firstSubject !== undefined &&
      Date.parse(firstSubject) > anniversary.getTime() + ENDPOINT_TOLERANCE_DAYS * DAY_MS &&
      Date.parse(firstSubject) <= anniversary.getTime() + SHORT_HISTORY_TOLERANCE_DAYS * DAY_MS &&
      (!benchmark ||
        eligible(spy!).some(
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

const METRICS: readonly MetricDefinition[] = [1, 3, 5].flatMap((years) =>
  [false, true].map(
    (benchmark): MetricDefinition => ({
      id: `${benchmark ? "spyPriceReturn" : "priceReturn"}${String(years)}y`,
      label: `${benchmark ? BENCHMARK : "Issuer"} ${String(years)}-year price return`,
      unit: "ratio-percent",
      basis: `cumulative price return, not total return; ${benchmark ? "common" : "issuer"} completed sessions; anniversaries within ±7 days`,
      compute: (ctx) => priceReturn(ctx, years, benchmark),
    }),
  ),
);

export function pricePerformanceSection(
  ctx: MetricContext,
): ReturnType<typeof evaluateMetricSection> {
  return evaluateMetricSection("price-performance", "Price Performance", METRICS, ctx);
}
