// Transcendental Math functions are implementation-approximated; round2 normally absorbs ULP differences, but a .xx5 boundary can produce a one-cent cross-engine diff.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface CassetteEntry {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

interface DataCassette {
  readonly entries: Readonly<Record<string, CassetteEntry>>;
}

interface YahooQuote {
  readonly open: readonly number[];
  readonly high: readonly number[];
  readonly low: readonly number[];
  readonly close: readonly number[];
  readonly volume: readonly number[];
}

interface YahooChartPayload {
  readonly chart: {
    readonly result: readonly [
      {
        readonly timestamp: readonly number[];
        readonly indicators: {
          readonly quote: readonly [YahooQuote, ...YahooQuote[]];
        };
      },
      ...unknown[],
    ];
    readonly error: unknown;
  };
}

interface PriceSeries {
  readonly open: readonly number[];
  readonly high: readonly number[];
  readonly low: readonly number[];
  readonly close: readonly number[];
}

interface AcceptanceStatistics {
  readonly annualizedSigma: number;
  readonly maxSingleSessionMove: number;
  readonly fiveSessionSigma: number;
  readonly last30NetReturn: number;
  readonly minClose: number;
  readonly maxClose: number;
  readonly firstClose: number;
  readonly terminalClose: number;
}

const FIXTURE_ROOT = join(import.meta.dir, "..", "tests", "fixtures", "runs");
const FIXTURE_NAMES = [
  "equity-aapl-brief",
  "equity-aapl-deep",
  "equity-analysis-comprehensive",
  "equity-analysis-estimated-suppressed",
  "equity-fpi-quarterly",
  "equity-fpi-ifrs-semiannual",
] as const;
const CHART_KEY_FRAGMENT = "/v8/finance/chart/";
const SEED = 17;
const DAILY_SIGMA = 0.0155;
const TERMINAL_CLOSE = 216.6;
const BAR_COUNT = 90;
const OPEN_SHOCK_SCALE = 0.35;
const RANGE_SHOCK_SCALE = 0.45;
const NORMAL_U1_MIN = 1e-12;
const ROUND_FACTOR = 100;
const TRADING_SESSIONS_PER_YEAR = 252;
const FIVE_SESSION_WINDOW = 5;
const LAST_30_SESSION_COUNT = 30;
const MIN_ANNUALIZED_SIGMA = 0.2;
const MAX_ANNUALIZED_SIGMA = 0.28;
const MAX_SINGLE_SESSION_MOVE = 0.06;
const MIN_FIVE_SESSION_SIGMA = 0.025;
const MAX_FIVE_SESSION_SIGMA = 0.045;
const MIN_CLOSE_BOUND = 140;
const MAX_CLOSE_BOUND = 270;

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function readCassette(
  path: string,
): Promise<{ readonly raw: string; readonly parsed: DataCassette }> {
  const raw = await readFile(path, "utf8");
  return { raw, parsed: JSON.parse(raw) as DataCassette };
}

function round2(value: number): number {
  return Math.round(value * ROUND_FACTOR) / ROUND_FACTOR;
}

function valueAt(values: readonly number[], index: number, label: string): number {
  const value = values.at(index);
  invariant(value !== undefined, `${label} is missing at index ${String(index)}`);
  return value;
}

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    // oxlint-disable-next-line unicorn/number-literal-case, unicorn/numeric-separators-style -- Mulberry32 requires this exact increment.
    let value = (state += 0x6d2b_79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    // oxlint-disable-next-line unicorn/prefer-math-trunc -- Mulberry32 requires unsigned 32-bit coercion.
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function standardNormals(count: number): readonly number[] {
  const random = mulberry32(SEED);
  return Array.from({ length: count }, () => {
    const u1 = Math.max(random(), NORMAL_U1_MIN);
    const u2 = random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  });
}

function generatePriceSeries(): PriceSeries {
  const normals = standardNormals(BAR_COUNT * 2);
  // The normals[0] draw is intentionally unused because L[0] is fixed at zero; shifting indices changes every regenerated golden.
  const logPath = [0];
  for (let index = 1; index < BAR_COUNT; index += 1) {
    logPath.push(
      valueAt(logPath, index - 1, "Log path") +
        DAILY_SIGMA * valueAt(normals, index, "Close normal"),
    );
  }
  const terminalLog = logPath.at(-1);
  invariant(terminalLog !== undefined, "Generated log path must not be empty");
  const close = logPath.map((value) => round2(TERMINAL_CLOSE * Math.exp(value - terminalLog)));
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  for (let index = 0; index < BAR_COUNT; index += 1) {
    const closeValue = valueAt(close, index, "Close");
    const priorClose = index === 0 ? closeValue : valueAt(close, index - 1, "Prior close");
    const intradayNormal = valueAt(normals, BAR_COUNT + index, "Intraday normal");
    const openValue = round2(priorClose * (1 + OPEN_SHOCK_SCALE * DAILY_SIGMA * intradayNormal));
    open.push(openValue);
    high.push(
      round2(
        Math.max(openValue, closeValue) *
          (1 + RANGE_SHOCK_SCALE * DAILY_SIGMA * Math.abs(intradayNormal)),
      ),
    );
    low.push(
      round2(
        Math.min(openValue, closeValue) *
          (1 - RANGE_SHOCK_SCALE * DAILY_SIGMA * Math.abs(intradayNormal)),
      ),
    );
  }
  return { open, high, low, close };
}

function sampleStandardDeviation(values: readonly number[]): number {
  invariant(values.length > 1, "Sample standard deviation requires at least two values");
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squaredDeviations = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(squaredDeviations / (values.length - 1));
}

function acceptanceStatistics(close: readonly number[]): AcceptanceStatistics {
  const dailyReturns = close
    .slice(1)
    .map((value, index) => Math.log(value / valueAt(close, index, "Prior daily close")));
  const fiveSessionReturns = close
    .slice(FIVE_SESSION_WINDOW)
    .map((value, index) => Math.log(value / valueAt(close, index, "Prior five-session close")));
  const [firstClose] = close;
  const terminalClose = close.at(-1);
  const last30StartClose = close.at(-LAST_30_SESSION_COUNT);
  invariant(firstClose !== undefined, "Generated close path must not be empty");
  invariant(terminalClose !== undefined, "Generated close path must not be empty");
  invariant(last30StartClose !== undefined, "Generated close path must cover 30 sessions");
  return {
    annualizedSigma: sampleStandardDeviation(dailyReturns) * Math.sqrt(TRADING_SESSIONS_PER_YEAR),
    maxSingleSessionMove: Math.max(...dailyReturns.map((value) => Math.abs(value))),
    fiveSessionSigma: sampleStandardDeviation(fiveSessionReturns),
    last30NetReturn: terminalClose / last30StartClose - 1,
    minClose: Math.min(...close),
    maxClose: Math.max(...close),
    firstClose,
    terminalClose,
  };
}

function assertAcceptance(series: PriceSeries, statistics: AcceptanceStatistics): void {
  invariant(series.close.length === BAR_COUNT, `Expected ${BAR_COUNT} closes`);
  invariant(
    statistics.annualizedSigma >= MIN_ANNUALIZED_SIGMA &&
      statistics.annualizedSigma <= MAX_ANNUALIZED_SIGMA,
    `Annualized sigma ${String(statistics.annualizedSigma)} is outside the accepted range`,
  );
  invariant(
    statistics.maxSingleSessionMove < MAX_SINGLE_SESSION_MOVE,
    `Maximum single-session move ${String(statistics.maxSingleSessionMove)} is too large`,
  );
  invariant(
    statistics.fiveSessionSigma >= MIN_FIVE_SESSION_SIGMA &&
      statistics.fiveSessionSigma <= MAX_FIVE_SESSION_SIGMA,
    `Five-session sigma ${String(statistics.fiveSessionSigma)} is outside the accepted range`,
  );
  invariant(statistics.minClose > 0, "Every close must be positive");
  invariant(
    statistics.minClose >= MIN_CLOSE_BOUND && statistics.maxClose <= MAX_CLOSE_BOUND,
    `Close range ${String(statistics.minClose)}-${String(statistics.maxClose)} is outside the accepted bounds`,
  );
  invariant(statistics.last30NetReturn > 0, "Last-30-session net return must be positive");
  invariant(
    statistics.terminalClose === TERMINAL_CLOSE,
    `Terminal close must equal ${String(TERMINAL_CLOSE)}`,
  );
  invariant(
    series.high.every(
      (value, index) =>
        value >=
        Math.max(valueAt(series.open, index, "Open"), valueAt(series.close, index, "Close")),
    ),
    "Every high must cover its open and close",
  );
  invariant(
    series.low.every(
      (value, index) =>
        value <=
        Math.min(valueAt(series.open, index, "Open"), valueAt(series.close, index, "Close")),
    ),
    "Every low must cover its open and close",
  );
}

function chartEntry(cassette: DataCassette, fixtureName: string): readonly [string, CassetteEntry] {
  const matches = Object.entries(cassette.entries).filter(([key]) =>
    key.includes(CHART_KEY_FRAGMENT),
  );
  invariant(matches.length === 1, `${fixtureName} must contain exactly one Yahoo chart entry`);
  const [match] = matches;
  invariant(match !== undefined, `${fixtureName} Yahoo chart entry is missing`);
  return match;
}

function generatedChartBody(templateBody: string, series: PriceSeries): string {
  const payload = JSON.parse(templateBody) as YahooChartPayload;
  const [result] = payload.chart.result;
  const [quote] = result.indicators.quote;
  invariant(result.timestamp.length === BAR_COUNT, `Expected ${BAR_COUNT} timestamps`);
  invariant(quote.volume.length === BAR_COUNT, `Expected ${BAR_COUNT} volumes`);
  const generatedQuote: YahooQuote = {
    ...quote,
    open: series.open,
    high: series.high,
    low: series.low,
    close: series.close,
    volume: quote.volume,
  };
  return JSON.stringify({
    ...payload,
    chart: {
      ...payload.chart,
      result: [
        {
          ...result,
          timestamp: result.timestamp,
          indicators: {
            ...result.indicators,
            quote: [generatedQuote, ...result.indicators.quote.slice(1)],
          },
        },
        ...payload.chart.result.slice(1),
      ],
    },
  });
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

const series = generatePriceSeries();
const statistics = acceptanceStatistics(series.close);
assertAcceptance(series, statistics);

const fixtures = await Promise.all(
  FIXTURE_NAMES.map(async (fixtureName) => {
    const path = join(FIXTURE_ROOT, fixtureName, "data-cassette.json");
    const cassette = await readCassette(path);
    return { fixtureName, path, raw: cassette.raw, cassette: cassette.parsed };
  }),
);
const sourceEntries = fixtures.map(({ fixtureName, cassette }) =>
  chartEntry(cassette, fixtureName),
);
const [sourceEntry] = sourceEntries;
invariant(sourceEntry !== undefined, "At least one source chart entry is required");
const [, { body: sourceBody }] = sourceEntry;
invariant(
  sourceEntries.every(([, entry]) => entry.body === sourceBody),
  "Target fixture chart bodies must be identical before generation",
);
const body = generatedChartBody(sourceBody, series);

await Promise.all(
  fixtures.map(async ({ fixtureName, path, raw, cassette }) => {
    const [, existingEntry] = chartEntry(cassette, fixtureName);
    const encodedExistingBody = JSON.stringify(existingEntry.body);
    const encodedGeneratedBody = JSON.stringify(body);
    const occurrences = raw.split(encodedExistingBody).length - 1;
    invariant(
      occurrences === 1,
      `${fixtureName} chart body must occur exactly once in its cassette`,
    );
    await writeFile(path, raw.replace(encodedExistingBody, encodedGeneratedBody), "utf8");
  }),
);

process.stdout.write(
  `${[
    `seed: ${String(SEED)}`,
    `annualized sigma: ${formatPercent(statistics.annualizedSigma)}`,
    `max single-session move: ${formatPercent(statistics.maxSingleSessionMove)}`,
    `5-session sigma: ${formatPercent(statistics.fiveSessionSigma)}`,
    `last-30 net return: ${formatPercent(statistics.last30NetReturn)}`,
    `close range: ${statistics.minClose.toFixed(2)}-${statistics.maxClose.toFixed(2)}`,
    `first close: ${statistics.firstClose.toFixed(2)}`,
    `terminal close: ${statistics.terminalClose.toFixed(2)}`,
    `updated fixtures: ${String(fixtures.length)}`,
  ].join("\n")}\n`,
);
