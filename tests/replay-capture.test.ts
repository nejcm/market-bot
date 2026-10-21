import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { loadFixture, runFixture, createFixtureConfig } from "./support/run-fixtures";
import { runDeepEquity } from "../src/deep-equity";
import { parseArgs } from "../src/cli/args";
import { makeReplayFetch, createRecordingFetch } from "../src/replay/data-cassette";
import {
  makeReplayProvider,
  createRecordingProvider,
  requestStage,
} from "../src/replay/llm-cassette";
import {
  withReplaySession,
  replayValue,
  replayValueSync,
  captureSynthesisInput,
  type ReplayState,
} from "../src/replay/session";
import { createSourceRequestContext } from "../src/sources/source-request";
import { withCache } from "../src/sources/cache";
import {
  externalizeSynthesisBodies,
  loadSynthesisReplayInput,
  readSynthesisReplayInput,
} from "../src/replay/synthesis-input";
import {
  executeSynthesisInput,
  judgeEvidence,
  replayPairedSample,
  replaySynthesisFile,
  approvalSubsetEstimate,
  estimateSynthesisFile,
  formatSynthesisEstimate,
} from "../src/replay/replay-synthesis";
import { rerunReport } from "../src/replay/rerun-report";
import { parseEvalCases, type OmissionCase } from "../src/replay/eval-cases";
import { resolveConfig } from "../src/config";
import { assertNoSecretsInFiles } from "../scripts/fixture-secret-scan";
import { runEvalSample } from "./support/run-fixtures/eval";
import { withRunCapture } from "../src/replay/capture";
import { readRecordedBody } from "../src/replay/body-file";
import { indexRowsForRun } from "../src/run-artifact-index-rows";
import { readRunDetail, readRunFile } from "../app/artifacts";

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});
async function createRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "market-bot-capture-"));
  roots.push(dir);
  return dir;
}

const modelRequest = (stage: string, model: string) => ({
  model,
  messages: [{ role: "user" as const, content: JSON.stringify({ stage }) }],
});

function massiveNewsUrl(apiKey: string): string {
  return `https://api.massive.com/v2/reference/news?apiKey=${apiKey}&limit=15&order=desc&sort=published_utc&published_utc.gte=2026-09-16T15%3A39%3A21.051Z&ticker=AAPL`;
}

async function forbidden(): Promise<unknown> {
  throw new Error("state reader touched");
}

test("capture is opt-in and disabled pipeline runs publish no replay sidecar", async () => {
  expect(resolveConfig({}).captureReplay).toBe(false);
  expect(resolveConfig({ MARKET_BOT_CAPTURE_REPLAY: "1" }).captureReplay).toBe(true);
  const result = await runFixture("equity-aapl-brief");
  try {
    expect(await readdir(result.artifacts.runDir)).not.toContain("replay");
  } finally {
    await result.cleanup();
  }
});

test("report rerun treats canonical null as absence and a missing normalized dependency as failure", async () => {
  const dir = await createRoot();
  const produced = await runFixture("equity-aapl-brief");
  try {
    await writeFile(join(produced.artifacts.normalizedDir, "business-framework.json"), "null");
    const absent = await rerunReport({
      run: produced.artifacts.runDir,
      label: "absent",
      root: dir,
    });
    expect(absent.status).toBe("completed");
    expect(
      JSON.parse(await readFile(join(absent.dir, "report.json"), "utf8")).extras.businessFramework,
    ).toBeUndefined();
    await rm(join(produced.artifacts.normalizedDir, "business-framework.json"));
    const missing = await rerunReport({
      run: produced.artifacts.runDir,
      label: "missing-normalized",
      root: dir,
    });
    expect(missing.status).toBe("failed");
    expect(await readFile(join(missing.dir, "eval-sample.json"), "utf8")).toContain(
      "business-framework.json",
    );
  } finally {
    await produced.cleanup();
  }
});

test("production deep capture round-trips HTTP failures, state, synthesis repairs, projections and markdown offline", async () => {
  const dir = await createRoot();
  const fixture = await loadFixture("equity-depository-deep");
  const command = parseArgs(fixture.meta.argv);
  if (command.jobType !== "equity") {
    throw new Error("expected equity fixture");
  }
  const secret = "synthetic-model-and-http-secret";
  const email = "private-contact@capture.test";
  const config = {
    ...createFixtureConfig(fixture.meta, join(dir, "runs")),
    apiKey: secret,
    baseUrl: "https://internal.capture.test/v1",
    indexOptions: { disabled: true, dbPath: join(dir, "private-index.sqlite") },
    sourceOptions: {
      ...createFixtureConfig(fixture.meta, join(dir, "runs")).sourceOptions,
      secUserAgent: `Private research client ${email}`,
    },
    captureReplay: true,
  };
  const originalFetch = globalThis.fetch;
  let defaultFetchCalls = 0;
  globalThis.fetch = Object.assign(
    () => {
      defaultFetchCalls += 1;
      throw new Error("default network path touched");
    },
    { preconnect: originalFetch.preconnect },
  );
  try {
    const produced = await withReplaySession(
      { mode: "offline", offline: true, state: { values: {} }, indexes: new Map(), failures: [] },
      () =>
        runDeepEquity(
          { command, config, now: new Date(fixture.meta.now) },
          {
            provider: makeReplayProvider(fixture.llmCassette),
            fetchImpl: async (input, init) => {
              const response = await makeReplayFetch(fixture.dataCassette, fixture.dir)(
                input,
                init,
              );
              return response.status === 503
                ? new Response(
                    `unavailable ${secret} ${email} ${config.dataDir} ${config.baseUrl} ${config.indexOptions.dbPath}`,
                    { status: 503 },
                  )
                : response;
            },
            retryDelaysMs: [],
          },
        ),
    );
    const capture = join(produced.artifacts.runDir, "replay");
    const runId = basename(produced.artifacts.runDir);
    const indexed = await indexRowsForRun(config.dataDir, runId);
    expect(indexed.files.some((file) => file.path.startsWith("replay/"))).toBe(false);
    const detail = await readRunDetail(config.dataDir, runId);
    expect(detail?.summary.availableFiles.some((file) => file.startsWith("replay/"))).toBe(false);
    expect(await readRunFile(config.dataDir, runId, "replay/meta.json")).toBeUndefined();
    expect(await readdir(produced.artifacts.runDir)).not.toContain("capture-failure.json");
    const loaded = await loadFixture(capture);
    expect(loaded.meta.captureVersion).toBe(1);
    expect(loaded.state?.values.calibration).toHaveLength(1);
    expect(Object.values(loaded.dataCassette.entries).some((row) => row.status === 503)).toBe(true);
    expect(await readdir(join(capture, "bodies"))).not.toHaveLength(0);
    const body = Object.values(loaded.dataCassette.entries).find(
      (row) => row.bodyFile !== undefined,
    )!;
    await expect(readRecordedBody(capture, body.bodyFile!, "0".repeat(64))).rejects.toThrow(
      "hash mismatch",
    );
    await expect(readRecordedBody(capture, "../report.json")).rejects.toThrow(
      "Unsafe cassette body path",
    );
    const captureFiles = await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: capture, onlyFiles: true }),
    );
    await assertNoSecretsInFiles(
      captureFiles.map((file) => join(capture, file)),
      [
        secret,
        email,
        config.sourceOptions.secUserAgent,
        config.dataDir,
        config.promptDir,
        config.baseUrl,
        config.indexOptions.dbPath,
      ],
    );
    const replay = await runFixture(capture, { llm: "replay" });
    expect(replay.report.symbol).toBe(produced.report.symbol);
    expect(replay.report.predictions.map((row) => row.measurableAs)).toEqual(
      produced.report.predictions.map((row) => row.measurableAs),
    );
    expect(replay.collectedSources.sourceGaps.some((gap) => gap.message.includes("503"))).toBe(
      true,
    );
    await replay.cleanup();
    const file = join(capture, "final-synthesis-input.json");
    const stored = await readFile(file, "utf8");
    const saved = await loadSynthesisReplayInput(file);
    expect(Object.keys(saved.input.settings)).toEqual(["sourceOptions"]);
    const storedCollected = JSON.parse(stored).input.collectedSources;
    expect(storedCollected.secTargetPacket).toEqual({
      $replayBody: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(JSON.stringify(storedCollected.rawSnapshots)).toContain('"$replayBody"');
    expect(saved.input.collectedSources.secTargetPacket?.companyFacts).toBeDefined();
    expect(stored.length * 2).toBeLessThan(JSON.stringify(saved).length);
    const inline = join(dir, "inline-final-synthesis-input.json");
    await writeFile(inline, JSON.stringify(saved));
    expect(await loadSynthesisReplayInput(inline)).toEqual(saved);

    const lookalikes = join(dir, "lookalikes");
    await mkdir(join(lookalikes, "bodies"), { recursive: true });
    const lookalikeRows = [
      { bodyFile: "bodies/missing.json", sha256: "0".repeat(64) },
      { meta: { bodyFile: "notes.txt", sha256: `abc${"d".repeat(40_000)}` } },
    ];
    const withLookalikes = {
      ...saved,
      input: {
        ...saved.input,
        collectedSources: {
          ...saved.input.collectedSources,
          rawSnapshots: [...saved.input.collectedSources.rawSnapshots, ...lookalikeRows],
        },
      },
    } as typeof saved;
    const lookalikeBodies = new Map<string, string>();
    const external = externalizeSynthesisBodies(withLookalikes, (text) => {
      const sha256 = new Bun.CryptoHasher("sha256").update(text).digest("hex");
      lookalikeBodies.set(sha256, text);
      return sha256;
    });
    await Promise.all(
      [...lookalikeBodies].map(([sha256, text]) =>
        writeFile(join(lookalikes, "bodies", `${sha256}.json`), text),
      ),
    );
    const lookalikeFile = join(lookalikes, "final-synthesis-input.json");
    await writeFile(lookalikeFile, JSON.stringify(external));
    const reloaded = await loadSynthesisReplayInput(lookalikeFile);
    expect(reloaded.input.collectedSources.rawSnapshots.slice(-2)).toEqual(lookalikeRows as never);

    const shared = {
      payload: Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`k${String(i)}`, i])),
    };
    const aliased = {
      ...saved,
      input: {
        ...saved.input,
        collectedSources: { ...saved.input.collectedSources, rawSnapshots: [shared, shared] },
      },
    } as unknown as typeof saved;
    const aliasedBodies = new Map<string, string>();
    const aliasedRef = externalizeSynthesisBodies(aliased, (text) => {
      const sha256 = new Bun.CryptoHasher("sha256").update(text).digest("hex");
      aliasedBodies.set(sha256, text);
      return sha256;
    });
    const [refA, refB] = aliasedRef.input.collectedSources.rawSnapshots as unknown[];
    expect(refA).toEqual({ payload: { $replayBody: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
    expect(refB).toEqual(refA);
    await Promise.all(
      [...aliasedBodies].map(([sha256, text]) =>
        writeFile(join(lookalikes, "bodies", `${sha256}.json`), text),
      ),
    );
    const aliasedFile = join(lookalikes, "aliased.json");
    await writeFile(aliasedFile, JSON.stringify(aliasedRef));
    const [first, second] = (await loadSynthesisReplayInput(aliasedFile)).input.collectedSources
      .rawSnapshots as unknown as (typeof shared)[];
    first!.payload.k0 = -1;
    expect(second!.payload.k0).toBe(0);
    const reserved = {
      ...withLookalikes,
      input: {
        ...withLookalikes.input,
        collectedSources: {
          ...withLookalikes.input.collectedSources,
          rawSnapshots: [{ $replayBody: "0".repeat(64) }] as never,
        },
      },
    } as typeof saved;
    expect(() => externalizeSynthesisBodies(reserved, () => "")).toThrow("reserved key");
    for (const ref of [{ $replayBody: "f".repeat(64) }, { $replayBody: "x", extra: 1 }]) {
      const broken = join(lookalikes, "broken.json");
      await writeFile(
        broken,
        JSON.stringify({
          ...external,
          input: {
            ...external.input,
            collectedSources: { ...external.input.collectedSources, secTargetPacket: ref },
          },
        }),
      );
      await expect(loadSynthesisReplayInput(broken)).rejects.toThrow();
    }
    const stage = await replaySynthesisFile({ input: file, label: "stage", root: dir });
    expect(stage.status).toBe("completed");
    const report = JSON.parse(await readFile(join(stage.dir, "report.json"), "utf8"));
    expect(report.symbol).toBe(produced.report.symbol);
    expect(await readFile(join(stage.dir, "report.md"), "utf8")).toContain("Research-only");
    const metrics = JSON.parse(await readFile(join(stage.dir, "eval-sample.json"), "utf8"));
    expect(metrics.partial).toBe(true);
    expect(metrics.judgeMode).toBe("skipped");
    expect(metrics.modelCalls).toMatchObject({ live: 0, replayed: 1, analysis: 0, judge: 0 });
    expect(metrics.comparison.predictionDelta).toBe(0);
    expect(metrics.comparison.addedClaims).toEqual([]);
    expect(metrics.tokens.live).toBe(0);
    expect(metrics.tokens.replayed).toBeGreaterThan(0);
    expect(saved.promptProvenance).toHaveLength(1);
    const estimate = await estimateSynthesisFile(file);
    const unjudged = formatSynthesisEstimate(estimate, 2, false, "overhead note");
    expect(unjudged).toContain("Report judge skipped (--no-judge)");
    expect(unjudged).toContain(`Total expected ~${String(estimate.expectedPerRun * 2)},`);
    expect(unjudged).not.toContain("k=3");
    expect(unjudged).not.toContain("overhead note");
    const judgedPlan = formatSynthesisEstimate(estimate, 2, true, "overhead note");
    expect(judgedPlan).toContain(`Total expected ~${String(estimate.totalExpectedPerRun * 2)},`);
    expect(judgedPlan).toContain("item(s)/sample (overhead note)");
    expect(estimate.observedCalls).toBe(1);
    expect(estimate.maxInputTokens).toBeGreaterThan(1000);
    expect(estimate.perRun).toBeGreaterThan(estimate.maxInputTokens);
    expect(estimate.expectedPerRun).toBe(
      Object.values(saved.responses.entries)
        .flat()
        .reduce((sum, response) => sum + response.tokenEstimate, 0),
    );
    expect(estimate.expectedPerRun).toBeLessThan(estimate.perRun);
    const fake = makeReplayProvider(saved.responses);
    const live = await replaySynthesisFile({
      input: file,
      label: "fake-live",
      root: dir,
      provider: fake,
    });
    expect(live.status).toBe("completed");
    expect(
      JSON.parse(await readFile(join(live.dir, "eval-sample.json"), "utf8")).modelCalls,
    ).toMatchObject({ live: 1, replayed: 0 });
    expect(saved.input.priorStages.map((row) => row.stage)).toContain("critique");
    const ablatedEstimate = await estimateSynthesisFile(file, "critique");
    expect(ablatedEstimate.maxInputTokens).toBeLessThan(estimate.maxInputTokens);
    expect(ablatedEstimate.judgeItems).toBeGreaterThan(0);
    expect(ablatedEstimate.judgePerRun).toBeGreaterThan(ablatedEstimate.judgeItems * 3);
    const isolatedEstimate = await estimateSynthesisFile(file, "specialist-analysis");
    expect(isolatedEstimate.arm).toEqual({
      name: "specialist-analysis",
      removed: ["specialist-analysis"],
      regenerated: ["instrument-evidence-analysis", "market-behavior-analysis", "critique"],
      control: "specialist-analysis-control",
    });
    expect(isolatedEstimate.expectedPerRun).toBeGreaterThan(estimate.expectedPerRun);
    expect(isolatedEstimate.judgeRecheckWorstPerRun).toBeGreaterThan(0);
    expect(isolatedEstimate.totalWorstPerRun).toBe(
      isolatedEstimate.perRun +
        isolatedEstimate.judgePerRun +
        isolatedEstimate.judgeRecheckWorstPerRun,
    );
    const [recorded] = Object.values(saved.responses.entries).flat();
    expect(estimate.callOverhead).toBe(
      Math.max(
        0,
        recorded!.tokenEstimate - estimate.maxInputTokens - Math.ceil(recorded!.content.length / 4),
      ),
    );
    const controlEstimate = await estimateSynthesisFile(file, "market-behavior-analysis-control");
    const subsetArm = await estimateSynthesisFile(file, "market-behavior-analysis");
    const subset = approvalSubsetEstimate(subsetArm, controlEstimate, 3);
    const canceled = subsetArm.judgeAlwaysCanceled;
    expect(subset).toEqual({
      earlyStop:
        (subsetArm.totalEarlyStopPerRun + controlEstimate.totalEarlyStopPerRun) * 3 -
        canceled.earlyStopPerRun * 3,
      expected:
        (subsetArm.totalExpectedPerRun + controlEstimate.totalExpectedPerRun) * 3 -
        canceled.perRun * 3,
      worst:
        (subsetArm.totalWorstPerRun + controlEstimate.totalWorstPerRun) * 3 - canceled.perRun * 3,
    });
    expect(canceled.perRun).toBeLessThan(subsetArm.judgePerRun);
    const runArm = async (
      ablation: "market-behavior-analysis" | "market-behavior-analysis-control",
    ) => {
      const stageCalls: string[] = [];
      const critiquePrompts: string[] = [];
      const synthesisReplay = makeReplayProvider(saved.responses);
      const result = await replaySynthesisFile({
        input: file,
        label: ablation,
        root: dir,
        ablation,
        provider: {
          name: "split",
          generate: async (request) => {
            const requested = requestStage(request);
            stageCalls.push(requested);
            if (requested === "critique") {
              critiquePrompts.push(request.messages.map((message) => message.content).join("\n"));
            }
            return requested === "final-synthesis"
              ? synthesisReplay.generate(request)
              : { content: JSON.stringify({ stage: requested }), tokenEstimate: 7 };
          },
        },
      });
      expect(result.status).toBe("completed");
      expect(stageCalls[0]).toBe("critique");
      expect(stageCalls.slice(1).every((row) => row === "final-synthesis")).toBe(true);
      const sample = JSON.parse(await readFile(join(result.dir, "eval-sample.json"), "utf8"));
      expect(sample.modelCalls).toMatchObject({ analysis: 1, live: stageCalls.length });
      expect(sample.tokens.analysis).toBe(7);
      return { sample, critiquePrompt: critiquePrompts[0]! };
    };
    const isolated = await runArm("market-behavior-analysis");
    expect(isolated.sample.arm).toEqual({
      name: "market-behavior-analysis",
      removed: ["market-behavior-analysis"],
      regenerated: ["critique"],
      control: "market-behavior-analysis-control",
    });
    const control = await runArm("market-behavior-analysis-control");
    expect(control.sample.arm).toEqual({
      name: "market-behavior-analysis-control",
      removed: [],
      regenerated: ["critique"],
    });
    expect(control.critiquePrompt).toContain(`"stage":"market-behavior-analysis"`);
    expect(isolated.critiquePrompt).not.toContain(`"stage":"market-behavior-analysis"`);
    const judgeRequests: string[] = [];
    const ablated = await replaySynthesisFile({
      input: file,
      label: "no-critique",
      root: dir,
      provider: makeReplayProvider(saved.responses),
      ablation: "critique",
      omissionCases: [],
      judge: {
        model: "stub-judge",
        provider: {
          name: "stub",
          generate: async (request) => {
            judgeRequests.push(request.stage ?? "");
            return { content: JSON.stringify({ verdict: "no" }), tokenEstimate: 1 };
          },
        },
      },
    });
    const ablatedSample = JSON.parse(await readFile(join(ablated.dir, "eval-sample.json"), "utf8"));
    expect(ablatedSample.arm).toEqual({
      name: "critique",
      removed: ["critique"],
      regenerated: [],
      control: "baseline",
    });
    expect(ablatedSample.defects.claims).toBeGreaterThan(0);
    // Unanimous "no" votes stop each judgment after two.
    const ablatedReport = JSON.parse(await readFile(join(ablated.dir, "report.json"), "utf8"));
    expect(ablatedReport.predictions.length).toBeGreaterThan(0);
    const judgedUnits =
      ablatedSample.defects.claims -
      ablatedReport.predictions.length -
      ablatedReport.scenarios.length;
    const judgeCalls = judgedUnits * 2;
    expect(ablatedSample.judged).toMatchObject({
      contradictions: [],
      unconveyed: [],
      undecided: 0,
      insufficientEvidence: 0,
    });
    expect(ablatedSample.judged.units).toHaveLength(judgedUnits);
    expect(ablatedSample.judged.units[0]).toEqual({
      location: "summary",
      kind: "contradiction",
      verdict: "no",
      votes: ["no", "no"],
      evidenceChars: expect.any(Number),
      clipped: true,
    });
    expect(ablatedSample.modelCalls).toMatchObject({ judge: judgeCalls, live: 1 + judgeCalls });
    expect(ablatedSample.tokens.live).toBe(ablatedSample.tokens.synthesis + judgeCalls);
    expect(judgeRequests).toHaveLength(judgeCalls);
    expect(new Set(judgeRequests)).toEqual(new Set(["eval-judge"]));
    let judgeAttempts = 0;
    const brokenJudge = await replaySynthesisFile({
      input: file,
      label: "judge-fails-on-call-5",
      root: dir,
      provider: makeReplayProvider(saved.responses),
      omissionCases: [],
      judge: {
        model: "stub-judge",
        provider: {
          name: "stub",
          generate: async () => {
            judgeAttempts += 1;
            if (judgeAttempts === 5) {
              throw new Error("judge outage");
            }
            return { content: JSON.stringify({ verdict: "no" }), tokenEstimate: 2 };
          },
        },
      },
    });
    expect(brokenJudge.status).toBe("failed");
    const brokenSample = JSON.parse(
      await readFile(join(brokenJudge.dir, "eval-sample.json"), "utf8"),
    );
    expect(brokenSample.error).toBe("judge outage");
    expect(brokenSample.modelCalls).toMatchObject({ judge: 5, live: 1 + 5 });
    expect(brokenSample.tokens.judge).toBe(8);
    let pairedJudgeCalls = 0;
    const pairRoot = join(dir, "paired");
    const omissionFixture = parseEvalCases(
      await Bun.file(join(import.meta.dir, "fixtures/eval-cases/cases.json")).json(),
    ).find((row): row is OmissionCase => row.check === "omission")!;
    const sharedCase = { ...omissionFixture, capture: saved.input.runId };
    const pair = await replayPairedSample({
      input: file,
      index: 1,
      root: pairRoot,
      ablation: "market-behavior-analysis",
      provider: {
        name: "split",
        generate: async (request) => {
          const requested = requestStage(request);
          return requested === "final-synthesis"
            ? makeReplayProvider(saved.responses).generate(request)
            : { content: JSON.stringify({ stage: requested }), tokenEstimate: 7 };
        },
      },
      omissionCases: [sharedCase],
      judge: {
        model: "stub-judge",
        provider: {
          name: "stub",
          generate: async () => {
            pairedJudgeCalls += 1;
            return { content: JSON.stringify({ verdict: "no" }), tokenEstimate: 1 };
          },
        },
      },
    });
    expect([basename(pair.control.dir), basename(pair.ablation.dir)]).toEqual([
      "control-1",
      "ablation-1",
    ]);
    const pairSamples = await Promise.all(
      [pair.control, pair.ablation].map(async (sample) =>
        JSON.parse(await readFile(join(sample.dir, "eval-sample.json"), "utf8")),
      ),
    );
    expect(pairSamples.map((sample) => sample.arm.name)).toEqual([
      "market-behavior-analysis-control",
      "market-behavior-analysis",
    ]);
    // Both arms replay the same recorded synthesis: contradictions cancel, the conveyance request is judged once.
    expect(pairedJudgeCalls).toBe(2);
    for (const sample of pairSamples) {
      expect(sample.status).toBe("completed");
      expect(sample.judged.canceled).toHaveLength(sample.judged.items - 1);
      expect(sample.judged.items).toBeLessThan(sample.defects.claims);
      expect(sample.judged.contradictions).toEqual([]);
      expect(sample.judged.sharedConveyance).toEqual([sharedCase.id]);
      expect(sample.judged.unconveyed).toEqual([sharedCase.id]);
      expect(sample.modelCalls).toMatchObject({ analysis: 1 });
    }
    expect(pairSamples.map((sample) => sample.modelCalls.judge)).toEqual([2, 0]);
    await expect(
      replayPairedSample({
        input: file,
        index: 2,
        root: pairRoot,
        ablation: "market-behavior-analysis-control",
        provider: makeReplayProvider(saved.responses),
        judge: { model: "stub-judge", provider: makeReplayProvider({ entries: {} }) },
      }),
    ).rejects.toThrow("control arm");
    const probe = structuredClone(saved);
    // Capture 6b4aa8ab: a valuation-workbench revenue input the synthesis prompt never shows.
    Object.assign(probe.input.collectedSources, {
      valuationWorkbench: {
        historicalMultiples: { observations: [{ inputs: { revenue: { value: 4_319_000_000 } } }] },
      },
    });
    expect(JSON.stringify(probe.input.collectedSources)).toContain("4319000000");
    expect(JSON.stringify(judgeEvidence(probe))).not.toContain("4319000000");
    const noCritique = join(dir, "no-critique-final-synthesis-input.json");
    await writeFile(
      noCritique,
      JSON.stringify({
        ...saved,
        input: {
          ...saved.input,
          priorStages: saved.input.priorStages.filter((row) => row.stage !== "critique"),
        },
      }),
    );
    await expect(estimateSynthesisFile(noCritique, "critique")).rejects.toThrow(
      "has no critique stage",
    );
    const overview = join(dir, "overview-final-synthesis-input.json");
    await writeFile(
      overview,
      JSON.stringify({
        ...saved,
        input: { ...saved.input, command: { ...saved.input.command, jobType: "crypto" } },
      }),
    );
    await expect(estimateSynthesisFile(overview, "specialist-analysis")).rejects.toThrow(
      "only equity inputs",
    );
    const frozen = structuredClone(saved);
    Object.assign(frozen.input.context, {
      domainPlaybooks: [
        {
          stage: "final-synthesis",
          playbooks: [{ id: "stale-playbook", content: "STALE_INSTRUCTION" }],
        },
      ],
    });
    const rebuilt = await executeSynthesisInput(frozen, {
      onRequest: (request) => {
        expect(request.messages[1]?.content).not.toContain("STALE_INSTRUCTION");
        expect(request.messages[1]?.content).toContain("domainPlaybooks");
      },
    });
    expect(rebuilt.report.symbol).toBe(produced.report.symbol);
    const rerun = await rerunReport({
      run: produced.artifacts.runDir,
      label: "projection",
      root: dir,
    });
    expect(rerun.status).toBe("completed");
    expect(
      JSON.parse(await readFile(join(rerun.dir, "report.json"), "utf8")).extras.metricSections,
    ).toBeDefined();
    await expect(replaySynthesisFile({ input: file, label: "stage", root: dir })).rejects.toThrow();
    await expect(
      rerunReport({ run: produced.artifacts.runDir, label: "../escape", root: dir }),
    ).rejects.toThrow("Unsafe eval label");
    for (const value of [
      { ...saved, version: 2 },
      { ...saved, input: { ...saved.input, knownSourceIds: ["missing"] } },
      {
        ...saved,
        input: { ...saved.input, settings: { ...saved.input.settings, apiKey: "sentinel-secret" } },
      },
      {
        ...saved,
        input: {
          ...saved.input,
          context: { ...saved.input.context, evidenceQualityAssessment: { label: "low" } },
        },
      },
      {
        ...saved,
        input: {
          ...saved.input,
          collectedSources: {
            ...saved.input.collectedSources,
            businessFramework: {
              ...saved.input.collectedSources.businessFramework,
              sections: [null],
            },
          },
        },
      },
      {
        ...saved,
        input: {
          ...saved.input,
          collectedSources: {
            ...saved.input.collectedSources,
            metricSections: [{ id: "bad", title: "Bad", metrics: [null] }],
          },
        },
      },
    ]) {
      expect(() => readSynthesisReplayInput(value)).toThrow();
    }
    const noResponses = { ...saved, responses: { entries: {} } };
    await writeFile(join(dir, "missing-responses.json"), JSON.stringify(noResponses));
    const failed = await replaySynthesisFile({
      input: join(dir, "missing-responses.json"),
      label: "missing",
      root: dir,
    });
    expect(failed.status).toBe("failed");
    expect(await readFile(join(failed.dir, "eval-sample.json"), "utf8")).toContain("LLM cassette");
    delete loaded.state!.values.calibration;
    await writeFile(join(capture, "state.json"), JSON.stringify(loaded.state));
    const incomplete = await runEvalSample({
      fixture: capture,
      sample: "1",
      label: "incomplete",
      root: dir,
      llm: "replay",
    });
    expect(incomplete.status).not.toBe("completed");
    expect(incomplete.modelCalls.live).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
    expect(defaultFetchCalls).toBe(0);
  }
}, 30_000);

test("capture errors leave the research result usable and never publish a valid capture", async () => {
  const dir = await createRoot();
  const artifacts = { runDir: join(dir, "run") };
  await mkdir(artifacts.runDir);
  await writeFile(join(artifacts.runDir, "report.json"), JSON.stringify({ preserved: true }));
  const fixture = await loadFixture("equity-aapl-brief");
  const command = parseArgs(fixture.meta.argv);
  if (command.jobType !== "equity") {
    throw new Error("expected equity");
  }
  const result = await withRunCapture(
    {
      command,
      config: { ...createFixtureConfig(fixture.meta, dir), captureReplay: true },
      now: new Date(fixture.meta.now),
      provider: {
        name: "throwing",
        generate: async () => {
          throw new Error("default model touched");
        },
      },
      fetchImpl: async () => {
        throw new Error("default HTTP touched");
      },
    },
    async () => {
      captureSynthesisInput({ invalid: "checkpoint" });
      return { artifacts, value: "research survived" };
    },
  );
  expect(result.value).toBe("research survived");
  const runDirEntries = await readdir(artifacts.runDir);
  expect(runDirEntries).toContain("capture-failure.json");
  expect(runDirEntries).not.toContain("replay");
  expect(runDirEntries.some((name) => name.startsWith(".replay-"))).toBe(false);
  expect(JSON.parse(await readFile(join(artifacts.runDir, "report.json"), "utf8"))).toEqual({
    preserved: true,
  });
});

test("circuit capture stays compact across distinct requests while preserving transitions and exhaustion", async () => {
  const dir = await createRoot();
  const fixture = await loadFixture("equity-aapl-brief");
  const options = { ...createFixtureConfig(fixture.meta, dir).sourceOptions, cacheDisabled: true };
  const state: ReplayState = { values: {} };
  const http = createRecordingFetch(
    async (input) => new Response("{}", { status: String(input).includes("limited") ? 429 : 200 }),
  );
  await withReplaySession(
    { mode: "record", offline: true, state, indexes: new Map(), failures: [] },
    async () => {
      const { request } = createSourceRequestContext(
        options,
        new Date(fixture.meta.now),
        http.fetch,
        [],
      );
      for (let index = 0; index < 100; index += 1) {
        const result = await request.json({
          url: `https://compact-circuit.test/quote?symbol=${String(index)}`,
          adapter: "capture-test",
        });
        expect("rawSnapshot" in result).toBe(true);
      }
      await request.json({ url: "https://compact-circuit.test/limited", adapter: "capture-test" });
      const blocked = await request.json({
        url: "https://compact-circuit.test/blocked",
        adapter: "capture-test",
      });
      expect("cause" in blocked && blocked.cause).toBe("circuit-open");
    },
  );
  expect(JSON.stringify(state).length).toBeLessThan(200);
  await withReplaySession(
    { mode: "replay", offline: true, state, indexes: new Map(), failures: [] },
    async () => {
      const { request } = createSourceRequestContext(
        options,
        new Date(fixture.meta.now),
        makeReplayFetch(http.cassette()),
        [],
      );
      for (let index = 0; index < 100; index += 1) {
        const result = await request.json({
          url: `https://compact-circuit.test/quote?symbol=${String(index)}`,
          adapter: "capture-test",
        });
        expect("rawSnapshot" in result).toBe(true);
      }
      const limited = await request.json({
        url: "https://compact-circuit.test/limited",
        adapter: "capture-test",
      });
      expect("cause" in limited && limited.cause).toBe("fetch-failed");
      const blocked = await request.json({
        url: "https://compact-circuit.test/blocked",
        adapter: "capture-test",
      });
      expect("cause" in blocked && blocked.cause).toBe("circuit-open");
      expect(() => replayValueSync(Object.keys(state.values)[0]!, () => false)).toThrow(
        "Replay state miss",
      );
    },
  );
  const key = Object.keys(state.values)[0]!;
  const failures: string[] = [];
  state.values[key] = [{ value: false, count: 0 }];
  await withReplaySession(
    { mode: "replay", offline: true, state, indexes: new Map(), failures },
    async () => {
      expect(() => replayValueSync(key, () => false)).toThrow("Invalid replay state count");
    },
  );
  expect(failures).toEqual([`Invalid replay state count: ${key}`]);
});

test.each(["equity-web-fallback-deep", "equity-earnings-release-deep"])(
  "%s captures its conditional stages and repairs through the real producer",
  async (name) => {
    const dir = await createRoot();
    const produced = await runFixture(name, {
      llm: "replay",
      capture: true,
      dataDir: join(dir, "runs"),
    });
    const capture = join(produced.artifacts.runDir, "replay");
    const saved = await loadSynthesisReplayInput(join(capture, "final-synthesis-input.json"));
    const replay = await runFixture(capture);
    try {
      expect(replay.report.symbol).toBe(produced.report.symbol);
      expect(replay.report.extras?.webSubjectProfile).toBeDefined();
      const stage = await executeSynthesisInput(saved);
      expect(stage.calls).toBe(name === "equity-earnings-release-deep" ? 2 : 1);
      expect(stage.report.extras?.webSubjectProfile).toBeDefined();
    } finally {
      await replay.cleanup();
    }
  },
  30_000,
);

test("model recording covers bypass stages, challenger models, ordered concurrent calls and provider errors", async () => {
  const recorder = createRecordingProvider({
    name: "fake",
    generate: async (request) => {
      if (request.model === "failed") {
        throw new Error("recorded provider failure");
      }
      await Promise.resolve();
      return { content: request.model, tokenEstimate: 10 };
    },
  });
  const requests = [
    modelRequest("financial-table-mapping", "quick"),
    modelRequest("spotlight-selection", "quick"),
    modelRequest("peer-universe-proposal", "quick"),
    modelRequest("forecast-disagreement", "one"),
    modelRequest("forecast-disagreement", "two"),
  ];
  await Promise.all(requests.map((row) => recorder.provider.generate(row)));
  await expect(
    recorder.provider.generate(modelRequest("forecast-disagreement", "failed")),
  ).rejects.toThrow("recorded provider failure");
  const replay = makeReplayProvider(recorder.cassette());
  for (const row of requests) {
    // oxlint-disable-next-line no-await-in-loop -- each recorded identity is independently consumed
    const response = await replay.generate(row);
    expect(response.content).toBe(row.model);
  }
  await expect(replay.generate(modelRequest("forecast-disagreement", "failed"))).rejects.toThrow(
    "recorded provider failure",
  );
});

test("offline scripts reject live flags before opening inputs or creating outputs", async () => {
  const process = Bun.spawn(["bun", "run", "scripts/replay-stage.ts", "--live"], {
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await process.exited).not.toBe(0);
  expect(await new Response(process.stderr).text()).toContain("Unknown option");
});

test("captures 403 responses and redacts query credentials, auth headers and large echoed bodies before persistence", async () => {
  const secret = "synthetic-sentinel-credential";
  const recorder = createRecordingFetch(
    async () =>
      new Response(`${secret} forbidden`, {
        status: 403,
        headers: { authorization: `Bearer ${secret}` },
      }),
    (text) => text.replaceAll(secret, "redacted"),
  );
  const response = await recorder.fetch(
    `https://example.test/data?token=${secret}&apiKey=${secret}&key=${secret}`,
    {
      headers: { authorization: `Bearer ${secret}` },
    },
  );
  expect(response.status).toBe(403);
  const text = JSON.stringify(recorder.cassette());
  expect(text).not.toContain(secret);
  expect(text).not.toContain("authorization");
  const replay = await makeReplayFetch(recorder.cassette())(
    "https://example.test/data?token=replay",
  );
  expect(replay.status).toBe(403);
  expect(await replay.text()).toContain("forbidden");
});

test("HTTP transport failures preserve their retry classification when recorded and replayed", async () => {
  const recorder = createRecordingFetch(() => {
    const error = new Error("timed out");
    error.name = "TimeoutError";
    throw error;
  });
  await expect(recorder.fetch("https://example.test/timeout")).rejects.toThrow("timed out");
  const replayError = await makeReplayFetch(recorder.cassette())(
    "https://example.test/timeout",
  ).catch((error: unknown) => error);
  expect(replayError).toBeInstanceOf(Error);
  expect((replayError as Error).name).toBe("TimeoutError");
});

test("state replay distinguishes omitted values from empty values and fails closed on missing reads", async () => {
  const state: ReplayState = { values: {} };
  await withReplaySession(
    { mode: "record", offline: true, state, indexes: new Map(), failures: [] },
    async () => {
      await replayValue("optional", async () => undefined);
      await replayValue("empty", async () => []);
    },
  );
  await withReplaySession(
    { mode: "replay", offline: true, state, indexes: new Map(), failures: [] },
    async () => {
      expect(await replayValue("optional", forbidden)).toBeUndefined();
      expect(await replayValue("empty", forbidden)).toEqual([]);
      await expect(replayValue("unrecorded", forbidden)).rejects.toThrow("Replay state miss");
    },
  );
});

test("replay state keys ignore credential query values so a capture replays under a fixture token", async () => {
  const dir = await createRoot();
  const now = new Date("2026-10-16T15:39:21.051Z");
  const options = {
    dir: join(dir, "cache"),
    disabled: false,
    fallbackDays: 7,
    now: () => now,
    onStaleFallback: () => {},
  };
  const inner = async () => ({
    rawSnapshot: {
      id: "raw-massive-news-synthetic",
      adapter: "massive-news",
      fetchedAt: now.toISOString(),
      payload: { news: [] },
    },
    payload: { news: [] },
  });
  const state: ReplayState = { values: {} };
  await withReplaySession(
    { mode: "record", offline: true, state, indexes: new Map(), failures: [] },
    () =>
      withCache(inner, options)({ url: massiveNewsUrl("live-secret"), adapter: "massive-news" }),
  );
  const failures: string[] = [];
  const replayed = await withReplaySession(
    { mode: "replay", offline: true, state, indexes: new Map(), failures },
    () =>
      withCache(inner, options)({ url: massiveNewsUrl("fixture-token"), adapter: "massive-news" }),
  );
  expect(replayed).toMatchObject({ payload: { news: [] } });
  expect(failures).toEqual([]);
});
