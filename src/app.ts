import { basename } from "node:path";
import { parseArgs } from "./cli/args";
import { resolveConfig, type AppConfig, type SourceOptions } from "./config";
import { runAlphaSearchWorkflow } from "./alpha-search/workflow";
import { createAnthropicProvider } from "./model/anthropic";
import { createCodexProvider } from "./model/codex";
import { createOpenAIProvider } from "./model/openai";
import type { ModelProvider } from "./model/types";
import { writeProviderHealthSummary } from "./health/provider-health";
import { persistResearchJob } from "./research/orchestrator";
import { collectSources } from "./sources/collector";
import { pruneCache } from "./sources/cache";
import { buildAndWriteCalibration, runScorePass, type ScorePassOptions } from "./scoring/index";
import { renderCalibrationConsole } from "./scoring/calibration-console";
import {
  buildThesisDelta,
  rebuildHistoryArtifacts,
  renderSearchResults,
  renderThesisDelta,
  searchHistoryIndex,
} from "./history/artifacts";
import { rebuildRunArtifactIndex, writeThroughRunArtifactIndex } from "./run-artifact-index";
import { rebuildRunArtifactIndexIfStale } from "./run-artifact-index-repair";

export interface RunCliDependencies {
  readonly createProvider?: (config: AppConfig) => ModelProvider;
  readonly runAlphaSearchWorkflow?: typeof runAlphaSearchWorkflow;
  readonly collectSources?: typeof collectSources;
  readonly persistResearchJob?: typeof persistResearchJob;
  readonly runScorePass?: typeof runScorePass;
  readonly buildAndWriteCalibration?: typeof buildAndWriteCalibration;
  readonly rebuildHistoryArtifacts?: typeof rebuildHistoryArtifacts;
  readonly rebuildRunArtifactIndex?: typeof rebuildRunArtifactIndex;
  readonly writeThroughRunArtifactIndex?: typeof writeThroughRunArtifactIndex;
  readonly rebuildRunArtifactIndexIfStale?: typeof rebuildRunArtifactIndexIfStale;
  readonly searchHistoryIndex?: typeof searchHistoryIndex;
  readonly buildThesisDelta?: typeof buildThesisDelta;
  readonly now?: () => Date;
}

export function scorePassOptions(sourceOptions: SourceOptions): ScorePassOptions {
  const providerOptions = {
    ...(sourceOptions.fredApiKey !== undefined ? { fredApiKey: sourceOptions.fredApiKey } : {}),
    ...(sourceOptions.tradierApiToken !== undefined
      ? { tradierApiToken: sourceOptions.tradierApiToken }
      : {}),
    ...(sourceOptions.massiveApiKey !== undefined
      ? { massiveApiKey: sourceOptions.massiveApiKey }
      : {}),
  };

  if (sourceOptions.cacheDisabled === true || sourceOptions.cacheDir === undefined) {
    return providerOptions;
  }

  return { closeCacheDir: sourceOptions.cacheDir, ...providerOptions };
}

function createProvider(config: AppConfig): ModelProvider {
  if (config.provider === "codex") {
    return createCodexProvider(config);
  }

  if (config.provider === "anthropic") {
    return createAnthropicProvider(config);
  }

  return createOpenAIProvider(config);
}

async function updateRunArtifactIndex(
  dataDir: string,
  runDirNames: readonly string[],
  dependencies: Pick<
    RunCliDependencies,
    "writeThroughRunArtifactIndex" | "rebuildRunArtifactIndexIfStale"
  >,
  dbPath: string | undefined,
): Promise<void> {
  const normalizedRunDirs = [
    ...new Set(runDirNames.map((runDir) => basename(runDir)).filter((name) => name !== "")),
  ];
  await (dependencies.writeThroughRunArtifactIndex ?? writeThroughRunArtifactIndex)(
    dataDir,
    normalizedRunDirs,
    dbPath === undefined ? {} : { dbPath },
  ).catch((error: unknown) => {
    process.stderr.write(
      `Run artifact index update failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
  await (dependencies.rebuildRunArtifactIndexIfStale ?? rebuildRunArtifactIndexIfStale)(
    dataDir,
    dbPath === undefined ? {} : { dbPath },
  ).catch((error: unknown) => {
    process.stderr.write(
      `Run artifact index stale-rebuild failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
}

export async function runCli(
  argv: readonly string[],
  dependencies: RunCliDependencies = {},
): Promise<string> {
  const command = parseArgs(argv);
  const config = resolveConfig(process.env, {
    validateAlphaSearchOptions: command.jobType === "alpha-search",
  });
  const now = dependencies.now ?? (() => new Date());
  const runScore = dependencies.runScorePass ?? runScorePass;
  const writeCalibration = dependencies.buildAndWriteCalibration ?? buildAndWriteCalibration;

  if (command.jobType === "score") {
    const result = await runScore(config.dataDir, now(), scorePassOptions(config.sourceOptions));
    await writeCalibration(config.dataDir);
    await updateRunArtifactIndex(
      config.dataDir,
      result.touchedRunDirs,
      dependencies,
      config.indexOptions?.dbPath,
    );
    return `Score pass complete: ${String(result.scored)} run(s) scored, ${String(result.skipped)} skipped`;
  }

  if (command.jobType === "calibration") {
    const summary = await writeCalibration(config.dataDir);
    return summary !== null
      ? renderCalibrationConsole(summary)
      : "Calibration summary not written: no resolved predictions found";
  }

  if (command.jobType === "cache-prune") {
    const result = await pruneCache({
      dir: config.sourceOptions.cacheDir ?? "data/cache",
      now: new Date(),
      rawRetentionDays: 30,
      closeRetentionDays: 365,
    });
    return `Cache prune complete: ${String(result.rawDaysPruned)} raw day(s), ${String(result.closeFilesPruned)} close file(s) pruned`;
  }

  if (command.jobType === "provider-health") {
    const result = await writeProviderHealthSummary(config.dataDir);
    return `Provider health written to ${result.markdownPath}`;
  }

  if (command.jobType === "history-rebuild") {
    const result = await (dependencies.rebuildHistoryArtifacts ?? rebuildHistoryArtifacts)(
      config.dataDir,
      now(),
    );
    return `History rebuilt: ${String(result.sourceRunCount)} run(s), ${String(
      result.instrumentCount,
    )} instrument timeline(s), ${String(result.malformedRunCount)} malformed`;
  }

  if (command.jobType === "index-rebuild") {
    const result = await (dependencies.rebuildRunArtifactIndex ?? rebuildRunArtifactIndex)(
      config.dataDir,
      config.indexOptions?.dbPath === undefined ? {} : { dbPath: config.indexOptions.dbPath },
    );
    return `Index rebuilt: ${String(result.sourceRunCount)} run(s), ${String(
      result.malformedRunCount,
    )} malformed, ${String(result.artifactFileCount)} file(s), ${String(
      result.searchEntryCount,
    )} search entries`;
  }

  if (command.jobType === "history-search") {
    const results = await (dependencies.searchHistoryIndex ?? searchHistoryIndex)(config.dataDir, {
      query: command.query,
      ...(command.symbol !== undefined ? { symbol: command.symbol } : {}),
      ...(command.assetClass !== undefined ? { assetClass: command.assetClass } : {}),
      ...(command.sourceJobType !== undefined ? { jobType: command.sourceJobType } : {}),
      ...(command.from !== undefined ? { from: command.from } : {}),
      ...(command.to !== undefined ? { to: command.to } : {}),
      ...(command.section !== undefined ? { section: command.section } : {}),
      ...(command.provider !== undefined ? { provider: command.provider } : {}),
      ...(command.limit !== undefined ? { limit: command.limit } : {}),
    });
    return renderSearchResults(results);
  }

  if (command.jobType === "history-thesis-delta") {
    const provider = command.narrative
      ? (dependencies.createProvider ?? createProvider)(config)
      : undefined;
    const delta = await (dependencies.buildThesisDelta ?? buildThesisDelta)({
      dataDir: config.dataDir,
      symbol: command.symbol,
      assetClass: command.assetClass,
      ...(command.since !== undefined ? { since: command.since } : {}),
      ...(command.to !== undefined ? { to: command.to } : {}),
      narrative: command.narrative,
      ...(provider !== undefined ? { provider, model: config.synthesisModel } : {}),
      now: now(),
    });
    return renderThesisDelta(delta);
  }

  if (command.jobType === "alpha-search") {
    const result = await (dependencies.runAlphaSearchWorkflow ?? runAlphaSearchWorkflow)({
      command,
      config,
    });
    await updateRunArtifactIndex(
      config.dataDir,
      [result.artifacts.runDir],
      dependencies,
      config.indexOptions?.dbPath,
    );
    return result.artifacts.runDir;
  }

  const provider = (dependencies.createProvider ?? createProvider)(config);
  const collectedSources = await (dependencies.collectSources ?? collectSources)(
    command,
    config.sourceOptions,
  );

  const invokedAt = now();
  const result = await (dependencies.persistResearchJob ?? persistResearchJob)({
    command,
    config,
    provider,
    collectedSources,
    now: invokedAt,
  });

  const scoreResult = await runScore(
    config.dataDir,
    invokedAt,
    scorePassOptions(config.sourceOptions),
  ).catch((error: unknown) => {
    process.stderr.write(
      `Score pass failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
  if (scoreResult !== undefined) {
    await writeCalibration(config.dataDir).catch((error: unknown) => {
      process.stderr.write(
        `Calibration build failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }
  await updateRunArtifactIndex(
    config.dataDir,
    [result.artifacts.runDir, ...(scoreResult?.touchedRunDirs ?? [])],
    dependencies,
    config.indexOptions?.dbPath,
  );

  return result.artifacts.runDir;
}
