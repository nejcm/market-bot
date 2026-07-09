import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildThesisDelta,
  rebuildHistoryArtifacts,
  rebuildHistoryArtifactsIfStale,
  searchHistoryIndex,
} from "../src/history/artifacts";
import { readInstrumentTimeline } from "../src/history/timeline-reader";
import type { ModelProvider } from "../src/model/types";
import { prediction, researchReport, verifiedMarketSnapshot } from "./support/fixtures";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeRun(
  dataDir: string,
  runId: string,
  generatedAt: string,
  summary: string,
  risk: string,
  options: { readonly writeScore?: boolean } = {},
): void {
  const writeScore = options.writeScore ?? true;
  const runDir = join(dataDir, runId);
  mkdirSync(join(runDir, "normalized"), { recursive: true });
  writeJson(
    join(runDir, "report.json"),
    researchReport({
      runId,
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      generatedAt,
      summary,
      keyFindings: [{ text: `${summary} finding`, sourceIds: ["s1"] }],
      risks: [{ text: risk, sourceIds: ["s1"] }],
      dataGaps: [`${summary} gap`],
      predictions: [
        prediction({
          id: "p1",
          claim: `${summary} AAPL closes higher.`,
          subject: "AAPL",
          measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
          sourceIds: ["s1"],
        }),
      ],
      sources: [
        {
          id: "s1",
          title: `${summary} Yahoo source`,
          fetchedAt: generatedAt,
          kind: "news",
          assetClass: "equity",
          symbol: "AAPL",
          provider: "yahoo",
          identity: {
            aliases: [{ provider: "yahoo", idKind: "symbol", value: "AAPL" }],
          },
        },
      ],
    }),
  );
  if (writeScore) {
    writeJson(join(runDir, "score.json"), {
      scores: [
        {
          predictionId: "p1",
          runId,
          resolved: runId === "run-new",
          outcome: runId === "run-new" ? "hit" : undefined,
          observedAt: runId === "run-new" ? generatedAt : undefined,
          attemptCount: 1,
          evidence: {},
        },
      ],
    });
  }
  writeJson(join(runDir, "normalized", "market-snapshots.json"), [
    {
      symbol: "AAPL",
      assetClass: "equity",
      price: runId === "run-new" ? 120 : 100,
      changePercent24h: 1,
      volume: 1_000_000,
      observedAt: generatedAt,
    },
  ]);
  writeJson(join(runDir, "normalized", "sec-fundamentals.json"), [
    { symbol: "AAPL", revenueGrowth: runId === "run-new" ? 0.2 : 0.1 },
  ]);
}

describe("history artifacts", () => {
  test("rebuilds derived index and per-instrument timeline from run artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "market-bot-history-artifacts-"));
    const dataDir = join(rootDir, "runs");
    mkdirSync(dataDir);
    writeRun(dataDir, "run-old", "2026-06-01T00:00:00.000Z", "Old thesis", "Old risk");
    writeRun(dataDir, "run-new", "2026-06-05T00:00:00.000Z", "New thesis", "New risk");
    mkdirSync(join(dataDir, "malformed"));
    writeFileSync(join(dataDir, "malformed", "report.json"), "{", "utf8");

    const result = await rebuildHistoryArtifacts(dataDir, new Date("2026-06-06T00:00:00.000Z"));

    expect(result.sourceRunCount).toBe(2);
    expect(result.malformedRunCount).toBe(1);
    expect(result.instrumentCount).toBe(1);
    const index = JSON.parse(await readFile(join(rootDir, "history", "index.json"), "utf8")) as {
      readonly entries: readonly { readonly section: string; readonly text: string }[];
    };
    expect(index.entries.some((entry) => entry.section === "openQuestions")).toBe(true);
    const timeline = JSON.parse(
      await readFile(join(rootDir, "history", "instruments", "equity-AAPL.json"), "utf8"),
    ) as { readonly entries: readonly { readonly runId: string }[] };
    expect(timeline.entries.map((entry) => entry.runId)).toEqual(["run-old", "run-new"]);
    const readResult = await readInstrumentTimeline(dataDir, "equity", "aapl");
    expect(readResult.source).toBe("history");
    expect(readResult.timeline.entries.map((entry) => entry.runId)).toEqual(["run-old", "run-new"]);
  });

  test("searches structured history index with filters", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "market-bot-history-search-"));
    const dataDir = join(rootDir, "runs");
    mkdirSync(dataDir);
    writeRun(dataDir, "run-old", "2026-06-01T00:00:00.000Z", "Old thesis", "Old risk");
    writeRun(dataDir, "run-new", "2026-06-05T00:00:00.000Z", "New thesis", "New risk");
    await rebuildHistoryArtifacts(dataDir, new Date("2026-06-06T00:00:00.000Z"));

    const results = await searchHistoryIndex(dataDir, {
      query: "New risk",
      symbol: "AAPL",
      assetClass: "equity",
      jobType: "equity",
      section: "risks",
      from: "2026-06-05",
      to: "2026-06-05",
      limit: 5,
    });

    expect(results.map((result) => result.runId)).toEqual(["run-new"]);
    expect(results[0]?.section).toBe("risks");
  });

  test("rebuilds stale derived history after the canonical run set changes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "market-bot-history-drift-"));
    const dataDir = join(rootDir, "runs");
    mkdirSync(dataDir);
    writeRun(dataDir, "run-old", "2026-06-01T00:00:00.000Z", "Old thesis", "Old risk");
    await rebuildHistoryArtifacts(dataDir, new Date("2026-06-02T00:00:00.000Z"));
    writeRun(dataDir, "run-new", "2026-06-05T00:00:00.000Z", "New thesis", "New risk");

    const rebuilt = await rebuildHistoryArtifactsIfStale(
      dataDir,
      new Date("2026-06-06T00:00:00.000Z"),
    );
    const results = await searchHistoryIndex(dataDir, { query: "New risk" });

    expect(rebuilt?.sourceRunCount).toBe(2);
    expect(results.map((entry) => entry.runId)).toEqual(["run-new"]);
  });

  test("does not rebuild history when the canonical run set matches", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "market-bot-history-current-"));
    const dataDir = join(rootDir, "runs");
    mkdirSync(dataDir);
    writeRun(dataDir, "run-old", "2026-06-01T00:00:00.000Z", "Old thesis", "Old risk");
    await rebuildHistoryArtifacts(dataDir, new Date("2026-06-02T00:00:00.000Z"));
    let rebuildCalls = 0;

    const rebuilt = await rebuildHistoryArtifactsIfStale(dataDir, new Date(), async () => {
      rebuildCalls += 1;
      throw new Error("unexpected rebuild");
    });

    expect(rebuilt).toBeUndefined();
    expect(rebuildCalls).toBe(0);
  });

  test("rebuilds stale derived history after mutable sidecars change", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "market-bot-history-sidecar-drift-"));
    const dataDir = join(rootDir, "runs");
    mkdirSync(dataDir);
    writeRun(dataDir, "run-old", "2026-06-01T00:00:00.000Z", "Old thesis", "Old risk");
    await rebuildHistoryArtifacts(dataDir, new Date("2026-06-02T00:00:00.000Z"));
    writeJson(join(dataDir, "run-old", "score.json"), {
      scores: [
        {
          predictionId: "p1",
          runId: "run-old",
          resolved: true,
          outcome: "miss",
          observedAt: "2026-06-03T00:00:00.000Z",
          attemptCount: 1,
          evidence: {},
          changed: "sidecar fingerprint changes",
        },
      ],
    });

    const rebuilt = await rebuildHistoryArtifactsIfStale(
      dataDir,
      new Date("2026-06-04T00:00:00.000Z"),
    );

    expect(rebuilt?.sourceRunCount).toBe(1);
  });

  test("preserves explicit malformed and unsupported derived-history failures", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "market-bot-history-invalid-"));
    const dataDir = join(rootDir, "runs");
    const derivedDir = join(rootDir, "history");
    mkdirSync(dataDir);
    mkdirSync(derivedDir);
    writeFileSync(join(derivedDir, "index.json"), "{", "utf8");

    await expect(rebuildHistoryArtifactsIfStale(dataDir)).rejects.toThrow(
      /Malformed derived history index/u,
    );

    writeJson(join(derivedDir, "index.json"), { version: 999, entries: [] });
    await expect(rebuildHistoryArtifactsIfStale(dataDir)).rejects.toThrow(
      /Unsupported derived history index schema/u,
    );
  });

  test("builds deterministic thesis deltas and persists explicit narratives", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "market-bot-history-delta-"));
    const dataDir = join(rootDir, "runs");
    mkdirSync(dataDir);
    writeRun(dataDir, "run-old", "2026-06-01T00:00:00.000Z", "Old thesis", "Old risk");
    writeRun(dataDir, "run-new", "2026-06-05T00:00:00.000Z", "New thesis", "New risk");
    await rebuildHistoryArtifacts(dataDir, new Date("2026-06-06T00:00:00.000Z"));

    const provider: ModelProvider = {
      name: "test",
      generate: async () => ({
        content: "The research thesis shifted from old evidence to new evidence.",
        tokenEstimate: 10,
        costEstimateUsd: 0.01,
      }),
    };
    const delta = await buildThesisDelta({
      dataDir,
      symbol: "AAPL",
      assetClass: "equity",
      since: "run-old",
      to: "run-new",
      narrative: true,
      provider,
      model: "test-model",
      now: new Date("2026-06-06T00:00:00.000Z"),
    });

    expect(delta.sections.summary?.added).toEqual(["New thesis"]);
    expect(delta.sections.summary?.removed).toEqual(["Old thesis"]);
    expect(delta.narrative?.model).toBe("test-model");
    const persisted = await readFile(
      join(rootDir, "history", "deltas", "equity-AAPL-run-old-to-run-new.json"),
      "utf8",
    );
    expect(persisted).toContain("The research thesis shifted");
  });

  test("rejects narratives with trade-action language and persists nothing", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "market-bot-history-reject-"));
    const dataDir = join(rootDir, "runs");
    mkdirSync(dataDir);
    writeRun(dataDir, "run-old", "2026-06-01T00:00:00.000Z", "Old thesis", "Old risk");
    writeRun(dataDir, "run-new", "2026-06-05T00:00:00.000Z", "New thesis", "New risk");
    await rebuildHistoryArtifacts(dataDir, new Date("2026-06-06T00:00:00.000Z"));

    const provider: ModelProvider = {
      name: "test",
      generate: async () => ({
        content: "Investors should buy AAPL now.",
        tokenEstimate: 10,
        costEstimateUsd: 0.01,
      }),
    };

    await expect(
      buildThesisDelta({
        dataDir,
        symbol: "AAPL",
        assetClass: "equity",
        since: "run-old",
        to: "run-new",
        narrative: true,
        provider,
        model: "test-model",
        now: new Date("2026-06-06T00:00:00.000Z"),
      }),
    ).rejects.toThrow(/trade-action language/u);

    const persisted = await readdir(join(rootDir, "history", "deltas")).catch(() => []);
    expect(persisted).toEqual([]);
  });

  test("rebuilds when scores are missing and surfaces unresolved predictions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "market-bot-history-noscore-"));
    const dataDir = join(rootDir, "runs");
    mkdirSync(dataDir);
    writeRun(dataDir, "run-old", "2026-06-01T00:00:00.000Z", "Old thesis", "Old risk", {
      writeScore: false,
    });
    writeRun(dataDir, "run-new", "2026-06-05T00:00:00.000Z", "New thesis", "New risk", {
      writeScore: false,
    });

    const result = await rebuildHistoryArtifacts(dataDir, new Date("2026-06-06T00:00:00.000Z"));

    expect(result.sourceRunCount).toBe(2);
    expect(result.malformedRunCount).toBe(0);
    const index = JSON.parse(await readFile(join(rootDir, "history", "index.json"), "utf8")) as {
      readonly entries: readonly { readonly section: string; readonly text: string }[];
    };
    expect(
      index.entries.some(
        (entry) =>
          entry.section === "openQuestions" && entry.text.startsWith("Unresolved prediction:"),
      ),
    ).toBe(true);
    const timeline = JSON.parse(
      await readFile(join(rootDir, "history", "instruments", "equity-AAPL.json"), "utf8"),
    ) as { readonly entries: readonly { readonly scores: readonly unknown[] }[] };
    expect(timeline.entries.every((entry) => entry.scores.length === 0)).toBe(true);
  });

  test("matches timelines from parsed forecast instruments without throwing on malformed forecasts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "market-bot-history-forecast-instruments-"));
    const dataDir = join(rootDir, "runs");
    mkdirSync(dataDir);
    const runDir = join(dataDir, "market-run");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "market-run",
        jobType: "daily",
        assetClass: "equity",
        generatedAt: "2026-06-05T00:00:00.000Z",
        predictions: [
          prediction({
            id: "relative",
            kind: "relative",
            subject: "QQQ:SPY",
            measurableAs: "close(QQQ, +5) / close(QQQ, 0) > close(SPY, +5) / close(SPY, 0)",
          }),
          prediction({
            id: "malformed",
            claim: "A malformed legacy forecast remains readable.",
            subject: "BROKEN",
            measurableAs: "not parseable",
          }),
        ],
      }),
    );

    const result = await rebuildHistoryArtifacts(dataDir, new Date("2026-06-06T00:00:00.000Z"));

    expect(result.instrumentCount).toBe(2);
    const qqqTimeline = JSON.parse(
      await readFile(join(rootDir, "history", "instruments", "equity-QQQ.json"), "utf8"),
    ) as { readonly entries: readonly { readonly scope: string; readonly runId: string }[] };
    const spyTimeline = JSON.parse(
      await readFile(join(rootDir, "history", "instruments", "equity-SPY.json"), "utf8"),
    ) as { readonly entries: readonly { readonly scope: string; readonly runId: string }[] };
    expect(
      qqqTimeline.entries.map((entry) => ({ scope: entry.scope, runId: entry.runId })),
    ).toEqual([{ scope: "market-update", runId: "market-run" }]);
    expect(
      spyTimeline.entries.map((entry) => ({ scope: entry.scope, runId: entry.runId })),
    ).toEqual([{ scope: "market-update", runId: "market-run" }]);
  });

  test("filters verified snapshots to the matching timeline symbol", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "market-bot-history-verified-filter-"));
    const dataDir = join(rootDir, "runs");
    mkdirSync(dataDir);
    writeRun(dataDir, "run-aapl", "2026-06-05T00:00:00.000Z", "AAPL thesis", "AAPL risk");
    writeJson(join(dataDir, "run-aapl", "normalized", "verified-market-snapshot.json"), {
      symbol: "MSFT",
      assetClass: "equity",
      analysisDate: "2026-06-05",
      fetchedAt: "2026-06-05T00:00:00.000Z",
      latestSessionDate: "2026-06-04",
      ohlcv: { date: "2026-06-04", open: 1, high: 2, low: 1, close: 2, volume: 3 },
      indicators: {},
      recentCloses: [
        { date: "2026-06-03", close: 1 },
        { date: "2026-06-04", close: 2 },
      ],
    });

    await rebuildHistoryArtifacts(dataDir, new Date("2026-06-06T00:00:00.000Z"));

    const timeline = JSON.parse(
      await readFile(join(rootDir, "history", "instruments", "equity-AAPL.json"), "utf8"),
    ) as { readonly entries: readonly { readonly verifiedMarketSnapshot?: unknown }[] };
    expect(timeline.entries[0]?.verifiedMarketSnapshot).toBeUndefined();
  });

  test("merges verified representative snapshots into matching instrument timelines", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "market-bot-history-verified-reps-"));
    const dataDir = join(rootDir, "runs");
    const runDir = join(dataDir, "research-biotech");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "research-biotech",
        jobType: "research",
        assetClass: "equity",
        generatedAt: "2026-06-05T00:00:00.000Z",
        sources: [
          {
            id: "verified-snapshot-AMGN",
            title: "AMGN verified market snapshot",
            fetchedAt: "2026-06-05T00:00:00.000Z",
            kind: "market-data",
            assetClass: "equity",
            symbol: "AMGN",
            provider: "yahoo",
          },
        ],
      }),
    );
    writeJson(join(runDir, "normalized", "verified-representative-snapshots.json"), [
      verifiedMarketSnapshot({ symbol: "AMGN" }),
    ]);

    await rebuildHistoryArtifacts(dataDir, new Date("2026-06-06T00:00:00.000Z"));

    const timeline = JSON.parse(
      await readFile(join(rootDir, "history", "instruments", "equity-AMGN.json"), "utf8"),
    ) as { readonly entries: readonly { readonly verifiedMarketSnapshot?: { symbol?: string } }[] };
    expect(timeline.entries[0]?.verifiedMarketSnapshot?.symbol).toBe("AMGN");
  });
});
