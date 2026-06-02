import { parseArgs } from "./cli/args";
import { resolveConfig, type AppConfig, type SourceOptions } from "./config";
import { createAnthropicProvider } from "./model/anthropic";
import { createCodexProvider } from "./model/codex";
import { createOpenAIProvider } from "./model/openai";
import type { ModelProvider } from "./model/types";
import { writeProviderHealthSummary } from "./health/provider-health";
import { persistResearchJob } from "./research/orchestrator";
import { collectSources } from "./sources/collector";
import { pruneCache } from "./sources/cache";
import { buildAndWriteCalibration, runScorePass, type ScorePassOptions } from "./scoring/index";

export function scorePassOptions(sourceOptions: SourceOptions): ScorePassOptions {
  const providerOptions = {
    ...(sourceOptions.fredApiKey !== undefined ? { fredApiKey: sourceOptions.fredApiKey } : {}),
    ...(sourceOptions.tradierApiToken !== undefined
      ? { tradierApiToken: sourceOptions.tradierApiToken }
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

export async function runCli(argv: readonly string[]): Promise<string> {
  const command = parseArgs(argv);
  const config = resolveConfig(process.env, {
    validateAlphaSearchOptions: command.jobType === "alpha-search",
  });

  if (command.jobType === "score") {
    const result = await runScorePass(
      config.dataDir,
      new Date(),
      scorePassOptions(config.sourceOptions),
    );
    await buildAndWriteCalibration(config.dataDir);
    return `Score pass complete: ${String(result.scored)} run(s) scored, ${String(result.skipped)} skipped`;
  }

  if (command.jobType === "calibration") {
    const written = await buildAndWriteCalibration(config.dataDir);
    return written
      ? "Calibration summary written to data/calibration/summary.json"
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

  if (command.jobType === "alpha-search") {
    return "Alpha search phase 1 ready: Reddit discovery implementation is pending";
  }

  const provider = createProvider(config);
  const collectedSources = await collectSources(command, config.sourceOptions);

  const scoreResult = await runScorePass(
    config.dataDir,
    new Date(),
    scorePassOptions(config.sourceOptions),
  ).catch((error: unknown) => {
    process.stderr.write(
      `Score pass failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });
  if (scoreResult !== undefined) {
    await buildAndWriteCalibration(config.dataDir).catch((error: unknown) => {
      process.stderr.write(
        `Calibration build failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }

  const result = await persistResearchJob({
    command,
    config,
    provider,
    collectedSources,
  });

  return result.artifacts.runDir;
}
