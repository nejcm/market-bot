import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHistoricalContext } from "../src/research/historical-context";
import { compactHistoricalContext } from "../src/research/prompts/evidence-payload";
import type { PredictionScore } from "../src/scoring/types";
import { prediction, predictionScore, researchReport } from "./support/fixtures";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeRun(
  dataDir: string,
  runId: string,
  generatedAt: string,
  scores: readonly PredictionScore[] | undefined,
): Promise<void> {
  const runDir = join(dataDir, runId);
  await mkdir(runDir, { recursive: true });
  const report = researchReport({
    runId,
    jobType: "equity",
    assetClass: "equity",
    symbol: "AMD",
    generatedAt,
    predictions: ["hit", "miss", "pending"].map((id) =>
      prediction({
        id: `${runId}-${id}`,
        subject: "AMD",
        measurableAs: `close(AMD, +10) > ${id.length}`,
      }),
    ),
  });
  await writeFile(join(runDir, "report.json"), JSON.stringify(report));
  if (scores !== undefined) {
    await writeFile(join(runDir, "score.json"), JSON.stringify({ scoredAt: generatedAt, scores }));
  }
}

function score(runId: string, id: string, resolved: boolean, outcome: "hit" | "miss" = "hit") {
  return predictionScore(outcome, {
    runId,
    predictionId: `${runId}-${id}`,
    resolved,
    ...(resolved ? {} : { outcome: undefined }),
  });
}

describe("compactHistoricalContext", () => {
  test("shows resolved prior forecasts only and counts every pending one", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "market-bot-prompt-history-"));
    tmpDirs.push(dataDir);
    await writeRun(dataDir, "absent", "2026-09-20T00:00:00.000Z", undefined);
    await writeRun(dataDir, "partial", "2026-09-22T00:00:00.000Z", [
      score("partial", "hit", true),
      score("partial", "miss", true, "miss"),
    ]);
    await writeRun(dataDir, "mixed", "2026-09-24T00:00:00.000Z", [
      score("mixed", "hit", true),
      score("mixed", "miss", true, "miss"),
      score("mixed", "pending", false),
    ]);
    const context = await loadHistoricalContext({
      dataDir,
      command: { jobType: "equity", assetClass: "equity", symbol: "AMD", depth: "deep" },
      config: {
        historyOptions: {
          tickerRecentLimit: 3,
          marketRecentLimit: 0,
          recentDays: 30,
          anchorMonths: [],
          missCorrectionLimit: 0,
        },
      },
      now: new Date("2026-10-01T00:00:00.000Z"),
    });

    const runs = compactHistoricalContext(context, "all").runs as readonly {
      readonly runId: string;
      readonly predictions: readonly { readonly id: string; readonly measurableAs: string }[];
      readonly pendingPredictionCount?: number;
    }[];
    const byId = new Map(runs.map((run) => [run.runId, run]));
    expect(byId.get("absent")?.predictions).toEqual([]);
    expect(byId.get("absent")?.pendingPredictionCount).toBe(3);
    for (const runId of ["partial", "mixed"]) {
      const run = byId.get(runId);
      expect(run?.predictions.map((item) => [item.id, item.measurableAs])).toEqual([
        [`${runId}-hit`, "close(AMD, +10) > 3"],
        [`${runId}-miss`, "close(AMD, +10) > 4"],
      ]);
      expect(run?.pendingPredictionCount).toBe(1);
    }
  });
});
