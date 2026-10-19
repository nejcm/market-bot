import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { withRunCapture } from "../../../src/replay/capture";
import {
  withReplaySession,
  assertReplayStateComplete,
  type ReplayState,
} from "../../../src/replay/session";
import { assertCaptureSettings, type CaptureSettings } from "../../../src/replay/settings";
import { isRecord } from "../../../src/guards";
import { readRecordedBody } from "../../../src/replay/body-file";
import { parseArgs, type ResearchCommand } from "../../../src/cli/args";
import { resolveConfig, type AppConfig } from "../../../src/config";
import { createProvider } from "../../../src/model/factory";
import type { ModelProvider } from "../../../src/model/types";
import { collectSources } from "../../../src/sources/collector";
import type { FetchLike } from "../../../src/sources/types";
import {
  persistResearchJob,
  type PersistedResearchJobResult,
} from "../../../src/research/orchestrator";
import {
  commandWithResolvedResearchSubject,
  resolveResearchSubject,
} from "../../../src/research/research-subject-identity";
import { buildSourcePlan } from "../../../src/research/source-plan";
import {
  countCassetteMisses,
  makeReplayFetch,
  type DataCassette,
} from "../../../src/replay/data-cassette";
import {
  makeReplayProvider,
  ModelReplayError,
  type LlmCassette,
} from "../../../src/replay/llm-cassette";

export interface FixtureMeta {
  readonly command?: ResearchCommand;
  readonly captureVersion?: 1;
  readonly settings?: CaptureSettings;
  readonly retryDelaysMs?: readonly number[];
  readonly replayClassification: "clean" | "missing-source" | "incomplete";
  readonly now: string;
  readonly argv: readonly string[];
  readonly quickModel?: string;
  readonly synthesisModel?: string;
  readonly challengerModels?: readonly string[];
  readonly configuredProviders?: readonly ("exa" | "finnhub" | "firecrawl" | "tradier")[];
  readonly secUserAgent?: string;
  readonly webGatherDisabled?: boolean;
  readonly evidenceRequestOptions?: {
    readonly maxRounds: number;
    readonly maxToolCalls: number;
    readonly sourceBudget: number;
  };
  readonly webGatherOptions?: {
    readonly maxRounds: number;
    readonly maxToolCalls: number;
    readonly sourceBudget: number;
  };
}

export function configuredFixtureProviders(
  sourceOptions: AppConfig["sourceOptions"],
): NonNullable<FixtureMeta["configuredProviders"]> {
  return [
    ...(sourceOptions.exaApiKey !== undefined ? (["exa"] as const) : []),
    ...(sourceOptions.finnhubApiToken !== undefined ? (["finnhub"] as const) : []),
    ...(sourceOptions.firecrawlApiKey !== undefined ? (["firecrawl"] as const) : []),
    ...(sourceOptions.tradierApiToken !== undefined ? (["tradier"] as const) : []),
  ];
}

export interface LoadedFixture {
  readonly name: string;
  readonly dir: string;
  readonly dataCassette: DataCassette;
  readonly llmCassette: LlmCassette;
  readonly meta: FixtureMeta;
  readonly state?: ReplayState;
}

export interface RunFixtureOptions {
  readonly capture?: boolean;
  readonly pacing?: boolean;
  readonly llm: "replay" | "live";
  readonly keepDataDir?: boolean;
  readonly dataDir?: string;
  readonly fetchImpl?: FetchLike;
  readonly provider?: ModelProvider;
  readonly onDataRequest?: (request: FixtureDataRequest) => void;
}

export interface RunFixtureResult extends PersistedResearchJobResult {
  readonly dataDir: string;
  readonly cleanup: () => Promise<void>;
}

export interface FixtureDataRequest {
  readonly method: string;
  readonly url: string;
}

interface FixtureDataDir {
  readonly dataDir: string;
  readonly tempRoot?: string;
}

const FIXTURE_ROOT = join(import.meta.dir, "../../fixtures/runs");

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function researchCommand(argv: readonly string[]): ResearchCommand {
  const command = parseArgs(argv);
  if (
    command.jobType === "market-overview" ||
    command.jobType === "equity" ||
    command.jobType === "crypto" ||
    command.jobType === "research"
  ) {
    return command;
  }
  throw new Error(`Fixture command must be a research run: ${argv.join(" ")}`);
}

function isStateEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.count === undefined ||
      (typeof value.count === "number" && Number.isSafeInteger(value.count) && value.count > 0))
  );
}

export async function loadFixture(name: string): Promise<LoadedFixture> {
  const dir = name.includes("/") ? resolve(name) : join(FIXTURE_ROOT, name);
  const meta = await readJson<FixtureMeta>(join(dir, "meta.json"));
  if (
    meta.captureVersion !== undefined &&
    (meta.captureVersion !== 1 || meta.settings === undefined || meta.command === undefined)
  ) {
    throw new Error("Invalid capture metadata/version");
  }
  const state =
    meta.captureVersion === undefined
      ? undefined
      : await readJson<ReplayState>(join(dir, "state.json"));
  if (
    state !== undefined &&
    (!isRecord(state) ||
      !isRecord(state.values) ||
      !Object.values(state.values).every(
        (rows) => Array.isArray(rows) && rows.every((row) => isStateEntry(row)),
      ))
  ) {
    throw new Error("Invalid capture state");
  }
  if (state !== undefined) {
    await Promise.all(
      Object.values(state.values).map(async (rows) => {
        await Promise.all(
          rows.map(async (row, index) => {
            if ("bodyFile" in row) {
              if (
                typeof row.bodyFile !== "string" ||
                !("sha256" in row) ||
                typeof row.sha256 !== "string"
              ) {
                throw new Error("Invalid state body reference");
              }
              const value: unknown = JSON.parse(
                await readRecordedBody(dir, row.bodyFile, row.sha256),
              );
              if (!isStateEntry(value)) {
                throw new Error("Invalid state body");
              }
              rows[index] = value as ReplayState["values"][string][number];
            }
          }),
        );
      }),
    );
  }
  return {
    name: basename(dir),
    dir,
    dataCassette: await readJson<DataCassette>(join(dir, "data-cassette.json")),
    llmCassette: await readJson<LlmCassette>(join(dir, "llm-cassette.json")),
    meta,
    ...(state === undefined ? {} : { state }),
  };
}

async function fixtureDataDir(
  name: string,
  requestedDataDir: string | undefined,
): Promise<FixtureDataDir> {
  if (requestedDataDir !== undefined) {
    return { dataDir: requestedDataDir };
  }
  const tempRoot = await mkdtemp(join(tmpdir(), `market-bot-${name}-`));
  return { dataDir: join(tempRoot, "runs"), tempRoot };
}

export function createFixtureConfig(meta: FixtureMeta, dataDir: string): AppConfig {
  const config = resolveConfig(
    {
      MARKET_BOT_PROVIDER: "openai",
      MARKET_BOT_QUICK_MODEL: meta.quickModel ?? "fixture-quick",
      MARKET_BOT_SYNTHESIS_MODEL: meta.synthesisModel ?? "fixture-synthesis",
      MARKET_BOT_DATA_DIR: dataDir,
      MARKET_BOT_CACHE_DIR: join(dataDir, "..", "cache"),
      MARKET_BOT_NEWS_SEEN_PATH: join(dataDir, "..", "news-seen.json"),
      MARKET_BOT_PEER_UNIVERSE_LEARNED_PATH: join(dataDir, "..", "peer-universe-learned.json"),
      MARKET_BOT_FORECAST_DISAGREEMENT_MODELS: (meta.challengerModels ?? []).join(","),
      MARKET_BOT_WEB_GATHER_DISABLE: meta.webGatherDisabled === false ? "0" : "1",
      MARKET_BOT_SEC_USER_AGENT: meta.secUserAgent ?? "",
    },
    { validateAlphaSearchOptions: false },
  );
  const sourceOptions =
    meta.secUserAgent === undefined
      ? (({ secUserAgent: _secUserAgent, ...rest }) => rest)(config.sourceOptions)
      : config.sourceOptions;
  const configuredProviders = new Set(meta.configuredProviders);
  const { settings } = meta;
  if (settings !== undefined) {
    assertCaptureSettings(settings);
    return {
      ...config,
      ...settings,
      dataDir,
      promptDir: config.promptDir,
      captureReplay: false,
      sourceOptions: {
        ...config.sourceOptions,
        ...settings.sourceOptions,
        ...Object.fromEntries(settings.configuredProviders.map((key) => [key, "fixture-token"])),
        cacheDir: join(dataDir, "..", "cache"),
        newsSeenPath: join(dataDir, "..", "news-seen.json"),
        peerUniverseLearnedPath: join(dataDir, "..", "peer-universe-learned.json"),
      },
    };
  }
  return {
    ...config,
    sourceOptions: {
      ...sourceOptions,
      ...(configuredProviders.has("exa") ? { exaApiKey: "fixture-token" } : {}),
      ...(configuredProviders.has("finnhub") ? { finnhubApiToken: "fixture-token" } : {}),
      ...(configuredProviders.has("firecrawl") ? { firecrawlApiKey: "fixture-token" } : {}),
      ...(configuredProviders.has("tradier") ? { tradierApiToken: "fixture-token" } : {}),
    },
    evidenceRequestOptions: meta.evidenceRequestOptions ?? {
      maxRounds: 0,
      maxToolCalls: 0,
      sourceBudget: 0,
    },
    webGatherOptions: meta.webGatherOptions ?? {
      maxRounds: 0,
      maxToolCalls: 0,
      sourceBudget: 0,
    },
    historyOptions: {
      tickerRecentLimit: 0,
      marketRecentLimit: 0,
      recentDays: 0,
      anchorMonths: [],
      missCorrectionLimit: 0,
    },
  };
}

// Exported for the recorder: a run recorded under any other config cannot be replayed, because
// Replay always rebuilds the config from meta.json and these fixed knobs.
export function createLiveFixtureConfig(
  meta: FixtureMeta,
  dataDir: string,
  liveConfig: AppConfig = resolveConfig(process.env, { validateAlphaSearchOptions: false }),
): AppConfig {
  const baseFixtureConfig = createFixtureConfig(meta, dataDir);
  const configuredProviders = new Set(meta.configuredProviders);
  return {
    ...baseFixtureConfig,
    provider: liveConfig.provider,
    quickModel: liveConfig.quickModel,
    synthesisModel: liveConfig.synthesisModel,
    modelTimeoutMs: liveConfig.modelTimeoutMs,
    ...(liveConfig.apiKey !== undefined ? { apiKey: liveConfig.apiKey } : {}),
    ...(liveConfig.baseUrl !== undefined ? { baseUrl: liveConfig.baseUrl } : {}),
    ...(liveConfig.quickReasoningEffort !== undefined
      ? { quickReasoningEffort: liveConfig.quickReasoningEffort }
      : {}),
    ...(liveConfig.synthesisReasoningEffort !== undefined
      ? { synthesisReasoningEffort: liveConfig.synthesisReasoningEffort }
      : {}),
    ...(liveConfig.codexQuickReasoningEffort !== undefined
      ? { codexQuickReasoningEffort: liveConfig.codexQuickReasoningEffort }
      : {}),
    ...(liveConfig.codexSynthesisReasoningEffort !== undefined
      ? { codexSynthesisReasoningEffort: liveConfig.codexSynthesisReasoningEffort }
      : {}),
    sourceOptions: {
      ...baseFixtureConfig.sourceOptions,
      ...(configuredProviders.has("exa") && liveConfig.sourceOptions.exaApiKey !== undefined
        ? { exaApiKey: liveConfig.sourceOptions.exaApiKey }
        : {}),
      ...(configuredProviders.has("finnhub") &&
      liveConfig.sourceOptions.finnhubApiToken !== undefined
        ? { finnhubApiToken: liveConfig.sourceOptions.finnhubApiToken }
        : {}),
      ...(configuredProviders.has("firecrawl") &&
      liveConfig.sourceOptions.firecrawlApiKey !== undefined
        ? { firecrawlApiKey: liveConfig.sourceOptions.firecrawlApiKey }
        : {}),
      ...(configuredProviders.has("tradier") &&
      liveConfig.sourceOptions.tradierApiToken !== undefined
        ? { tradierApiToken: liveConfig.sourceOptions.tradierApiToken }
        : {}),
    },
  };
}

function fixtureConfig(meta: FixtureMeta, dataDir: string, llm: "replay" | "live"): AppConfig {
  return llm === "live"
    ? createLiveFixtureConfig(meta, dataDir)
    : createFixtureConfig(meta, dataDir);
}

function observedFetch(
  inner: FetchLike,
  observer: ((request: FixtureDataRequest) => void) | undefined,
): FetchLike {
  if (observer === undefined) {
    return inner;
  }
  return async (input, init) => {
    if (typeof input === "string") {
      observer({ method: (init?.method ?? "GET").toUpperCase(), url: input });
      return inner(input, init);
    }
    const { url } = input instanceof URL ? { url: input.href } : input;
    observer({
      method: (init?.method ?? "GET").toUpperCase(),
      url,
    });
    return inner(input, init);
  };
}

export async function runFixture(
  name: string,
  options?: RunFixtureOptions,
): Promise<RunFixtureResult> {
  const resolvedOptions = options ?? { llm: "replay" };
  const fixture = await loadFixture(name);
  const { dataDir: requestedDataDir } = resolvedOptions;
  const { dataDir, tempRoot } = await fixtureDataDir(fixture.name, requestedDataDir);
  const config = {
    ...fixtureConfig(fixture.meta, dataDir, resolvedOptions.llm),
    captureReplay: resolvedOptions.capture === true,
  };
  const httpMisses: string[] = [];
  const modelMisses: string[] = [];
  const fetchImpl = observedFetch(
    countCassetteMisses(
      resolvedOptions.fetchImpl ?? makeReplayFetch(fixture.dataCassette, fixture.dir),
      httpMisses,
    ),
    resolvedOptions.onDataRequest,
  );
  const baseProvider =
    resolvedOptions.provider ??
    (resolvedOptions.llm === "replay"
      ? makeReplayProvider(fixture.llmCassette)
      : createProvider(config));
  const provider: ModelProvider = {
    ...baseProvider,
    generate: async (request) => {
      assertReplayStateComplete();
      if (httpMisses.length > 0) {
        throw new Error(`Refusing model call after HTTP replay failure: ${httpMisses[0]}`);
      }
      try {
        return await baseProvider.generate(request);
      } catch (error) {
        if (error instanceof ModelReplayError) {
          modelMisses.push(error.message);
        }
        throw error;
      }
    },
  };
  const rawCommand = fixture.meta.command ?? researchCommand(fixture.meta.argv);
  const resolvedSubject = resolveResearchSubject(rawCommand);
  const command = commandWithResolvedResearchSubject(rawCommand, resolvedSubject);
  const now = new Date(fixture.meta.now);
  const sourcePlan = buildSourcePlan(command, now.toISOString(), resolvedSubject);
  const failures: string[] = [];
  const retryDelaysMs =
    fixture.meta.retryDelaysMs ?? (fixture.state === undefined ? [] : undefined);
  const run = () =>
    withRunCapture(
      {
        command,
        config,
        provider,
        now,
        fetchImpl,
        ...(retryDelaysMs === undefined ? {} : { retryDelaysMs }),
      },
      async (runtime) => {
        const collectedSources = await collectSources(command, config.sourceOptions, {
          now,
          fetchImpl: runtime.fetchImpl,
          ...(retryDelaysMs === undefined ? {} : { retryDelaysMs }),
          ...(fixture.state !== undefined &&
          command.jobType === "equity" &&
          command.depth === "deep"
            ? {
                collectTradierTermStructure:
                  config.sourceOptions.tradierApiToken !== undefined &&
                  config.evidenceRequestOptions.maxRounds > 0 &&
                  config.evidenceRequestOptions.maxToolCalls > 0 &&
                  config.evidenceRequestOptions.sourceBudget > 0,
              }
            : {}),
          ...(resolvedSubject !== undefined ? { resolvedSubject } : {}),
          peerUniverse: {
            provider: runtime.provider,
            model: config.quickModel,
            cachePath:
              config.sourceOptions.peerUniverseLearnedPath ??
              join(dataDir, "..", "peer-universe.json"),
          },
        });
        const result = await persistResearchJob({
          command,
          config,
          provider: runtime.provider,
          collectedSources,
          sourcePlan,
          ...runtime.codeState,
          now,
          endClock: () => now,
          sourceFetchImpl: runtime.fetchImpl,
          ...(retryDelaysMs === undefined ? {} : { sourceRetryDelaysMs: retryDelaysMs }),
        });
        return result;
      },
    );
  const result = await withReplaySession(
    {
      mode: fixture.state === undefined ? "offline" : "replay",
      state: fixture.state ?? { values: {} },
      indexes: new Map(),
      failures,
      offline: resolvedOptions.pacing !== true,
    },
    run,
  );
  if (httpMisses.length > 0 || modelMisses.length > 0 || failures.length > 0) {
    throw new Error(
      `Fixture replay incomplete: ${[...httpMisses, ...modelMisses, ...failures].join("; ")}`,
    );
  }
  return {
    ...result,
    dataDir,
    cleanup: async () => {
      if (resolvedOptions.keepDataDir !== true && tempRoot !== undefined) {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  };
}

// Every fixture `bun run check` replays through the real equity pipeline.
export const EQUITY_RUN_FIXTURES = [
  "equity-aapl-brief",
  "equity-aapl-deep",
  "equity-earnings-release-deep",
  "equity-nbis-deep",
  "equity-fpi-quarterly",
  "equity-fpi-ifrs-semiannual",
  "equity-analysis-comprehensive",
  "equity-analysis-estimated-suppressed",
  "equity-web-fallback-deep",
  "equity-depository-deep",
] as const;
