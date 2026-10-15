import { describe, expect, test } from "bun:test";
import { pricePerformanceSection } from "../src/sources/extended-evidence/price-performance";
import type { MetricContext } from "../src/sources/extended-evidence/metric-engine";
import { collectPriceHistory } from "../src/sources/yahoo-price-history";
import {
  createCollectContext,
  resetSourceResilienceForTests,
  setSourceHostMinDelayMsForTests,
} from "../src/sources/source-request";
import { violatesResearchOnly } from "../src/domain/research-language";
import { sourceGapReportText } from "../src/domain/source-gaps";
import { renderMetricSections } from "../src/report/markdown-metric-sections";
import { metricSectionsView } from "../app/client/view-model-metric-sections";
import {
  collectedSourcesForGapView,
  sourceGapVisibleForView,
} from "../src/research/prompts/source-gap-view";
import { config, contextWithHistory } from "./support/research-context-helpers";
import { buildEvidencePayload } from "../src/research/prompts/evidence-payload";
import { assertPricePerformanceInvariants } from "./support/run-fixtures/assertions";
import { collectedSources, researchReport } from "./support/fixtures";

const AS_OF = "2026-07-24T22:00:00.000Z";
const command = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "TEST",
  depth: "brief",
} as const;
const DATES = ["2021-07-23", "2023-07-24", "2025-07-24", "2026-07-24"];
type History = NonNullable<MetricContext["priceHistory"]>[number];

function history(symbol: string, closes = [50, 75, 100, 120], currency?: string): History {
  return {
    symbol,
    sourceId: `price-history-${symbol}`,
    priceMode: "split-adjusted-close",
    bars: DATES.map((date, i) => ({ date, close: closes[i]!, completed: true })),
    ...(currency === undefined ? {} : { currency }),
  };
}

function evaluate(priceHistory?: MetricContext["priceHistory"], asOf = AS_OF) {
  return pricePerformanceSection({
    symbol: "TEST",
    asOf,
    ...(priceHistory === undefined ? {} : { priceHistory }),
  });
}

const CLOSED = {
  start: Date.parse("2026-07-24T13:30:00Z") / 1000,
  end: Date.parse("2026-07-24T20:00:00Z") / 1000,
};

function chart(
  symbol: string,
  dates: readonly string[],
  closes: readonly (number | null)[],
  regular: unknown = CLOSED,
) {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            currency: symbol === "SPY" ? "USD" : "CAD",
            ...(regular === null ? {} : { currentTradingPeriod: { regular } }),
          },
          timestamp: dates.map((date) => Date.parse(date) / 1000),
          indicators: {
            quote: [
              {
                close: closes,
                open: closes,
                high: closes,
                low: closes,
                volume: closes.map(() => 100),
              },
            ],
            adjclose: [{ adjclose: closes.map(() => 999) }],
          },
        },
      ],
    },
  };
}

async function collect(payloadFor: (symbol: string) => unknown, at = AS_OF) {
  resetSourceResilienceForTests();
  setSourceHostMinDelayMsForTests(0);
  const { context } = createCollectContext(
    command,
    { equityMoverLimit: 1, cryptoMoverLimit: 1, newsLimit: 1, sourceTimeoutMs: 1000 },
    new Date(at),
    async (input) => {
      const symbol = decodeURIComponent(new URL(String(input)).pathname.split("/").at(-1)!);
      return Response.json(payloadFor(symbol));
    },
    [],
  );
  return collectPriceHistory(context, "TEST");
}

describe("Price Performance Metric Section", () => {
  test("uses price closes for six cumulative returns with common sessions and frozen reader values", async () => {
    const collected = await collect((symbol) =>
      chart(symbol, DATES, symbol === "SPY" ? [100, 150, 200, 240] : [50, 75, 100, 120]),
    );
    expect(collected.rawSnapshots.map(({ adapter }) => adapter)).toEqual([
      "yahoo-price-history",
      "yahoo-price-history",
    ]);
    expect(collected.sources.map(({ id }) => id)).toEqual([
      "price-history-TEST",
      "price-history-SPY",
    ]);
    const { section, sourceGaps } = evaluate(collected.priceHistory);
    expect(sourceGaps).toEqual([]);
    for (const [i, expected] of [0.2, 0.2, 0.6, 0.6, 1.4, 1.4].entries()) {
      expect(Number(section.metrics[i]?.value)).toBeCloseTo(expected, 12);
    }
    expect(section.metrics.every(({ periodEnd }) => periodEnd === "2026-07-24")).toBe(true);
    expect(section.metrics[1]?.label).toBe("SPY (S&P 500 proxy) 1-year price return");
    expect(section.metrics[0]?.sourceIds).toEqual(["price-history-TEST"]);
    expect(section.metrics[0]?.inputs[0]).toMatchObject({ symbol: "TEST" });
    expect(section.metrics[0]?.inputs[0]).not.toHaveProperty("key");
    expect(section.metrics[0]?.basis).toContain("quote currency CAD");
    expect(section.metrics[1]?.basis).toContain("quote currency USD");
    expect(section.metrics[1]?.sourceIds).toEqual(["price-history-SPY"]);
    const report = researchReport({
      generatedAt: AS_OF,
      dataGaps: [],
      extras: { metricSections: [section] },
      sources: collected.sources,
    });
    expect(renderMetricSections(report)).toContain("Session ending 2026-07-24");
    expect(renderMetricSections(report)).toContain("quote currency CAD");
    expect(renderMetricSections(report)).not.toContain("FY ending");
    expect(
      metricSectionsView(report as unknown as Record<string, unknown>)?.[0]?.metrics[0],
    ).toMatchObject({
      value: "20.0%",
      period: "Session ending 2026-07-24",
      basis: expect.stringContaining("quote currency CAD"),
    });
    const run = {
      collectedSources: collectedSources({
        rawSnapshots: collected.rawSnapshots,
        metricSections: [section],
      }),
      markdown: "### Price Performance\n",
    };
    assertPricePerformanceInvariants(run, report);
    expect(() =>
      assertPricePerformanceInvariants(run, { ...report, extras: { metricSections: [] } }),
    ).toThrow();
    const altered = {
      ...section,
      metrics: section.metrics.map((metric, i) => (i === 0 ? { ...metric, value: 999 } : metric)),
    };
    expect(() =>
      assertPricePerformanceInvariants(run, { ...report, extras: { metricSections: [altered] } }),
    ).toThrow();
    expect(
      evaluate([history("TEST"), history("SPY")]).section.metrics.every(
        ({ status }) => status === "value",
      ),
    ).toBe(true);
    expect(
      evaluate([
        history("TEST", [50, 75, 100, 120], "CAD"),
        history("SPY", [100, 150, 200, 240], "USD"),
      ]).sourceGaps,
    ).toEqual([]);
  });

  test("aligns both endpoints, with nearest anniversary within inclusive ±7 days and no older fallback", () => {
    const subject = history("TEST");
    const spy = history("SPY");
    const shifted = (date: string, benchmark = false) => {
      const original = benchmark ? spy : subject;
      return {
        ...original,
        bars: original.bars.map((bar) => (bar.date === "2025-07-24" ? { ...bar, date } : bar)),
      };
    };
    for (const date of ["2025-07-17", "2025-07-31"]) {
      const partner = {
        ...spy,
        bars: spy.bars.map((bar) => (bar.date === "2025-07-24" ? { ...bar, date } : bar)),
      };
      expect(evaluate([shifted(date), partner]).section.metrics[0]).toMatchObject({
        status: "value",
        inputs: [{ periodEnd: date }, { periodEnd: "2026-07-24" }],
      });
    }
    for (const date of ["2025-07-16", "2025-08-01"]) {
      expect(evaluate([shifted(date), shifted(date, true)]).section.metrics[0]).toMatchObject({
        status: "missing",
        reason: expect.stringContaining("within ±7 days"),
      });
    }
    const laggingSpy = {
      ...spy,
      bars: spy.bars.map((bar) =>
        bar.date === "2026-07-24" ? { ...bar, date: "2026-07-23" } : bar,
      ),
    };
    const commonPrior = {
      ...subject,
      bars: [...subject.bars, { date: "2026-07-23", close: 110, completed: true }],
    };
    expect(evaluate([commonPrior, laggingSpy]).section.metrics[0]?.periodEnd).toBe("2026-07-23");
    expect(evaluate([commonPrior, laggingSpy]).section.metrics[1]?.periodEnd).toBe("2026-07-23");
    const laterSubject = {
      ...subject,
      bars: [...subject.bars, { date: "2026-07-25", close: 999, completed: true }],
    };
    expect(evaluate([laterSubject, spy]).section.metrics[0]?.periodEnd).toBe("2026-07-24");
    expect(evaluate([shifted("2025-07-25"), spy]).section.metrics[0]?.status).toBe("missing");
    const choices = {
      ...subject,
      bars: [...subject.bars, { date: "2025-07-23", close: 90, completed: true }],
    };
    expect(
      evaluate([
        choices,
        { ...spy, bars: [...spy.bars, { date: "2025-07-23", close: 90, completed: true }] },
      ]).section.metrics[0]?.inputs[0]?.periodEnd,
    ).toBe("2025-07-24");
  });

  test("chooses the earlier common session on an equidistant anniversary tie", () => {
    const histories = [history("TEST"), history("SPY")].map((original) => ({
      ...original,
      bars: original.bars.flatMap((bar) =>
        bar.date === "2025-07-24"
          ? [
              { ...bar, date: "2025-07-23", close: 100 },
              { ...bar, date: "2025-07-25", close: 110 },
            ]
          : [bar],
      ),
    }));
    expect(evaluate(histories).section.metrics[0]).toMatchObject({
      status: "value",
      value: expect.closeTo(0.2, 12),
      inputs: [{ periodEnd: "2025-07-23" }, { periodEnd: "2026-07-24" }],
    });
  });

  test("withholds in-progress bars from direct metric callers", () => {
    for (const symbol of ["TEST", "SPY"]) {
      const histories = [history("TEST"), history("SPY")].map((original) => ({
        ...original,
        bars: original.bars.map((bar) => ({
          ...bar,
          completed: !(original.symbol === symbol && bar.date === "2026-07-24"),
        })),
      }));
      const result = evaluate(histories, "2026-07-24T18:00:00Z");
      expect(result.section.metrics.every(({ status }) => status === "missing")).toBe(true);
      expect(result.sourceGaps).toHaveLength(1);
    }
  });

  test("adjusts both histories for a 10:1 split inside the window and pins adjusted lineage", async () => {
    const splitDate = "2026-01-23";
    const timestamp = Date.parse(splitDate) / 1000;
    const collected = await collect((symbol) => {
      const payload = chart(
        symbol,
        [...DATES.slice(0, 3), splitDate, DATES[3]!],
        [500, 750, 1000, 110, 120],
      );
      return {
        chart: {
          result: [
            {
              ...payload.chart.result[0],
              events: {
                splits: {
                  [String(timestamp)]: {
                    date: timestamp,
                    numerator: 10,
                    denominator: 1,
                    splitRatio: "10:1",
                  },
                },
              },
            },
          ],
        },
      };
    });
    expect(
      collected.sources.every(
        ({ url }) => url !== undefined && new URL(url).searchParams.get("events") === "div,splits",
      ),
    ).toBe(true);
    const { section, sourceGaps } = evaluate(collected.priceHistory);
    expect(sourceGaps).toEqual([]);
    for (const [i, expected] of [0.2, 0.2, 0.6, 0.6, 1.4, 1.4].entries()) {
      expect(Number(section.metrics[i]?.value)).toBeCloseTo(expected, 12);
      expect(section.metrics[i]?.basis).toContain("split-adjusted");
    }
    const report = researchReport({
      generatedAt: AS_OF,
      dataGaps: [],
      extras: { metricSections: [section] },
      sources: collected.sources,
    });
    assertPricePerformanceInvariants(
      {
        collectedSources: collectedSources({
          rawSnapshots: collected.rawSnapshots,
          metricSections: [section],
        }),
        markdown: "### Price Performance\n",
      },
      report,
    );
  });

  test("distinguishes no returned history from invalid closes or split metadata", async () => {
    for (const payload of [{ chart: { result: null } }, chart("TEST", [], [])]) {
      const result = await collect(() => payload);
      expect(result.priceHistory[0]?.reason).toBe("price history unavailable: no rows returned");
    }
    const result = await collect((symbol) => chart(symbol, DATES, [null, null, null, null]));
    expect(result.priceHistory[0]?.reason).toBe(
      "split-adjusted history unavailable: invalid closes or split metadata",
    );
  });

  test("declares missing history when split metadata is unavailable or ambiguous", async () => {
    const timestamp = Date.parse("2025-07-24") / 1000;
    const valid = { date: timestamp, numerator: 10, denominator: 1, splitRatio: "10:1" };
    for (const events of [
      null,
      { splits: null },
      { splits: { [String(timestamp)]: { ...valid, splitRatio: "2:1" } } },
      {
        splits: {
          [String(timestamp)]: valid,
          [String(timestamp + 1)]: { ...valid, date: timestamp + 1 },
        },
      },
    ]) {
      const collected = await collect((symbol) => {
        const payload = chart(symbol, DATES, [50, 75, 100, 120]);
        return { chart: { result: [{ ...payload.chart.result[0], events }] } };
      });
      const result = evaluate(collected.priceHistory);
      expect(result.section.metrics.every(({ status }) => status === "missing")).toBe(true);
      expect(result.sourceGaps).toHaveLength(1);
      expect(result.sourceGaps[0]?.message).toContain("split-adjusted");
    }
  });

  test("declares one material no-cap gap on absent, empty, malformed or stale history", () => {
    expect(
      evaluate([history("TEST", [50, 75, Number.MIN_VALUE, Number.MAX_VALUE]), history("SPY")])
        .section.metrics[0],
    ).toMatchObject({ status: "missing", reason: "price return is non-finite" });
    for (const histories of [
      undefined,
      [],
      [history("TEST")],
      [history("SPY")],
      [history("TEST"), { ...history("SPY"), bars: [] }],
      [history("TEST", [50, 75, 0, Number.NaN]), history("SPY")],
    ]) {
      const result = evaluate(histories);
      expect(result.section.metrics).toHaveLength(6);
      expect(result.sourceGaps).toHaveLength(1);
      expect(result.sourceGaps[0]).toMatchObject({
        source: "price-performance",
        triage: "material",
        evidenceQualityImpact: "no-cap",
      });
      expect(result.section.metrics.every(({ status }) => status === "missing")).toBe(true);
    }
    expect(
      evaluate([history("TEST"), history("SPY")], "2026-07-31T22:00:00.000Z").sourceGaps,
    ).toEqual([]);
    expect(
      evaluate([history("TEST"), history("SPY")], "2026-08-01T00:00:00.000Z").section.metrics[0],
    ).toMatchObject({ status: "missing", inputs: [{ periodEnd: "2026-07-24" }] });
    expect(
      evaluate([history("TEST"), history("SPY")], "bad").section.metrics.every(
        ({ status }) => status === "missing",
      ),
    ).toBe(true);
  });

  test("withholds open and unverified sessions before finding a common end and rejects partial bars", async () => {
    const regular = {
      start: Date.parse("2026-07-24T13:30:00Z") / 1000,
      end: Date.parse("2026-07-24T20:00:00Z") / 1000,
    };
    const dates = ["2025-07-23", "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-25"];
    const open = await collect(
      (symbol) => chart(symbol, dates, [50, 90, 100, 500, 999], regular),
      "2026-07-24T18:00:00Z",
    );
    expect(open.priceHistory[0]?.bars.at(-1)?.date).toBe("2026-07-23");
    expect(evaluate(open.priceHistory).section.metrics[0]).toMatchObject({
      status: "value",
      value: 1,
      periodEnd: "2026-07-23",
    });
    const unknown = await collect((symbol) => chart(symbol, dates, [50, 90, 100, 500, 999], null));
    expect(unknown.priceHistory[0]?.bars.at(-1)?.date).toBe("2026-07-22");
    const malformed = await collect((symbol) => chart(symbol, DATES, [50, 75, 100, null], regular));
    expect(evaluate(malformed.priceHistory).section.metrics[0]?.status).toBe("missing");
    const empty = await collect(() => ({}));
    expect(evaluate(empty.priceHistory).sourceGaps).toHaveLength(1);
    const mismatch = await collect(() => chart("WRONG", DATES, [50, 75, 100, 120]));
    expect(mismatch.verifiedSnapshot.snapshot).toBeUndefined();
    expect(evaluate(mismatch.priceHistory).section.metrics[0]).toMatchObject({
      status: "missing",
      reason: expect.stringContaining("Yahoo returned WRONG"),
    });
  });

  test("exposes metrics and all nested section gaps to synthesis, retaining Web Gather filtering", () => {
    const { section, sourceGaps } = evaluate();
    const existing = { source: "existing", message: "retained" };
    const collected = collectedSources({
      metricSections: [section],
      sourceGaps: [...sourceGaps, existing],
      extendedEvidence: { items: [], gaps: sourceGaps },
      marketContext: { assetClass: "equity", items: [], gaps: sourceGaps },
    });
    for (const view of ["all", "web-gather"] as const) {
      const projected = collectedSourcesForGapView(view, collected);
      expect(projected.sourceGaps).toEqual(view === "all" ? [...sourceGaps, existing] : [existing]);
      expect(projected.extendedEvidence?.gaps).toEqual(view === "all" ? sourceGaps : []);
      expect(projected.marketContext?.gaps).toEqual(view === "all" ? sourceGaps : []);
      expect(sourceGapVisibleForView(view, sourceGapReportText(sourceGaps[0]!))).toBe(
        view === "all",
      );
      const evidence = buildEvidencePayload(
        { includePriorCalibration: false, sourceGapView: view, webSourceText: "metadata" },
        command,
        collected,
        config,
        { ...contextWithHistory(command), analysisAsOf: AS_OF },
      );
      expect(JSON.stringify(evidence).includes("{{metric:price-performance.priceReturn1y}}")).toBe(
        view === "all",
      );
      expect(JSON.stringify(evidence.sourceGaps).includes("price-performance")).toBe(
        view === "all",
      );
    }
    expect(collected.sourceGaps).toHaveLength(2);
    const report = researchReport({ extras: { metricSections: [section] } });
    expect(renderMetricSections(report)).toContain("no completed price history");
    expect(
      metricSectionsView(report as unknown as Record<string, unknown>)?.[0]?.metrics[0]?.reason,
    ).toContain("SPY (S&P 500 proxy)");
    for (const evaluated of [evaluate(), evaluate([history("TEST"), history("SPY")])]) {
      expect(violatesResearchOnly(JSON.stringify(evaluated))).toBeNull();
    }
  });
});

test("truncated issuer history and benchmark gaps remain material", () => {
  const subject = { ...history("TEST"), bars: history("TEST").bars.slice(2) };
  const result = evaluate([subject, history("SPY")]);
  expect(result.section.metrics[0]?.status).toBe("value");
  for (const metric of result.section.metrics.slice(2)) {
    expect(metric).toMatchObject({
      status: "missing",
      reason: expect.stringContaining("no common completed session"),
    });
    expect(metric).not.toHaveProperty("cause");
  }
  expect(result.sourceGaps[0]?.triage).toBe("material");
  const shortSpy = { ...history("SPY"), bars: history("SPY").bars.slice(2) };
  expect(evaluate([history("TEST"), shortSpy]).sourceGaps[0]?.triage).toBe("material");
  expect(evaluate([subject, { ...shortSpy, reason: "fetch failed" }]).sourceGaps[0]?.triage).toBe(
    "material",
  );
});

test.each([
  ["2021-07-31", "value", undefined],
  ["2021-08-01", "missing", "diagnostic"],
  ["2021-08-07", "missing", "diagnostic"],
  ["2021-08-08", "missing", "material"],
] as const)(
  "issuer window starting %s uses bounded short-history triage",
  (date, status, triage) => {
    const subject = history("TEST");
    const spy = history("SPY");
    const result = evaluate([
      { ...subject, bars: [{ ...subject.bars[0]!, date }, ...subject.bars.slice(1)] },
      { ...spy, bars: [spy.bars[0]!, { ...spy.bars[0]!, date }, ...spy.bars.slice(1)] },
    ]);
    expect(result.section.metrics[4]?.status).toBe(status);
    expect(result.sourceGaps[0]?.triage).toBe(triage);
    for (const metric of result.section.metrics.slice(4)) {
      expect(metric.cause).toBe(triage === "diagnostic" ? "insufficient-history" : undefined);
    }
  },
);
