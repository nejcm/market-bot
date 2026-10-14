import { describe, expect, test } from "bun:test";
import type { RunSummary } from "../app/types";
import {
  filterInstrumentRunHistory,
  instrumentRunHistory,
  instrumentRunHistoryFor,
  instrumentRunHistoryGroupKey,
  instrumentRunHistoryRows,
  type InstrumentRunHistoryEntry,
} from "../app/client/view-model";

function run(runId: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId,
    findingCount: 0,
    predictionCount: 0,
    sourceCount: 0,
    dataGapCount: 0,
    hasScore: false,
    availableFiles: [],
    ...overrides,
  };
}

function equityRun(
  runId: string,
  generatedAt: string,
  overrides: Partial<RunSummary> = {},
): RunSummary {
  return run(runId, {
    jobType: "equity",
    assetClass: "equity",
    symbol: "AAPL",
    generatedAt,
    ...overrides,
  });
}

function groupKeys(entries: readonly InstrumentRunHistoryEntry[]): readonly string[] {
  return entries.map((entry) =>
    entry.kind === "group" ? `group:${entry.group.key}` : `run:${entry.run.runId}`,
  );
}

describe("instrument run history", () => {
  test("groups runs by asset class and symbol with brief and deep runs in one group", () => {
    const older = equityRun("aapl-deep", "2026-06-01T09:00:00Z", { depth: "deep" });
    const newer = equityRun("aapl-brief", "2026-06-03T09:00:00Z", { depth: "brief" });
    const lowercase = equityRun("aapl-legacy", "2026-05-30T09:00:00Z", { symbol: "aapl" });
    const crypto = run("btc-brief", {
      jobType: "crypto",
      assetClass: "crypto",
      symbol: "BTC",
      generatedAt: "2026-06-02T09:00:00Z",
    });
    const research = run("thematic", { jobType: "research", generatedAt: "2026-06-04T09:00:00Z" });

    expect(instrumentRunHistory([newer, older, lowercase, crypto, research])).toEqual([
      { kind: "run", run: research },
      {
        kind: "group",
        group: {
          key: "equity:AAPL",
          assetClass: "equity",
          symbol: "AAPL",
          head: newer,
          pastRuns: [older, lowercase],
        },
      },
      {
        kind: "group",
        group: {
          key: "crypto:BTC",
          assetClass: "crypto",
          symbol: "BTC",
          head: crypto,
          pastRuns: [],
        },
      },
    ]);
  });

  test("keeps the newest generated run as the head regardless of input order", () => {
    const oldest = equityRun("run-1", "2026-06-01T09:00:00Z");
    const newest = equityRun("run-2", "2026-06-05T09:00:00Z");
    const middle = equityRun("run-3", "2026-06-03T09:00:00Z");

    const [entry] = instrumentRunHistory([oldest, middle, newest]);
    expect(entry?.kind).toBe("group");
    expect(entry?.kind === "group" ? entry.group.head : undefined).toEqual(newest);
    expect(entry?.kind === "group" ? entry.group.pastRuns : []).toEqual([middle, oldest]);
  });

  test("interleaves groups and standalone runs by their dated position", () => {
    const aaplNew = equityRun("aapl-new", "2026-06-03T09:00:00Z");
    const daily = run("daily-report", { jobType: "daily", generatedAt: "2026-06-02T09:00:00Z" });
    const btc = run("btc-run", {
      jobType: "crypto",
      assetClass: "crypto",
      symbol: "BTC",
      generatedAt: "2026-06-01T09:00:00Z",
    });

    expect(groupKeys(instrumentRunHistory([btc, daily, aaplNew]))).toEqual([
      "group:equity:AAPL",
      "run:daily-report",
      "group:crypto:BTC",
    ]);
  });

  test("sorts runs lacking a usable generatedAt after dated ones", () => {
    const undated = run("undated", { jobType: "research" });
    const dated = run("dated", { jobType: "daily", generatedAt: "2026-06-01T09:00:00Z" });
    const invalid = run("invalid-date", { jobType: "daily", generatedAt: "not-a-date" });
    const undatedInstrument = equityRun("undated-equity", "");

    expect(groupKeys(instrumentRunHistory([undatedInstrument, undated, dated, invalid]))).toEqual([
      "run:dated",
      "group:equity:AAPL",
      "run:undated",
      "run:invalid-date",
    ]);
  });

  test("keeps a whole group while any of its runs matches the filter", () => {
    const head = equityRun("run-head", "2026-06-03T09:00:00Z", { depth: "brief" });
    const matchingPast = equityRun("run-past", "2026-06-01T09:00:00Z", { depth: "deep" });
    const cryptoHead = run("btc-head", {
      jobType: "crypto",
      assetClass: "crypto",
      symbol: "BTC",
      generatedAt: "2026-06-04T09:00:00Z",
    });
    const standalone = run("daily-report", {
      jobType: "daily",
      generatedAt: "2026-06-02T09:00:00Z",
    });
    const entries = instrumentRunHistory([cryptoHead, head, matchingPast, standalone]);

    const matchingGroup = filterInstrumentRunHistory(entries, "all", "deep");
    expect(groupKeys(matchingGroup)).toEqual(["group:equity:AAPL"]);
    const [onlyEntry] = matchingGroup;
    expect(onlyEntry?.kind === "group" ? onlyEntry.group.head : undefined).toEqual(head);
    expect(onlyEntry?.kind === "group" ? onlyEntry.group.pastRuns : []).toEqual([matchingPast]);

    const byType = filterInstrumentRunHistory(entries, "crypto", "");
    expect(groupKeys(byType)).toEqual(["group:crypto:BTC"]);

    expect(groupKeys(filterInstrumentRunHistory(entries, "daily", ""))).toEqual([
      "run:daily-report",
    ]);
    expect(filterInstrumentRunHistory(entries, "all", "missing")).toEqual([]);
  });

  test("flattens sidebar rows and reveals past runs only for expanded groups", () => {
    const head = equityRun("aapl-head", "2026-06-03T09:00:00Z");
    const past = equityRun("aapl-past", "2026-06-01T09:00:00Z");
    const standalone = run("daily-report", {
      jobType: "daily",
      generatedAt: "2026-06-02T09:00:00Z",
    });
    const entries = instrumentRunHistory([head, past, standalone]);

    const collapsed = instrumentRunHistoryRows(entries, []);
    expect(collapsed.map((row) => [row.kind, row.run.runId])).toEqual([
      ["head", "aapl-head"],
      ["standalone", "daily-report"],
    ]);
    expect(collapsed[0]?.expanded).toBe(false);

    const expanded = instrumentRunHistoryRows(entries, ["equity:AAPL"]);
    expect(expanded.map((row) => [row.kind, row.run.runId])).toEqual([
      ["head", "aapl-head"],
      ["past", "aapl-past"],
      ["standalone", "daily-report"],
    ]);
    expect(expanded[0]?.expanded).toBe(true);
  });

  test("returns every run for one instrument newest first", () => {
    const head = equityRun("aapl-head", "2026-06-03T09:00:00Z");
    const past = equityRun("aapl-past", "2026-06-01T09:00:00Z");
    const btc = run("btc-run", {
      jobType: "crypto",
      assetClass: "crypto",
      symbol: "BTC",
      generatedAt: "2026-06-02T09:00:00Z",
    });
    const entries = instrumentRunHistory([head, past, btc]);

    expect(instrumentRunHistoryFor(entries, "equity", "aapl")).toEqual([head, past]);
    expect(instrumentRunHistoryFor(entries, "crypto", "BTC")).toEqual([btc]);
    expect(instrumentRunHistoryFor(entries, "equity", "MSFT")).toEqual([]);
    expect(instrumentRunHistoryFor(entries, "", "")).toEqual([]);
  });

  test("finds the group that owns a selected past run", () => {
    const head = equityRun("aapl-head", "2026-06-03T09:00:00Z");
    const past = equityRun("aapl-past", "2026-06-01T09:00:00Z");
    const standalone = run("daily-report", {
      jobType: "daily",
      generatedAt: "2026-06-02T09:00:00Z",
    });
    const entries = instrumentRunHistory([head, past, standalone]);

    expect(instrumentRunHistoryGroupKey(entries, "aapl-past")).toBe("equity:AAPL");
    expect(instrumentRunHistoryGroupKey(entries, "aapl-head")).toBeUndefined();
    expect(instrumentRunHistoryGroupKey(entries, "daily-report")).toBeUndefined();
    expect(instrumentRunHistoryGroupKey(entries, "missing")).toBeUndefined();
  });
});
