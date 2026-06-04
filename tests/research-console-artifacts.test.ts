import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRunSummaries, readRunDetail } from "../app/artifacts";
import { researchReport } from "./support/fixtures";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("research console artifacts", () => {
  test("indexes run summaries from report artifacts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-a");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-a",
        generatedAt: "2026-06-01T00:00:00.000Z",
        keyFindings: [{ text: "Finding", sourceIds: ["s1"] }],
        predictions: [
          {
            id: "p1",
            claim: "SPY closes higher.",
            kind: "direction",
            subject: "SPY",
            measurableAs: "close(SPY, +5) > close(SPY, 0)",
            horizonTradingDays: 5,
            probability: 0.6,
            sourceIds: ["s1"],
          },
        ],
        sources: [
          { id: "s1", title: "Source", fetchedAt: "2026-06-01T00:00:00.000Z", kind: "news" },
        ],
        dataGaps: ["Missing provider"],
        extras: { depth: "deep" },
      }),
    );
    writeFileSync(join(runDir, "report.md"), "# Report\n", "utf8");
    writeJson(join(runDir, "score.json"), { scores: [] });
    writeJson(join(runDir, "normalized", "source-gaps.json"), []);

    await expect(listRunSummaries(dataDir)).resolves.toEqual([
      {
        runId: "run-a",
        generatedAt: "2026-06-01T00:00:00.000Z",
        jobType: "daily",
        assetClass: "equity",
        depth: "deep",
        confidence: "medium",
        findingCount: 1,
        predictionCount: 1,
        sourceCount: 1,
        dataGapCount: 1,
        hasScore: true,
        availableFiles: ["normalized/source-gaps.json", "report.json", "report.md", "score.json"],
      },
    ]);
  });

  test("tolerates runs with missing or malformed reports", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-b");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "report.json"), "{", "utf8");

    await expect(listRunSummaries(dataDir)).resolves.toEqual([
      {
        runId: "run-b",
        findingCount: 0,
        predictionCount: 0,
        sourceCount: 0,
        dataGapCount: 0,
        hasScore: false,
        availableFiles: ["report.json"],
      },
    ]);
  });

  test("reads structured run detail and markdown fallback", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-c");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, "report.json"), researchReport({ runId: "run-c", summary: "Summary" }));
    writeFileSync(join(runDir, "report.md"), "# Markdown\n", "utf8");

    const detail = await readRunDetail(dataDir, "run-c");

    expect(detail?.summary.runId).toBe("run-c");
    expect(detail?.report?.summary).toBe("Summary");
    expect(detail?.markdown).toBe("# Markdown\n");
  });

  test("rejects unsafe run ids", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));

    await expect(readRunDetail(dataDir, "../secret")).resolves.toBeUndefined();
    await expect(readRunDetail(dataDir, ".")).resolves.toBeUndefined();
  });
});
