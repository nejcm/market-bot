import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addWatchlistItem, consoleDbPath, createWatchlist, withConsoleDb } from "../app/console-db";
import { runCli } from "../src/app";
import { parseArgs } from "../src/cli/args";
import { CONSOLE_JOB_TYPES, jobRequestArgv } from "../src/cli/job-registry";
import type { ResearchReport } from "../src/domain/report";
import type { ModelRequest } from "../src/model/types";
import { makeReplayFetch, type DataCassette } from "../src/replay/data-cassette";
import { makeReplayProvider } from "../src/replay/llm-cassette";
import { rebuildRunArtifactIndex } from "../src/run-artifact-index";
import { loadRunArtifact } from "../src/run-artifacts";
import { buildInstrumentTimelines } from "../src/history/artifacts";
import { buildCalibrationSummary, type ResolvedPair } from "../src/scoring/calibration";
import type { FetchLike } from "../src/sources/types";
import { predictionScore, researchReport } from "./support/fixtures";

const FIXTURE_DIR = join(import.meta.dir, "fixtures", "runs", "equity-aapl-brief");
const NOW = new Date("2026-06-15T14:30:00.000Z");
const AAPL_EVENTS = ["grid-range-1", "grid-range-5", "grid-range-20", "grid-relative-5"];

let root = "";
let dataDir = "";
const env = { ...process.env };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forecast-grid-"));
  dataDir = join(root, "runs");
  process.env.MARKET_BOT_DATA_DIR = dataDir;
  process.env.MARKET_BOT_CACHE_DIR = join(root, "cache");
  globalThis.fetch = (() => {
    throw new Error("unexpected global fetch");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  process.env = { ...env };
  globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
});

function seedWatchlist(name: string, items: readonly (readonly [string, string])[]): void {
  withConsoleDb(consoleDbPath(dataDir), (db) => {
    const { id } = createWatchlist(db, name);
    for (const [assetClass, symbol] of items) {
      addWatchlistItem(db, id, assetClass, symbol);
    }
  });
}

async function cassette(): Promise<DataCassette> {
  return JSON.parse(
    await readFile(join(FIXTURE_DIR, "data-cassette.json"), "utf8"),
  ) as DataCassette;
}

const forbiddenProvider = () => {
  throw new Error("dry run must not create a provider");
};
const forbiddenFetch: FetchLike = () => {
  throw new Error("dry run must not fetch");
};

function recordingProvider(contents: readonly string[]) {
  const requests: ModelRequest[] = [];
  const replay = makeReplayProvider({
    entries: {
      "forecast-grid|fixture-model": contents.map((content) => ({ content, tokenEstimate: 321 })),
    },
  });
  return {
    requests,
    replay,
    provider: {
      ...replay,
      generate: (request: ModelRequest) => {
        requests.push(request);
        return replay.generate(request);
      },
    },
  };
}

async function spend(
  content: string | readonly string[],
  fetchImpl?: FetchLike,
): Promise<{ report: ResearchReport; runDir: string; requests: readonly ModelRequest[] }> {
  const { provider, requests } = recordingProvider(
    typeof content === "string" ? [content] : content,
  );
  const runDir = await runCli(["forecast-grid", "--watchlist", "core", "--yes"], {
    createProvider: () => provider,
    fetchImpl: fetchImpl ?? makeReplayFetch(await cassette(), FIXTURE_DIR),
    now: () => NOW,
  });
  const report = JSON.parse(await readFile(join(runDir, "report.json"), "utf8")) as ResearchReport;
  return { report, runDir, requests };
}

const allPriced = JSON.stringify({
  eventGrid: AAPL_EVENTS.map((id, index) => ({ id, probability: 0.2 + index * 0.1 })),
});

describe("forecast-grid command", () => {
  test("parses --watchlist and requires it; --yes is the only spend switch", () => {
    expect(parseArgs(["forecast-grid", "--watchlist", "core"])).toEqual({
      jobType: "forecast-grid",
      watchlist: "core",
      yes: false,
    });
    expect(parseArgs(["forecast-grid", "--watchlist", "core", "--yes"])).toMatchObject({
      yes: true,
    });
    expect(() => parseArgs(["forecast-grid"])).toThrow("requires --watchlist");
    expect(() => parseArgs(["forecast-grid", "--watchlist", "core", "--deep"])).toThrow(
      "Unknown flag: --deep",
    );
  });

  test("the console cannot queue it, so it cannot spend without --yes on the CLI", () => {
    expect(CONSOLE_JOB_TYPES).not.toContain("forecast-grid" as never);
    expect(() => jobRequestArgv({ jobType: "forecast-grid", watchlist: "core" })).toThrow(
      "Unsupported job type",
    );
  });

  test("dry run plans symbols x events x tokens with no fetch, provider, lock or write", async () => {
    seedWatchlist("core", [
      ["equity", "AAPL"],
      ["equity", "SPY"],
      ["crypto", "BTC-USD"],
    ]);
    const output = await runCli(["forecast-grid", "--watchlist", "core"], {
      createProvider: forbiddenProvider,
      fetchImpl: forbiddenFetch,
      now: () => NOW,
    });
    expect(output).toContain(`AAPL: ${AAPL_EVENTS.join(", ")}`);
    expect(output).toContain("SPY: grid-range-1, grid-range-5, grid-range-20 (");
    expect(output).toContain("2 symbol(s) x Event Grid = 7 event(s)");
    expect(output).toMatch(
      /~\d+ model tokens \(estimate: prompt chars\/4 plus a 17400-token per-call allowance measured on run 2026-10-20T17-15-13-848Z-144ec654; no past Forecast Grid run for \S+ \S+\)/u,
    );
    expect(
      Number(/AAPL: .* \(~(?<tokens>\d+) tokens\)/u.exec(output)?.groups?.tokens),
    ).toBeGreaterThan(17_400);
    expect(output).toContain("skipped: Forecast Grid skipped crypto item BTC-USD");
    expect(output).toContain("No provider call was made. Re-run with --yes to spend.");
    expect(await readdir(root)).toEqual(["console"]);
  });

  test("unknown watchlist throws without creating the console DB", async () => {
    const argv = ["forecast-grid", "--watchlist", "missing"];
    const dependencies = { createProvider: forbiddenProvider, fetchImpl: forbiddenFetch };
    await expect(runCli(argv, dependencies)).rejects.toThrow('Unknown watchlist "missing"');
    expect(existsSync(consoleDbPath(dataDir))).toBe(false);
    seedWatchlist("core", [["equity", "AAPL"]]);
    await expect(runCli([...argv, "--yes"], dependencies)).rejects.toThrow("Unknown watchlist");
  });

  test("empty and crypto-only watchlists throw before any spend or run dir", async () => {
    seedWatchlist("core", []);
    seedWatchlist("coins", [["crypto", "BTC-USD"]]);
    const dependencies = { createProvider: forbiddenProvider, fetchImpl: forbiddenFetch };
    for (const yes of [[], ["--yes"]]) {
      await expect(
        runCli(["forecast-grid", "--watchlist", "core", ...yes], dependencies),
      ).rejects.toThrow('Watchlist "core" is empty');
      await expect(
        runCli(["forecast-grid", "--watchlist", "coins", ...yes], dependencies),
      ).rejects.toThrow("has no equity symbols");
    }
    expect(existsSync(dataDir)).toBe(false);
  });

  test("replays one grid job offline into a scorable run artifact", async () => {
    seedWatchlist("core", [
      ["equity", "AAPL"],
      ["crypto", "BTC-USD"],
    ]);
    const { report, runDir, requests } = await spend(allPriced);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ stage: "forecast-grid", responseFormat: "json" });
    const user = JSON.parse(requests[0]!.messages[1]!.content) as {
      factSheet: { symbol: string; events: { id: string }[]; returnsPct: Record<string, number> };
      responseShape: { eventGrid: { probability: unknown }[] };
    };
    // A numeric example would anchor every answer on one value (0.5 is the relative baseline).
    expect(user.responseShape.eventGrid[0]?.probability).toBeString();
    expect(user.factSheet.symbol).toBe("AAPL");
    expect(user.factSheet.events.map(({ id }) => id)).toEqual(AAPL_EVENTS);
    expect(Object.keys(user.factSheet.returnsPct)).toEqual(["1", "5", "20", "60"]);

    expect(report).toMatchObject({ jobType: "forecast-grid", assetClass: "equity" });
    expect(report.symbol).toBeUndefined();
    expect(report.predictions.map(({ id }) => id)).toEqual(AAPL_EVENTS.map((id) => `${id}-AAPL`));
    for (const prediction of report.predictions) {
      expect(prediction).toMatchObject({ origin: "grid", scoringPolicyVersion: 3 });
      expect(prediction.baselineProbability).toBeNumber();
    }
    expect(report.predictions[0]?.probability).toBe(0.2);
    expect(report.sources.map(({ id }) => id)).toContain("verified-snapshot-AAPL");
    expect(report.dataGaps.join("\n")).toContain("skipped crypto item BTC-USD");
    expect(report.dataGaps.join("\n")).toContain("no latest-run summary or regime for AAPL");
    expect(report.extras?.forecastGrid).toMatchObject({
      watchlist: "core",
      symbols: ["AAPL"],
      tokenEstimate: 321,
      callCount: 1,
    });
    const dryRun = await runCli(["forecast-grid", "--watchlist", "core"], {
      createProvider: forbiddenProvider,
      fetchImpl: forbiddenFetch,
      now: () => NOW,
    });
    expect(dryRun).toContain(
      `~321 model tokens (estimate: observed 321 tokens/call on run ${report.runId} (`,
    );
    expect(await readFile(join(runDir, "report.md"), "utf8")).toContain("equity Forecast Grid");
    const loaded = await loadRunArtifact(runDir);
    expect(loaded.artifact?.report.runId).toBe(report.runId);
    const runDirs = await readdir(dataDir);
    expect(runDirs.filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("a fresh instrument run feeds the fact sheet its summary", async () => {
    seedWatchlist("core", [["equity", "AAPL"]]);
    const instrumentDir = join(dataDir, "2026-06-14T20-00-00-000Z-aaaaaaaa");
    await mkdir(instrumentDir, { recursive: true });
    await writeFile(
      join(instrumentDir, "report.json"),
      JSON.stringify(
        researchReport({
          runId: "2026-06-14T20-00-00-000Z-aaaaaaaa",
          jobType: "equity",
          assetClass: "equity",
          symbol: "AAPL",
          generatedAt: "2026-06-14T20:00:00.000Z",
          summary: "AAPL closed near its 50-day average.",
        }),
      ),
    );
    await rebuildRunArtifactIndex(dataDir);
    const { report, requests } = await spend(allPriced);
    const user = JSON.parse(requests[0]!.messages[1]!.content) as {
      factSheet: { latestRun?: { runId: string; summary: string } };
    };
    expect(user.factSheet.latestRun).toMatchObject({
      runId: "2026-06-14T20-00-00-000Z-aaaaaaaa",
      summary: "AAPL closed near its 50-day average.",
    });
    expect(report.dataGaps.join("\n")).not.toContain("no latest-run summary");
  });

  test("invalid or missing model probabilities are declared, never defaulted", async () => {
    seedWatchlist("core", [["equity", "AAPL"]]);
    const { report } = await spend(
      JSON.stringify({
        eventGrid: [
          { id: "grid-range-1", probability: 1.5 },
          { id: "grid-range-5", probability: 0.3 },
          { id: "grid-relative-5", probability: "0.4" },
        ],
      }),
    );
    expect(report.predictions.map(({ id }) => id)).toEqual(["grid-range-5-AAPL"]);
    expect(report.dataGaps.join("\n")).toContain(
      "Event Grid events not issued because the forecast-grid model returned no valid eventGrid probability for them: grid-range-1, grid-range-20, grid-relative-5",
    );
  });

  test("a non-JSON model response is a declared malformed-response gap", async () => {
    seedWatchlist("core", [["equity", "AAPL"]]);
    const { report } = await spend("probably 0.6");
    expect(report.predictions).toEqual([]);
    expect(report.dataGaps.join("\n")).toContain(
      "Forecast Grid model response for AAPL was not a JSON object with an eventGrid array",
    );
  });

  test("a symbol with short history declares its gaps instead of issuing unsupported events", async () => {
    seedWatchlist("core", [["equity", "AAPL"]]);
    const replay = makeReplayFetch(await cassette(), FIXTURE_DIR);
    const truncating: FetchLike = async (input, init) => {
      const response = await replay(input, init);
      if (!String(input instanceof Request ? input.url : input).includes("/chart/AAPL")) {
        return response;
      }
      const body = (await response.json()) as {
        chart: {
          result: [
            { timestamp: number[]; indicators: Record<string, Record<string, unknown[]>[]> },
          ];
        };
      };
      const [result] = body.chart.result;
      const keep = 10;
      result.timestamp = result.timestamp.slice(-keep);
      for (const series of Object.values(result.indicators)) {
        for (const columns of series) {
          for (const [key, values] of Object.entries(columns)) {
            columns[key] = values.slice(-keep);
          }
        }
      }
      return Response.json(body, { status: 200, headers: response.headers });
    };
    const { report } = await spend(allPriced, truncating);
    const gaps = report.dataGaps.join("\n");
    expect(gaps).toContain("Event Grid range events not issued");
    expect(gaps).toContain("Forecast Baseline omitted for grid-relative-5");
    expect(
      report.predictions.every(({ baselineProbability }) => baselineProbability === undefined),
    ).toBe(true);
  });

  test("a grid-job event and an instrument-run event on the same session count once", async () => {
    seedWatchlist("core", [["equity", "AAPL"]]);
    const { report } = await spend(allPriced);
    const relative = report.predictions.find(({ id }) => id === "grid-relative-5-AAPL")!;
    const pair = (jobType: ResolvedPair["jobType"], runId: string, id: string): ResolvedPair => ({
      prediction: { ...relative, id },
      score: predictionScore("hit", { predictionId: id, runId, scoringVersion: 3 }),
      assetClass: "equity",
      jobType,
      runId,
      generatedAt: report.generatedAt,
    });
    const summary = buildCalibrationSummary([
      pair("forecast-grid", report.runId, relative.id),
      pair("equity", "instrument-run", "grid-relative-5"),
    ]);
    expect(summary.duplicateForecastCount).toBe(1);
    expect(summary.pairedSkill?.overall?.count ?? 1).toBe(1);
  });

  test("planning reads the console DB read-only and never creates its tables", async () => {
    const dbPath = consoleDbPath(dataDir);
    await mkdir(dirname(dbPath), { recursive: true });
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE pins (run_id TEXT PRIMARY KEY)");
    legacy.close();
    await expect(
      runCli(["forecast-grid", "--watchlist", "core"], {
        createProvider: forbiddenProvider,
        fetchImpl: forbiddenFetch,
      }),
    ).rejects.toThrow('Unknown watchlist "core"');
    const after = new Database(dbPath, { readonly: true });
    const tables = after.query("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    after.close();
    expect(tables).toEqual([{ name: "pins" }]);
  });

  test("duplicate watchlist names are ambiguous, not guessed", async () => {
    seedWatchlist("core", [["equity", "AAPL"]]);
    seedWatchlist("core", [["equity", "MSFT"]]);
    await expect(
      runCli(["forecast-grid", "--watchlist", "core"], {
        createProvider: forbiddenProvider,
        fetchImpl: forbiddenFetch,
      }),
    ).rejects.toThrow('Watchlist name "core" is ambiguous: ids 1, 2');
  });

  test("each instrument timeline keeps only its own subject's grid events", async () => {
    seedWatchlist("core", [
      ["equity", "AAPL"],
      ["equity", "SPY"],
    ]);
    const { report } = await spend([allPriced, allPriced]);
    expect(report.predictions.map(({ id }) => id)).toContain("grid-range-1-SPY");
    const timelines = buildInstrumentTimelines(
      [{ report, scores: [], missAutopsies: [], snapshots: [], fundamentals: [], validation: [] }],
      report.generatedAt,
    );
    const subjects = (symbol: string) =>
      timelines
        .find((timeline) => timeline.symbol === symbol)!
        .entries.flatMap((entry) => entry.thesis.predictions.map(({ id }) => id));
    expect(subjects("AAPL")).toEqual(AAPL_EVENTS.map((id) => `${id}-AAPL`));
    expect(subjects("SPY")).toEqual(["grid-range-1-SPY", "grid-range-5-SPY", "grid-range-20-SPY"]);
  });
});
