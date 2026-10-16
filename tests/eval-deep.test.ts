import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/config";
import { loadRunArtifact } from "../src/run-artifacts";
import type { ModelProvider, ModelRequest } from "../src/model/types";
import { createLiveFixtureConfig, loadFixture, runFixture } from "./support/run-fixtures";
import { countCassetteMisses, makeReplayFetch } from "./support/run-fixtures/data-cassette";
import { llmCassetteKey, makeReplayProvider } from "./support/run-fixtures/llm-cassette";
import {
  evalSampleDir,
  extractSampleMetrics,
  formatEvalCompare,
  liveTokenEstimate,
  readEvalSummary,
  runEvalSample,
  writeEvalSummary,
} from "./support/run-fixtures/eval";

const FIXTURE = "equity-web-fallback-deep";
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "market-bot-eval-"));
  roots.push(root);
  return root;
}

// Runs with sentinel ambient index settings and asserts both come back unchanged.
async function withAmbientIndexEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = [process.env.MARKET_BOT_INDEX_DISABLE, process.env.MARKET_BOT_INDEX_DB_PATH];
  process.env.MARKET_BOT_INDEX_DISABLE = "0";
  process.env.MARKET_BOT_INDEX_DB_PATH = "/ambient/index.sqlite";
  try {
    const result = await run();
    expect(process.env.MARKET_BOT_INDEX_DISABLE).toBe("0");
    expect(process.env.MARKET_BOT_INDEX_DB_PATH).toBe("/ambient/index.sqlite");
    return result;
  } finally {
    for (const [name, value] of [
      ["MARKET_BOT_INDEX_DISABLE", saved[0]],
      ["MARKET_BOT_INDEX_DB_PATH", saved[1]],
    ] as const) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

// Every final-synthesis call returns the first recorded report with its summary replaced.
async function summaryOverrideProvider(summary: string): Promise<ModelProvider> {
  const { llmCassette } = await loadFixture(FIXTURE);
  const replay = makeReplayProvider(llmCassette);
  const [report] = llmCassette.entries["final-synthesis|fixture-synthesis"] ?? [];
  return {
    name: replay.name,
    generate: (request) =>
      llmCassetteKey(request).startsWith("final-synthesis|") && report !== undefined
        ? Promise.resolve({
            ...report,
            content: JSON.stringify({ ...JSON.parse(report.content), summary }),
          })
        : replay.generate(request),
  };
}

function repairStage(repromptReason: unknown) {
  return {
    stage: "final-synthesis",
    content: "{}",
    tokenEstimate: 1,
    attempt: 2,
    repromptReason,
  };
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("frozen-input eval paths", () => {
  test("nests every sample under root/label/fixture/sample and rejects escaping segments", () => {
    expect(evalSampleDir("/evals", "base", FIXTURE, "1")).toBe(`/evals/base/${FIXTURE}/1`);
    for (const segment of ["..", ".", "", "a/b", "../runs", ".hidden"]) {
      expect(() => evalSampleDir("/evals", segment, FIXTURE, "1")).toThrow("Eval path segment");
      expect(() => evalSampleDir("/evals", "base", FIXTURE, segment)).toThrow("Eval path segment");
    }
  });
});

describe("frozen-input eval state paths", () => {
  test("every configured state path of a live sample resolves inside the sample dir", async () => {
    const { meta } = await loadFixture(FIXTURE);
    const sampleDir = evalSampleDir("/evals", "base", FIXTURE, "1");
    const ambient = resolveConfig(
      {
        MARKET_BOT_PROVIDER: "openai",
        MARKET_BOT_DATA_DIR: "/real/runs",
        MARKET_BOT_CACHE_DIR: "/real/cache",
        MARKET_BOT_NEWS_SEEN_PATH: "/real/news-seen.json",
        MARKET_BOT_PEER_UNIVERSE_LEARNED_PATH: "/real/peers.json",
        MARKET_BOT_INDEX_DB_PATH: "/real/index.sqlite",
      },
      { validateAlphaSearchOptions: false },
    );
    const config = createLiveFixtureConfig(meta, join(sampleDir, "runs"), ambient);
    const paths = [
      config.dataDir,
      config.sourceOptions.cacheDir,
      config.sourceOptions.newsSeenPath,
      config.sourceOptions.peerUniverseLearnedPath,
      config.indexOptions?.dbPath,
    ];
    for (const path of paths) {
      expect(path?.startsWith(`${sampleDir}/`)).toBe(true);
    }
  });
});

describe("cassette miss counting", () => {
  test("records miss keys and rethrows the same error; other errors are not counted", async () => {
    const miss = new Error("Fixture data cassette miss: GET  https://example.test/a");
    const other = new Error("socket hang up");
    const keys: string[] = [];
    const missing = countCassetteMisses(() => Promise.reject(miss), keys);
    const failing = countCassetteMisses(() => Promise.reject(other), keys);
    await expect(missing("https://example.test/a")).rejects.toBe(miss);
    await expect(failing("https://example.test/b")).rejects.toBe(other);
    expect(keys).toEqual(["GET  https://example.test/a"]);
  });
});

function stageRequest(stage: string, model: string): Parameters<ModelProvider["generate"]>[0] {
  return {
    model,
    messages: [{ role: "user", content: JSON.stringify({ stage, priorStages: [] }) }],
  };
}

describe("final-synthesis-only live provider", () => {
  test("replays upstream stages by stage, routes final synthesis live, and throws on misses", async () => {
    const liveModels: string[] = [];
    const provider = makeReplayProvider(
      { entries: { "critique|recorded-quick": [{ content: '{"recorded":1}', tokenEstimate: 5 }] } },
      {
        name: "stub",
        generate: async (request) => {
          liveModels.push(request.model);
          return { content: '{"live":1}', tokenEstimate: 7 };
        },
      },
    );

    expect((await provider.generate(stageRequest("critique", "live-quick"))).content).toBe(
      '{"recorded":1}',
    );
    expect((await provider.generate(stageRequest("final-synthesis", "live-sol"))).content).toBe(
      '{"live":1}',
    );
    expect(liveModels).toEqual(["live-sol"]);
    await expect(provider.generate(stageRequest("critique", "live-quick"))).rejects.toThrow(
      "LLM cassette miss for critique|recorded-quick call 2",
    );
    await expect(provider.generate(stageRequest("web-gather", "live-quick"))).rejects.toThrow(
      "LLM cassette has 0 recorded models for stage web-gather",
    );
  });

  test("throws instead of sending a live prompt it cannot freeze", async () => {
    const provider = makeReplayProvider(
      { entries: {} },
      {
        name: "stub",
        generate: () => Promise.reject(new Error("live provider must not be called")),
      },
    );
    const unfrozen = {
      model: "live-sol",
      messages: [{ role: "user" as const, content: JSON.stringify({ stage: "final-synthesis" }) }],
    };
    await expect(provider.generate(unfrozen)).rejects.toThrow(
      "final-synthesis prompt has no priorStages array to freeze",
    );
  });

  test("records a failed sample and restores index settings when the live provider cannot be built", async () => {
    const root = await tempRoot();
    const savedProvider = process.env.MARKET_BOT_PROVIDER;
    process.env.MARKET_BOT_PROVIDER = "unsupported-eval-test";
    try {
      const sample = await withAmbientIndexEnv(() =>
        runEvalSample({
          root,
          label: "no-provider",
          fixture: "equity-depository-deep",
          sample: "1",
          llm: "replay",
          liveStages: "final-synthesis",
        }),
      );
      expect(sample.status).toBe("threw");
      expect(sample.error).toContain("Unsupported provider: unsupported-eval-test");
      expect(existsSync(join(sample.sampleDir, "eval-sample.json"))).toBe(true);
    } finally {
      if (savedProvider === undefined) {
        delete process.env.MARKET_BOT_PROVIDER;
      } else {
        process.env.MARKET_BOT_PROVIDER = savedProvider;
      }
    }
  });

  test("runs recorded fixtures with only final synthesis live and identical prompts per sample", async () => {
    const root = await tempRoot();
    for (const fixtureName of ["equity-depository-deep", "equity-earnings-release-deep"]) {
      // eslint-disable-next-line no-await-in-loop -- fixtures share process env
      const fixture = await loadFixture(fixtureName);
      const firstPrompts: string[] = [];
      for (const sample of ["1", "2"]) {
        const replay = makeReplayProvider(fixture.llmCassette);
        const liveRequests: ModelRequest[] = [];
        // eslint-disable-next-line no-await-in-loop -- samples share process env
        const result = await runEvalSample({
          root,
          label: "live-stage",
          fixture: fixtureName,
          sample,
          llm: "replay",
          liveStages: "final-synthesis",
          provider: {
            name: "stub",
            generate: (request) => {
              liveRequests.push(request);
              return replay.generate(request);
            },
          },
        });
        expect(result.status).toBe("completed");
        expect(result.modelCalls.live).toBe(liveRequests.length);
        expect(result.modelCalls.replayed).toBe(
          fixtureName === "equity-earnings-release-deep" ? 5 : 4,
        );
        expect(result.modelReplayMisses.count).toBe(0);
        expect(liveRequests.length).toBeGreaterThan(0);
        expect(
          liveRequests.every((request) => llmCassetteKey(request).startsWith("final-synthesis|")),
        ).toBe(true);
        const user = liveRequests[0]!.messages.findLast(({ role }) => role === "user")!.content;
        expect(user).toBe(JSON.stringify(JSON.parse(user)));
        firstPrompts.push(
          liveRequests[0]?.messages.map((message) => message.content).join("\n") ?? "",
        );
      }
      expect(firstPrompts[1]).toBe(firstPrompts[0]);
      expect(firstPrompts[0]).toContain('"durationMs":0');

      // eslint-disable-next-line no-await-in-loop -- sequential with the runs above
      const estimate = await liveTokenEstimate(fixtureName, "final-synthesis");
      const perCall = Math.max(
        50_000,
        ...(fixture.llmCassette.entries["final-synthesis|gpt-5.6-sol"] ?? []).map(
          (entry) => entry.tokenEstimate,
        ),
      );
      expect(estimate.perRun).toBe(7 * perCall);
    }
    expect((await liveTokenEstimate("equity-nbis-deep", "final-synthesis")).perRun).toBe(350_000);
  });

  test("fails the run without a live call when an upstream stage swallows a replay miss", async () => {
    const root = await tempRoot();
    const fixture = await loadFixture("equity-earnings-release-deep");
    const { "web-subject-profile|gpt-5.6-luna": missing, ...entries } = fixture.llmCassette.entries;
    expect(missing).toBeDefined();
    let liveCalls = 0;
    await expect(
      runFixture("equity-earnings-release-deep", {
        llm: "replay",
        dataDir: join(root, "runs"),
        keepDataDir: true,
        provider: makeReplayProvider(
          { entries },
          {
            name: "stub",
            generate: () => {
              liveCalls += 1;
              return Promise.reject(new Error("live provider must not be called"));
            },
          },
        ),
      }),
    ).rejects.toThrow("Refusing live final-synthesis after upstream replay failure");
    expect(liveCalls).toBe(0);
  });
});

describe("frozen-input eval replay", () => {
  test("isolates state, refuses overwrite, replays recorded source failures, and compares labels", async () => {
    const root = await tempRoot();
    const fixture = await loadFixture(FIXTURE);
    const replayProvider = makeReplayProvider(fixture.llmCassette);
    const observedEnv: (string | undefined)[][] = [];
    const base = await withAmbientIndexEnv(() =>
      runEvalSample({
        root,
        label: "base",
        fixture: FIXTURE,
        sample: "1",
        llm: "replay",
        provider: {
          name: replayProvider.name,
          generate: (request) => {
            observedEnv.push([
              process.env.MARKET_BOT_INDEX_DISABLE,
              process.env.MARKET_BOT_INDEX_DB_PATH,
            ]);
            return replayProvider.generate(request);
          },
        },
      }),
    );
    expect(observedEnv.length).toBeGreaterThan(0);
    expect(observedEnv.every(([disable, dbPath]) => disable === "1" && dbPath === undefined)).toBe(
      true,
    );
    expect(base.status).toBe("completed");
    expect(base.cassetteMisses).toEqual({ count: 0, keys: [] });
    expect(base.runDir?.startsWith(join(root, "base", FIXTURE, "1", "runs"))).toBe(true);
    for (const state of ["calibration", "cache", "news-seen.json"]) {
      expect(existsSync(join(base.sampleDir, state))).toBe(true);
    }
    await expect(
      runEvalSample({ root, label: "base", fixture: FIXTURE, sample: "1", llm: "replay" }),
    ).rejects.toThrow("EEXIST");

    const newsKey = Object.keys(fixture.dataCassette.entries).find((key) =>
      key.includes("finnhub.io/api/v1/company-news"),
    );
    expect(newsKey).toBeDefined();
    const unavailableNews = makeReplayFetch(
      {
        entries: {
          ...fixture.dataCassette.entries,
          [newsKey!]: {
            status: 403,
            headers: { "content-type": "application/json" },
            body: '{"error":"Forbidden"}',
          },
        },
      },
      fixture.dir,
    );
    const next = await runEvalSample({
      root,
      label: "next",
      fixture: FIXTURE,
      sample: "1",
      llm: "replay",
      fetchImpl: unavailableNews,
    });
    expect(next.status).toBe("completed");
    expect(next.cassetteMisses).toEqual({ count: 0, keys: [] });
    const { artifact } = await loadRunArtifact(next.runDir!);
    expect(artifact?.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "finnhub-news",
        cause: "fetch-failed",
        message: expect.stringContaining("403"),
      }),
    );

    const metrics = await extractSampleMetrics(FIXTURE, "1", next.sampleDir);
    expect(metrics.metrics.cassetteMisses).toBe(0);
    expect(metrics.metrics["sourceGaps.fetch-failed"]).toBeGreaterThan(0);
    expect(metrics.metrics["status.completed"]).toBe(1);
    expect(metrics.metrics["tokens.total"]).toBeGreaterThan(0);
    expect(metrics.metrics["predictions.count"]).toBeGreaterThanOrEqual(0);
    expect(metrics.metrics["citations.coverage"]).toBeGreaterThan(0);

    await writeEvalSummary(root, "base");
    await writeEvalSummary(root, "next");
    const written = JSON.parse(await readFile(join(root, "next", "summary.json"), "utf8"));
    expect(written.samples).toHaveLength(1);
    const compare = formatEvalCompare(
      await readEvalSummary(root, "base"),
      await readEvalSummary(root, "next"),
    );
    expect(compare).toContain("| fixture | metric | base mean [range] | next mean [range] |");
    expect(compare).toContain(`| ${FIXTURE} | cassetteMisses | 0 [0–0] | 0 [0–0] |`);
    expect(compare).toMatch(/\| tokens\.total \| \d+ \[\d+–\d+\] \|/u);
  });

  test("offline defaults cannot touch ambient network or live models and report response usage", async () => {
    const root = await tempRoot();
    const savedFetch = globalThis.fetch;
    const savedProvider = process.env.MARKET_BOT_PROVIDER;
    let networkCalls = 0;
    const rejectNetwork = () => {
      networkCalls += 1;
      throw new Error("default network must not be called");
    };
    globalThis.fetch = Object.assign(async () => rejectNetwork(), { preconnect: rejectNetwork });
    process.env.MARKET_BOT_PROVIDER = "live-provider-must-not-be-created";
    try {
      const sample = await withAmbientIndexEnv(() =>
        runEvalSample({
          root,
          label: "offline",
          fixture: "equity-aapl-brief",
          sample: "1",
          llm: "replay",
        }),
      );
      expect(sample.status).toBe("completed");
      expect(sample.modelCalls).toEqual({ replayed: 3, live: 0 });
      expect(sample.modelReplayMisses.count).toBe(0);
      expect(
        Object.values(sample.responseUsage!.consumedResponses).reduce((a, b) => a + b, 0),
      ).toBe(3);
      expect(networkCalls).toBe(0);
    } finally {
      globalThis.fetch = savedFetch;
      if (savedProvider === undefined) {
        delete process.env.MARKET_BOT_PROVIDER;
      } else {
        process.env.MARKET_BOT_PROVIDER = savedProvider;
      }
    }
  });

  test.each(["replay", "live", "final-synthesis"] as const)(
    "caught HTTP misses invalidate %s samples and prevent subsequent live calls",
    async (mode) => {
      const root = await tempRoot();
      const fixture = await loadFixture(FIXTURE);
      const entries = Object.fromEntries(
        Object.entries(fixture.dataCassette.entries).filter(
          ([key]) => !key.includes("company-news"),
        ),
      );
      let liveCalls = 0;
      const sample = await runEvalSample({
        root,
        label: mode,
        fixture: fixture.name,
        sample: "1",
        llm: mode === "live" ? "live" : "replay",
        ...(mode === "final-synthesis" ? { liveStages: "final-synthesis" as const } : {}),
        ...(mode !== "replay"
          ? {
              provider: {
                name: "fake-live",
                generate: async () => {
                  liveCalls += 1;
                  throw new Error("live model must not be called after an HTTP miss");
                },
              },
            }
          : {}),
        fetchImpl: makeReplayFetch({ entries }, fixture.dir),
      });
      expect(sample.status).toBe("incomplete");
      expect(sample.error).toContain("Refusing model call after HTTP replay failure");
      expect(sample.cassetteMisses.count).toBeGreaterThan(0);
      expect(sample.cassetteMisses.keys.join("\n")).toContain("company-news");
      expect(liveCalls).toBe(0);
      expect(sample.modelCalls.live).toBe(0);
      const summary = await writeEvalSummary(root, mode);
      expect(summary.samples[0]?.status).toBe("incomplete");
      expect(summary.samples[0]?.metrics.cassetteMisses).toBe(sample.cassetteMisses.count);
    },
  );

  test.each([false, true])(
    "reports a swallowed model replay miss (synthesis live: %s)",
    async (synthesisLive) => {
      const root = await tempRoot();
      const fixture = await loadFixture("equity-earnings-release-deep");
      const entries = Object.fromEntries(
        Object.entries(fixture.llmCassette.entries).filter(
          ([key]) => !key.startsWith("web-subject-profile|"),
        ),
      );
      let liveCalls = 0;
      const sample = await runEvalSample({
        root,
        label: "model-miss",
        fixture: fixture.name,
        sample: "1",
        llm: "replay",
        provider: synthesisLive
          ? makeReplayProvider(
              { entries },
              {
                name: "fake-live",
                generate: async () => {
                  liveCalls += 1;
                  throw new Error("must not spend");
                },
              },
            )
          : makeReplayProvider({ entries }),
      });
      expect(sample.status).toBe("incomplete");
      if (!synthesisLive) {
        expect(sample.runDir).toBeDefined();
        expect(sample.error).toContain("Fixture replay incomplete");
      }
      expect(sample.cassetteMisses.count).toBe(0);
      expect(sample.modelReplayMisses.keys).toEqual(["web-subject-profile|gpt-5.6-luna"]);
      expect(sample.modelReplayMisses.errors[0]).toContain("0 recorded models");
      expect(liveCalls).toBe(0);
      const persisted = JSON.parse(
        await readFile(join(sample.sampleDir, "eval-sample.json"), "utf8"),
      );
      expect(persisted.modelReplayMisses).toEqual(sample.modelReplayMisses);
      const summary = await writeEvalSummary(root, "model-miss");
      expect(summary.samples[0]?.modelReplayMissKeys).toEqual(sample.modelReplayMisses.keys);
      expect(summary.samples[0]?.metrics.modelReplayMisses).toBe(1);
    },
  );

  test.each([
    { finalOnly: false, error: new Error("model down") },
    { finalOnly: true, error: new Error("model down") },
    { finalOnly: true, error: new SyntaxError("provider response decode failed") },
    { finalOnly: true, error: new Error("quota exceeded") },
    { finalOnly: true, error: new Error("model stopped early") },
  ])(
    "persists $error without a stale response (final synthesis only: $finalOnly)",
    async ({ finalOnly, error }) => {
      const root = await tempRoot();
      const fixture = await loadFixture(FIXTURE);
      const replay = makeReplayProvider(fixture.llmCassette);
      const failing = await withAmbientIndexEnv(() =>
        runEvalSample({
          root,
          label: "broken",
          fixture: FIXTURE,
          sample: "1",
          llm: "replay",
          provider: {
            name: "failing",
            generate: (request) =>
              !finalOnly || llmCassetteKey(request).startsWith("final-synthesis|")
                ? Promise.reject(error)
                : replay.generate(request),
          },
        }),
      );
      expect(failing.status).toBe("threw");
      expect(failing.error).toBe(error.message);
      const record = JSON.parse(
        await readFile(join(failing.sampleDir, "eval-sample.json"), "utf8"),
      );
      expect(record.errorStack).toContain(`${error.name}: ${error.message}`);
      expect(failing.runDir).toBeUndefined();
      expect(record.rawResponseContent).toBeUndefined();
      const metrics = await extractSampleMetrics(FIXTURE, "1", failing.sampleDir);
      expect(metrics.metrics[`status.${failing.status}`]).toBe(1);
      expect(metrics.unavailable).toContain("sourceGaps");
    },
  );

  test.each(["trailing brace", "missing brace", "malformed repair reply"])(
    "publishes a report after repairing final-synthesis JSON with a %s",
    async (malformation) => {
      const root = await tempRoot();
      const fixture = await loadFixture(FIXTURE);
      const replay = makeReplayProvider(fixture.llmCassette);
      const report = fixture.llmCassette.entries["final-synthesis|fixture-synthesis"]?.[0];
      expect(report).toBeDefined();
      const malformedAttempt = malformation === "malformed repair reply" ? 2 : 1;
      const prompts: Record<string, unknown>[] = [];
      const sample = await runEvalSample({
        root,
        label: "repaired-json",
        fixture: FIXTURE,
        sample: "1",
        llm: "replay",
        provider: {
          name: replay.name,
          generate: async (request) => {
            if (!llmCassetteKey(request).startsWith("final-synthesis|")) {
              return replay.generate(request);
            }
            prompts.push(JSON.parse(request.messages[1]?.content ?? "{}"));
            const valid = report!;
            let { content } = valid;
            if (prompts.length === malformedAttempt) {
              content =
                malformation === "missing brace" ? valid.content.slice(0, -1) : `${valid.content}}`;
            } else if (prompts.length < malformedAttempt) {
              content = JSON.stringify({ ...JSON.parse(valid.content), summary: "Buy the dip." });
            }
            return { ...valid, content };
          },
        },
      });

      expect(sample.status).toBe("completed");
      expect(prompts).toHaveLength(malformedAttempt + 1);
      expect(prompts[malformedAttempt]?.reportValidationErrors).toEqual(
        expect.arrayContaining([expect.stringContaining("JSON Parse error:")]),
      );
      expect(prompts[malformedAttempt]?.reportValidationErrors).toEqual(
        expect.arrayContaining([expect.stringContaining("one complete JSON object")]),
      );
      expect(existsSync(join(sample.runDir!, "report.json"))).toBe(true);
      expect(existsSync(join(sample.runDir!, "report.md"))).toBe(true);
      const { metrics } = await extractSampleMetrics(FIXTURE, "1", sample.sampleDir);
      expect(metrics["repairs.reportValidation"]).toBe(1);
      expect(metrics["repairs.predictionErrors"]).toBeUndefined();
    },
  );

  test("exhausts report repairs and retains raw malformed final-synthesis replies", async () => {
    const root = await tempRoot();
    const fixture = await loadFixture(FIXTURE);
    const replay = makeReplayProvider(fixture.llmCassette);
    const raw = `${JSON.stringify({ summary: "x".repeat(20_000) })}}`;
    let finalCalls = 0;
    const sample = await runEvalSample({
      root,
      label: "invalid-json",
      fixture: FIXTURE,
      sample: "1",
      llm: "replay",
      provider: {
        name: replay.name,
        generate: async (request) => {
          if (!llmCassetteKey(request).startsWith("final-synthesis|")) {
            return replay.generate(request);
          }
          finalCalls += 1;
          return { content: raw, tokenEstimate: 1 };
        },
      },
    });

    expect(sample.status).toBe("failed-final-synthesis");
    expect(finalCalls).toBe(4);
    const record = JSON.parse(await readFile(join(sample.sampleDir, "eval-sample.json"), "utf8"));
    expect(record.errorStack).toContain("FinalSynthesisRejectedError:");
    expect(record.error).toContain("JSON Parse error:");
    expect(record.rawResponseContent).toBe(raw.slice(0, 20_000));
    const rejected = JSON.parse(
      await readFile(join(sample.runDir!, "rejected-report.json"), "utf8"),
    );
    expect(rejected).toEqual({ rawResponseContent: record.rawResponseContent });
    const failure = JSON.parse(await readFile(join(sample.runDir!, "failure.json"), "utf8"));
    expect(failure.totalCalls).toBe(4);
    expect(failure.reportRepairReprompts).toBe(3);
    expect(existsSync(join(sample.runDir!, "report.json"))).toBe(false);
    const stages = JSON.parse(await readFile(join(sample.runDir!, "stages.json"), "utf8")) as {
      stage: string;
      content: string;
    }[];
    expect(
      stages.filter((stage) => stage.stage === "final-synthesis").map((stage) => stage.content),
    ).toEqual([raw, raw, raw, raw]);
    const { metrics } = await extractSampleMetrics(FIXTURE, "1", sample.sampleDir);
    expect(metrics["repairs.reportValidation"]).toBe(3);
    expect(metrics["repairs.predictionErrors"]).toBeUndefined();
    const summary = await writeEvalSummary(root, "invalid-json");
    expect(formatEvalCompare(summary, await readEvalSummary(root, "invalid-json"))).toContain(
      `| ${FIXTURE} | status.failed-final-synthesis | 1 [1–1] | 1 [1–1] |`,
    );
  });

  test("keeps a valid JSON non-object outside the parse-error repair boundary", async () => {
    const root = await tempRoot();
    const fixture = await loadFixture(FIXTURE);
    const replay = makeReplayProvider(fixture.llmCassette);
    let finalCalls = 0;
    const sample = await runEvalSample({
      root,
      label: "invalid-shape",
      fixture: FIXTURE,
      sample: "1",
      llm: "replay",
      provider: {
        name: replay.name,
        generate: async (request) => {
          if (!llmCassetteKey(request).startsWith("final-synthesis|")) {
            return replay.generate(request);
          }
          finalCalls += 1;
          return { content: "[]", tokenEstimate: 1 };
        },
      },
    });
    expect(sample.status).toBe("threw");
    expect(sample.error).toBe("Model report payload must be a JSON object");
    expect(finalCalls).toBe(1);
    expect(sample.runDir).toBeUndefined();
  });

  test("keeps retained Source Gaps of a failed final synthesis and marks report metrics unavailable", async () => {
    const root = await tempRoot();
    const failed = await runEvalSample({
      root,
      label: "failed",
      fixture: FIXTURE,
      sample: "1",
      llm: "replay",
      provider: await summaryOverrideProvider("Buy the dip."),
    });
    expect(failed.status).toBe("failed-final-synthesis");
    const { metrics, unavailable } = await extractSampleMetrics(FIXTURE, "1", failed.sampleDir);
    expect(metrics["repairs.researchLanguage"]).toBeGreaterThan(0);
    expect(metrics["repairs.predictionErrors"]).toBeUndefined();
    expect(Object.keys(metrics).some((key) => key.startsWith("sourceGaps."))).toBe(true);
    expect(unavailable).toEqual([
      "predictions",
      "citations",
      "dataGaps",
      "integrity",
      "postSynthesisAudit",
    ]);
  });

  test("classifies repairs by nonempty reason and pruned integrity findings by section", async () => {
    const root = await tempRoot();
    const sample = await runEvalSample({
      root,
      label: "base",
      fixture: FIXTURE,
      sample: "1",
      llm: "replay",
      provider: await summaryOverrideProvider("Observed price was $12."),
    });
    const runDir = sample.runDir!;
    const stages = JSON.parse(await readFile(join(runDir, "stages.json"), "utf8")) as unknown[];
    await writeFile(
      join(runDir, "stages.json"),
      JSON.stringify([
        ...stages,
        repairStage({
          predictionErrors: [],
          reportValidationErrors: ['Report contains trade-action language: "you should"'],
        }),
        repairStage({ reportValidationErrors: ["Report probability must be finite"] }),
        repairStage({ predictionErrors: ["pred-1 horizon out of range"] }),
      ]),
    );
    const { metrics } = await extractSampleMetrics(FIXTURE, "1", sample.sampleDir);
    expect(metrics["repairs.researchLanguage"]).toBe(1);
    expect(metrics["repairs.reportValidation"]).toBe(1);
    expect(metrics["repairs.predictionErrors"]).toBe(1);
    expect(metrics["integrity.pruned.summary"]).toBe(1);
  });

  test("summarizes completed samples beside an incomplete one", async () => {
    const root = await tempRoot();
    await runEvalSample({ root, label: "partial", fixture: FIXTURE, sample: "1", llm: "replay" });
    await mkdir(join(root, "partial", FIXTURE, "2"));
    const summary = await writeEvalSummary(root, "partial");
    expect(summary.samples.map((sample) => sample.status)).toEqual(["completed", "incomplete"]);
    const compare = formatEvalCompare(summary, summary);
    expect(compare).toContain(`| ${FIXTURE} | status.incomplete | 0.50 [0–1] | 0.50 [0–1] |`);
    expect(compare).toMatch(/\| tokens\.total \| \d+ \[\d+–\d+\] \(n=1\/2\) \|/u);
  });

  test("compares labels with absent counts as 0 and absent ratios dropped from n", () => {
    const summary = (label: string, metrics: Record<string, number>[]) => ({
      label,
      samples: metrics.map((sampleMetrics, index) => ({
        fixture: FIXTURE,
        sample: String(index + 1),
        status: "completed" as const,
        cassetteMissKeys: [],
        modelReplayMissKeys: [],
        metrics: sampleMetrics,
        unavailable: [],
      })),
    });
    const compare = formatEvalCompare(
      summary("base", [
        { "citations.coverage": 0.5, "predictions.count": 2 },
        { "status.threw": 1 },
      ]),
      summary("next", [{ "citations.coverage": 1, "predictions.count": 4 }]),
    );
    expect(compare).toContain(
      `| ${FIXTURE} | citations.coverage | 0.50 [0.50–0.50] (n=1/2) | 1 [1–1] |`,
    );
    expect(compare).toContain(`| ${FIXTURE} | predictions.count | 1 [0–2] | 4 [4–4] |`);
    expect(compare).toContain(`| ${FIXTURE} | status.threw | 0.50 [0–1] | 0 [0–0] |`);
  });
});
