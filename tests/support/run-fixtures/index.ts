import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, type ResearchCommand } from "../../../src/cli/args";
import { resolveConfig, type AppConfig } from "../../../src/config";
import { createProvider } from "../../../src/model/factory";
import type { ModelProvider } from "../../../src/model/types";
import { collectSources } from "../../../src/sources/collector";
import {
  persistResearchJob,
  type PersistedResearchJobResult,
} from "../../../src/research/orchestrator";
import {
  commandWithResolvedResearchSubject,
  resolveResearchSubject,
} from "../../../src/research/research-subject-identity";
import { buildSourcePlan } from "../../../src/research/source-plan";
import { makeReplayFetch, type DataCassette } from "./data-cassette";
import { makeReplayProvider, type LlmCassette } from "./llm-cassette";

export interface FixtureMeta {
  readonly now: string;
  readonly argv: readonly string[];
  readonly quickModel?: string;
  readonly synthesisModel?: string;
  readonly challengerModels?: readonly string[];
  readonly configuredProviders?: readonly ("finnhub" | "tradier")[];
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

export interface LoadedFixture {
  readonly name: string;
  readonly dir: string;
  readonly dataCassette: DataCassette;
  readonly llmCassette: LlmCassette;
  readonly meta: FixtureMeta;
}

export interface RunFixtureOptions {
  readonly llm: "replay" | "live";
  readonly keepDataDir?: boolean;
  readonly dataDir?: string;
  readonly provider?: ModelProvider;
}

export interface RunFixtureResult extends PersistedResearchJobResult {
  readonly dataDir: string;
  readonly cleanup: () => Promise<void>;
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

export async function loadFixture(name: string): Promise<LoadedFixture> {
  const dir = join(FIXTURE_ROOT, name);
  return {
    name,
    dir,
    dataCassette: await readJson<DataCassette>(join(dir, "data-cassette.json")),
    llmCassette: await readJson<LlmCassette>(join(dir, "llm-cassette.json")),
    meta: await readJson<FixtureMeta>(join(dir, "meta.json")),
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
  return {
    ...config,
    sourceOptions: {
      ...sourceOptions,
      ...(configuredProviders.has("finnhub") ? { finnhubApiToken: "fixture-token" } : {}),
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

export async function runFixture(
  name: string,
  options?: RunFixtureOptions,
): Promise<RunFixtureResult> {
  const resolvedOptions = options ?? { llm: "replay" };
  const fixture = await loadFixture(name);
  const { dataDir: requestedDataDir } = resolvedOptions;
  const { dataDir, tempRoot } = await fixtureDataDir(name, requestedDataDir);
  const config = createFixtureConfig(fixture.meta, dataDir);
  const fetchImpl = makeReplayFetch(fixture.dataCassette, fixture.dir);
  const provider =
    resolvedOptions.provider ??
    (resolvedOptions.llm === "replay"
      ? makeReplayProvider(fixture.llmCassette)
      : createProvider(config));
  const rawCommand = researchCommand(fixture.meta.argv);
  const resolvedSubject = resolveResearchSubject(rawCommand);
  const command = commandWithResolvedResearchSubject(rawCommand, resolvedSubject);
  const now = new Date(fixture.meta.now);
  const sourcePlan = buildSourcePlan(command, now.toISOString(), resolvedSubject);
  const collectedSources = await collectSources(command, config.sourceOptions, {
    now,
    fetchImpl,
    retryDelaysMs: [],
    ...(resolvedSubject !== undefined ? { resolvedSubject } : {}),
    peerUniverse: {
      provider,
      model: config.quickModel,
      cachePath:
        config.sourceOptions.peerUniverseLearnedPath ?? join(dataDir, "..", "peer-universe.json"),
    },
  });
  const result = await persistResearchJob({
    command,
    config,
    provider,
    collectedSources,
    sourcePlan,
    now,
    endClock: () => now,
    sourceFetchImpl: fetchImpl,
    sourceRetryDelaysMs: [],
  });
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
