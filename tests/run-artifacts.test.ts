import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadRunArtifact, scanRunArtifacts } from "../src/run-artifacts";
import { marketSnapshot, prediction, predictionScore, researchReport } from "./support/fixtures";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tempRunsDir(): string {
  const dir = join(
    tmpdir(),
    `market-bot-run-artifacts-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "runs",
  );
  tmpDirs.push(dirname(dir));
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("loadRunArtifact", () => {
  test("loads report, scores, and snapshots at full fidelity", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "run-ok");
    await writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-ok",
        symbol: "aapl",
        sources: [
          { id: "news-1", title: "Headline", fetchedAt: "2026-05-19T00:00:00.000Z", kind: "news" },
        ],
        predictions: [
          prediction({ id: "p-vol", kind: "volatility", subject: "AAPL" }),
          prediction({ id: "p-dir", kind: "direction", subject: "AAPL" }),
        ],
      }),
    );
    await writeJson(join(runDir, "score.json"), {
      runId: "run-ok",
      scores: [predictionScore("hit", { predictionId: "p-vol", runId: "run-ok" })],
    });
    await writeJson(join(runDir, "normalized", "market-snapshots.json"), [
      marketSnapshot({
        symbol: "AAPL",
        price: 200,
        benchmark: {
          sourceId: "bench-spy",
          symbol: "SPY",
          basis: "broad-index",
          changePercent24h: 1.2,
          observedAt: "2026-05-19T00:00:00.000Z",
        },
      }),
    ]);

    const { artifact, status } = await loadRunArtifact(runDir);

    expect(status).toEqual({ report: "ok", score: "ok" });
    expect(artifact?.runDirName).toBe("run-ok");
    // Full fidelity: sources are kept and the real prediction kind survives.
    expect(artifact?.report.sources.map((source) => source.id)).toEqual(["news-1"]);
    expect(artifact?.report.predictions.map((p) => p.kind)).toEqual(["volatility", "direction"]);
    expect(artifact?.report.symbol).toBe("AAPL");
    expect(artifact?.scores).toHaveLength(1);
    expect(artifact?.marketSnapshots[0]?.benchmark?.symbol).toBe("SPY");
  });

  test("reports an absent report directory (ENOENT) without an artifact", async () => {
    const dataDir = tempRunsDir();
    await mkdir(join(dataDir, "empty"), { recursive: true });

    const { artifact, status } = await loadRunArtifact(join(dataDir, "empty"));

    expect(artifact).toBeUndefined();
    expect(status).toEqual({ report: "absent", score: "absent" });
  });

  test("flags a present-but-broken report as malformed", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "bad-json");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.json"), "{not-json", "utf8");

    const { artifact, status } = await loadRunArtifact(runDir);

    expect(artifact).toBeUndefined();
    expect(status.report).toBe("malformed");
  });

  test("flags a well-formed JSON report with the wrong shape as malformed", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "wrong-shape");
    await writeJson(join(runDir, "report.json"), { jobType: "daily" });

    const { status } = await loadRunArtifact(runDir);

    expect(status.report).toBe("malformed");
  });

  test("treats a missing score file as absent and a broken one as malformed", async () => {
    const dataDir = tempRunsDir();

    const noScore = join(dataDir, "no-score");
    await writeJson(join(noScore, "report.json"), researchReport({ runId: "no-score" }));
    const absent = await loadRunArtifact(noScore);
    expect(absent.status).toEqual({ report: "ok", score: "absent" });
    expect(absent.artifact?.scores).toEqual([]);

    const badScore = join(dataDir, "bad-score");
    await writeJson(join(badScore, "report.json"), researchReport({ runId: "bad-score" }));
    await writeFile(join(badScore, "score.json"), "{not-json", "utf8");
    const malformed = await loadRunArtifact(badScore);
    expect(malformed.status).toEqual({ report: "ok", score: "malformed" });
    expect(malformed.artifact?.scores).toEqual([]);
  });

  test("returns no snapshots when the snapshot file is absent", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "no-snapshots");
    await writeJson(join(runDir, "report.json"), researchReport({ runId: "no-snapshots" }));

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.marketSnapshots).toEqual([]);
  });
});

describe("scanRunArtifacts", () => {
  test("returns ok artifacts and a status entry per directory", async () => {
    const dataDir = tempRunsDir();
    await writeJson(join(dataDir, "ok-1", "report.json"), researchReport({ runId: "ok-1" }));
    await writeJson(join(dataDir, "ok-2", "report.json"), researchReport({ runId: "ok-2" }));
    await mkdir(join(dataDir, "absent"), { recursive: true });
    const badDir = join(dataDir, "malformed");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "report.json"), "{bad", "utf8");

    const scan = await scanRunArtifacts(dataDir);

    expect(scan.artifacts.map((artifact) => artifact.report.runId).toSorted()).toEqual([
      "ok-1",
      "ok-2",
    ]);
    expect(scan.entries).toHaveLength(4);
    const byDir = new Map(scan.entries.map((entry) => [entry.runDirName, entry.status.report]));
    expect(byDir.get("ok-1")).toBe("ok");
    expect(byDir.get("absent")).toBe("absent");
    expect(byDir.get("malformed")).toBe("malformed");
  });

  test("returns an empty scan for a missing data directory", async () => {
    const scan = await scanRunArtifacts(join(tempRunsDir(), "does-not-exist"));
    expect(scan).toEqual({ artifacts: [], entries: [] });
  });
});
