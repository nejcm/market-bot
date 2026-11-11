import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AppConfig } from "../config";
import type { ModelProvider } from "../model/types";
import { MAX_REPORT_VALIDATION_REPROMPTS } from "../research/final-synthesis";
import { MAX_PREDICTION_REPROMPTS } from "../research/synthesis-phase";
import { RUN_ARTIFACT_FILES } from "../run-artifact-layout";
import type { FetchLike } from "../sources/types";
import { countCassetteMisses, makeReplayFetch } from "./data-cassette";
import { createProvider } from "../model/factory";
import {
  createFixtureConfig,
  createLiveFixtureConfig,
  loadFixture,
  runFixture,
} from "./fixture-run";
import {
  type LiveStage,
  validateLiveStage,
  requestStage,
  makeReplayProvider,
  ModelReplayError,
  type ReplayProvider,
} from "./llm-cassette";
import { EVALS_ROOT } from "./eval-output";
import {
  EVAL_SAMPLE_FILE,
  evalLabelDir,
  pathSegment,
  writeEvalSummary,
  type EvalSampleRecord,
  type EvalSampleStatus,
} from "./eval-summary";

const MAX_RAW_RESPONSE_CHARS = 20_000;

// Older Bun releases (CI pins one) omit the "Name: message" header from error.stack.
function errorStackWithMessage(error: Error, stack: string): string {
  const header = `${error.name}: ${error.message}`;
  return stack.startsWith(header) ? stack : `${header}\n${stack.replace(/^\w*Error\n/u, "")}`;
}
// AGENTS.md: a deep live equity run is ~438k tokens; synthetic cassettes record far less.
const LIVE_DEEP_RUN_TOKENS = 438_000;
// Initial call, prediction reprompts, the report retry and its prediction follow-up, report repairs.
const MAX_FINAL_SYNTHESIS_CALLS =
  1 + MAX_PREDICTION_REPROMPTS + 2 + MAX_REPORT_VALIDATION_REPROMPTS;
// Recorded deep fixtures spend ~37k–46k per synthesis call; synthetic cassettes record ~100.
const LIVE_STAGE_CALL_TOKENS = 50_000;

export interface EvalSampleInput {
  readonly root?: string;
  readonly label: string;
  readonly fixture: string;
  readonly sample: string;
  readonly llm: "replay" | "live";
  readonly fetchImpl?: FetchLike;
  readonly provider?: ModelProvider;
  readonly liveStages?: LiveStage;
  readonly onSynthesisInput?: (input: unknown) => void;
}

export interface EvalSampleResult extends EvalSampleRecord {
  readonly sampleDir: string;
  readonly runDir?: string;
}

// Plain-name segments keep `runs/..` (cache, calibration, news-seen, peers) inside the sample dir.
export function evalSampleDir(
  root: string,
  label: string,
  fixture: string,
  sample: string,
): string {
  return join(
    evalLabelDir(root, label),
    pathSegment(
      fixture.includes("/")
        ? `${basename(resolve(fixture, ".."))}-${new Bun.CryptoHasher("sha256").update(resolve(fixture)).digest("hex").slice(0, 8)}`
        : fixture,
    ),
    pathSegment(sample),
  );
}

function disableIndexAccess(): () => void {
  const saved = {
    MARKET_BOT_INDEX_DISABLE: process.env.MARKET_BOT_INDEX_DISABLE,
    MARKET_BOT_INDEX_DB_PATH: process.env.MARKET_BOT_INDEX_DB_PATH,
  };
  process.env.MARKET_BOT_INDEX_DISABLE = "1";
  delete process.env.MARKET_BOT_INDEX_DB_PATH;
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
}

async function publishedRunDirName(dataDir: string): Promise<string | undefined> {
  const names = await readdir(dataDir).catch(() => []);
  return names.find((name) => !name.startsWith("."));
}

export async function runEvalSample(input: EvalSampleInput): Promise<EvalSampleResult> {
  if (input.liveStages !== undefined) {
    validateLiveStage(input.liveStages);
    if (input.llm === "replay" && input.provider === undefined) {
      throw new Error("Selected offline evaluation requires an injected provider");
    }
  }
  const sampleDir = evalSampleDir(
    input.root ?? EVALS_ROOT,
    input.label,
    input.fixture,
    input.sample,
  );
  const fixture = await loadFixture(input.fixture);
  await mkdir(dirname(sampleDir), { recursive: true });
  // Non-recursive: an existing sample dir throws EEXIST instead of mixing two runs' state.
  await mkdir(sampleDir);
  const dataDir = join(sampleDir, "runs");
  const missKeys: string[] = [];
  const modelMissKeys: string[] = [];
  const modelMissErrors: string[] = [];
  let replayedCalls = 0;
  let liveCalls = 0;
  let replayedTokens = 0;
  let liveTokens = 0;
  const replay: { provider?: ReplayProvider } = {};
  const fetchImpl = countCassetteMisses(
    input.fetchImpl ?? makeReplayFetch(fixture.dataCassette, fixture.dir),
    missKeys,
  );
  const startedAt = performance.now();
  const restoreEnv = disableIndexAccess();
  let rawResponseContent: string | undefined = undefined;
  const runError = await (async () => {
    const baseProvider =
      input.provider ??
      (input.llm === "replay" && input.liveStages === undefined
        ? makeReplayProvider(fixture.llmCassette)
        : createProvider(createLiveFixtureConfig(fixture.meta, dataDir)));
    const countedLive: ModelProvider = {
      ...baseProvider,
      generate: async (request) => {
        if (missKeys.length > 0 || modelMissKeys.length > 0) {
          throw new Error("Refusing live model call after replay failure");
        }
        liveCalls += 1;
        const response = await baseProvider.generate(request);
        liveTokens += response.tokenEstimate;
        return response;
      },
    };
    const provider =
      input.liveStages !== undefined
        ? makeReplayProvider(fixture.llmCassette, countedLive, input.liveStages)
        : baseProvider;
    const routedProvider =
      input.liveStages === undefined && input.llm === "live" ? countedLive : provider;
    if ("diagnostics" in provider && typeof provider.diagnostics === "function") {
      replay.provider = provider as ReplayProvider;
    }
    return runFixture(input.fixture, {
      llm: input.llm,
      dataDir,
      keepDataDir: true,
      fetchImpl,
      ...(input.onSynthesisInput === undefined ? {} : { onSynthesisInput: input.onSynthesisInput }),
      provider: {
        ...routedProvider,
        generate: async (request) => {
          rawResponseContent = undefined;
          try {
            const response = await routedProvider.generate(request);
            if (
              input.liveStages !== undefined
                ? requestStage(request) !== input.liveStages
                : input.llm === "replay"
            ) {
              replayedCalls += 1;
              replayedTokens += response.tokenEstimate;
            }
            rawResponseContent = response.content.slice(0, MAX_RAW_RESPONSE_CHARS);
            return response;
          } catch (error) {
            if (error instanceof ModelReplayError) {
              modelMissKeys.push(error.key);
              modelMissErrors.push(error.message);
            }
            throw error;
          }
        },
      },
    });
  })()
    .then(
      () => undefined,
      (error: unknown) => error ?? new Error("Fixture run threw a nullish value"),
    )
    .finally(restoreEnv);
  const runDirName = await publishedRunDirName(dataDir);
  const runDir = runDirName === undefined ? undefined : join(dataDir, runDirName);
  let status: EvalSampleStatus = "completed";
  if (runError !== undefined) {
    status =
      runDir !== undefined && existsSync(join(runDir, RUN_ARTIFACT_FILES.failure))
        ? "failed-final-synthesis"
        : "threw";
  }
  if (
    missKeys.length > 0 ||
    modelMissKeys.length > 0 ||
    (runError instanceof Error && /Replay state/iu.test(runError.message))
  ) {
    status = "incomplete";
  } else if (
    runError === undefined &&
    (input.llm === "live" || input.liveStages !== undefined) &&
    liveCalls === 0
  ) {
    status = "not-exercised";
  }
  const record: EvalSampleRecord = {
    fixture: input.fixture,
    sample: input.sample,
    status,
    ...(runDirName !== undefined ? { runDirName } : {}),
    durationMs: Math.round(performance.now() - startedAt),
    cassetteMisses: { count: missKeys.length, keys: missKeys },
    modelReplayMisses: {
      count: modelMissKeys.length,
      keys: modelMissKeys,
      errors: modelMissErrors,
    },
    modelCalls: { replayed: replayedCalls, live: liveCalls },
    tokens: { replayed: replayedTokens, live: liveTokens },
    ...(input.liveStages !== undefined
      ? {
          evaluation: {
            liveStage: input.liveStages,
            downstreamReasoning: "recorded" as const,
            sourceRequests: "cassette-only" as const,
          },
        }
      : {}),
    ...(replay.provider !== undefined ? { responseUsage: replay.provider.diagnostics() } : {}),
    ...(runError !== undefined
      ? { error: runError instanceof Error ? runError.message : String(runError) }
      : {}),
    ...(runError instanceof Error && runError.stack !== undefined
      ? { errorStack: errorStackWithMessage(runError, runError.stack) }
      : {}),
    ...(runError !== undefined &&
    missKeys.length === 0 &&
    modelMissKeys.length === 0 &&
    rawResponseContent !== undefined
      ? { rawResponseContent }
      : {}),
  };
  await writeFile(join(sampleDir, EVAL_SAMPLE_FILE), `${JSON.stringify(record, undefined, 2)}\n`);
  return { ...record, sampleDir, ...(runDir !== undefined ? { runDir } : {}) };
}

export async function runEvalBatch(input: {
  readonly root: string;
  readonly label: string;
  readonly fixtures: readonly string[];
  readonly samples: number;
  readonly runSample: (fixture: string, sample: string) => Promise<EvalSampleResult>;
}): Promise<0 | 1> {
  let exitCode: 0 | 1 = 0;
  for (const fixture of input.fixtures) {
    for (let sample = 1; sample <= input.samples; sample += 1) {
      // eslint-disable-next-line no-await-in-loop -- samples share process-level index overrides
      const result = await input.runSample(fixture, String(sample));
      if (result.status !== "completed") {
        exitCode = 1;
      }
      // eslint-disable-next-line no-await-in-loop -- preserve a summary after every sample
      await writeEvalSummary(input.root, input.label);
    }
  }
  return exitCode;
}

export async function unreplayableFixtureError(fixture: string): Promise<string | undefined> {
  const { meta } = await loadFixture(fixture);
  const { replayClassification } = meta;
  return replayClassification === "incomplete"
    ? `Fixture ${fixture} is not replayable: replayClassification "${replayClassification}"`
    : undefined;
}

function boundedStageCalls(stage: LiveStage, config: AppConfig): number {
  switch (stage) {
    case "final-synthesis": {
      return MAX_FINAL_SYNTHESIS_CALLS;
    }
    case "web-gather": {
      return config.webGatherOptions.maxRounds;
    }
    case "evidence-request": {
      return config.evidenceRequestOptions.maxRounds;
    }
    case "forecast-disagreement": {
      return config.forecastDisagreementOptions?.challengerModels.length ?? 0;
    }
    default: {
      return 1;
    }
  }
}

export async function liveTokenEstimate(
  fixture: string,
  liveStages?: LiveStage,
): Promise<{
  readonly recorded: number;
  readonly perRun: number;
  readonly boundedCalls?: number;
  readonly observedCalls?: number;
  readonly maxInputTokens?: number;
  readonly expectedPerRun?: number;
}> {
  if (liveStages !== undefined) {
    validateLiveStage(liveStages);
  }
  const { llmCassette, meta } = await loadFixture(fixture);
  const entries = Object.entries(llmCassette.entries)
    .filter(([key]) => liveStages === undefined || key.startsWith(`${liveStages}|`))
    .flatMap(([, stageEntries]) => stageEntries);
  const recorded = entries.reduce((sum, entry) => sum + entry.tokenEstimate, 0);
  if (liveStages === undefined) {
    return { recorded, perRun: Math.max(recorded, LIVE_DEEP_RUN_TOKENS) };
  }
  const root = await mkdtemp(join(tmpdir(), "market-bot-eval-estimate-"));
  const restoreEnv = disableIndexAccess();
  let maxInputTokens = 0;
  let observedCalls = 0;
  let expectedPerRun = 0;
  try {
    const replay = makeReplayProvider(llmCassette);
    await runFixture(fixture, {
      llm: "replay",
      dataDir: join(root, "runs"),
      provider: makeReplayProvider(
        llmCassette,
        {
          name: "offline-prompt-measurement",
          generate: async (request) => {
            const inputTokens = Math.ceil(
              request.messages.reduce((sum, message) => sum + message.content.length, 0) / 4,
            );
            observedCalls += 1;
            maxInputTokens = Math.max(maxInputTokens, inputTokens);
            const response = await replay.generate(request);
            expectedPerRun += Math.max(
              response.tokenEstimate,
              inputTokens + Math.ceil(response.content.length / 4),
            );
            return response;
          },
        },
        liveStages,
      ),
    });
  } finally {
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
  const config = createFixtureConfig(meta, join(root, "runs"));
  const boundedCalls = boundedStageCalls(liveStages, config);
  const callTokens = Math.max(
    LIVE_STAGE_CALL_TOKENS,
    maxInputTokens + Math.max(0, ...entries.map((entry) => Math.ceil(entry.content.length / 4))),
    ...entries.map((entry) => entry.tokenEstimate),
  );
  return {
    recorded,
    perRun: Math.max(boundedCalls, observedCalls) * Math.ceil(1.25 * callTokens),
    boundedCalls: Math.max(boundedCalls, observedCalls),
    observedCalls,
    maxInputTokens,
    expectedPerRun,
  };
}
