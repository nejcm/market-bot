import { basename } from "node:path";
import { isResearchCommand, parseArgs, type ResearchCommand } from "./cli/args";
import { resolveConfig, type AppConfig, type SourceOptions } from "./config";
import { runAlphaSearchWorkflow } from "./alpha-search/workflow";
import { renderAlphaSearchAnalyticsConsole } from "./alpha-search/run-analytics-console";
import { createProvider } from "./model/factory";
import type { ModelProvider } from "./model/types";
import { writeProviderHealthSummary } from "./health/provider-health";
import { persistResearchJob } from "./research/orchestrator";
import { buildSourcePlan } from "./research/source-plan";
import { renderRunAnalyticsConsole } from "./research/run-analytics-console";
import {
  commandWithResolvedResearchSubject,
  resolveResearchSubject,
  type ResolvedResearchSubject,
} from "./research/research-subject-identity";
import { collectSources } from "./sources/collector";
import { pruneCache } from "./sources/cache";
import { buildAndWriteCalibration, runScorePass, type ScorePassOptions } from "./scoring/index";
import { renderCalibrationConsole } from "./scoring/calibration-console";
import {
  buildThesisDelta,
  rebuildHistoryArtifacts,
  rebuildHistoryArtifactsIfStale,
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

// Run-quality digest goes to stderr so stdout stays reserved for the run-dir path.
// The run is already persisted by call time, so a cosmetic summary must never abort it.
function emitRunQualitySummary(render: () => string): void {
  try {
    process.stderr.write(`${render()}\n`);
  } catch (error: unknown) {
    process.stderr.write(
      `Run quality summary failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function emitUnresolvedResearchSubjectGuidance(subject: ResolvedResearchSubject | undefined): void {
  if (subject?.status !== "unresolved" || subject.supportedSubjects === undefined) {
    return;
  }
  const supportedSubjects = subject.supportedSubjects
    .map((supportedSubject) => supportedSubject.displayName)
    .join(", ");
  const closestMatch =
    subject.closestMatch === undefined
      ? undefined
      : `${subject.closestMatch.displayName} (${subject.closestMatch.subjectKey})`;
  process.stderr.write(
    `${[
      `Research subject unresolved: "${subject.input}".`,
      `Supported subjects: ${supportedSubjects}.`,
      ...(closestMatch !== undefined ? [`Closest match: ${closestMatch}.`] : []),
    ].join("\n")}\n`,
  );
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
    const result = await runScore(config.dataDir, now(), {
      ...scorePassOptions(config.sourceOptions),
      ...(command.force === true ? { force: true } : {}),
    });
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
    await rebuildHistoryArtifactsIfStale(
      config.dataDir,
      now(),
      dependencies.rebuildHistoryArtifacts ?? rebuildHistoryArtifacts,
    );
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
    await rebuildHistoryArtifactsIfStale(
      config.dataDir,
      now(),
      dependencies.rebuildHistoryArtifacts ?? rebuildHistoryArtifacts,
    );
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
    emitRunQualitySummary(() => renderAlphaSearchAnalyticsConsole(result.analytics));
    return result.artifacts.runDir;
  }

  const provider = (dependencies.createProvider ?? createProvider)(config);
  const rawResearchCommand = asResearchCommand(command);
  const resolvedSubject = resolveResearchSubject(rawResearchCommand);
  emitUnresolvedResearchSubjectGuidance(resolvedSubject);
  const researchCommand = commandWithResolvedResearchSubject(rawResearchCommand, resolvedSubject);
  // Freeze the Source Plan before the first source-provider I/O so it records
  // Pre-collection intent (ADR 0028); collection outcomes cannot change it.
  const sourcePlan = buildSourcePlan(researchCommand, now().toISOString(), resolvedSubject);
  const collectedSources = await (dependencies.collectSources ?? collectSources)(
    researchCommand,
    config.sourceOptions,
    {
      ...(resolvedSubject !== undefined ? { resolvedSubject } : {}),
      peerUniverse: {
        provider,
        model: config.quickModel,
        cachePath:
          config.sourceOptions.peerUniverseLearnedPath ??
          `${config.dataDir.replace(/[\\/]runs$/u, "")}/peer-universe-learned.json`,
        ...(config.sourceOptions.peerUniverseTtlDays !== undefined
          ? { ttlDays: config.sourceOptions.peerUniverseTtlDays }
          : {}),
      },
    },
  );

  const invokedAt = now();
  const result = await (dependencies.persistResearchJob ?? persistResearchJob)({
    command: researchCommand,
    config,
    provider,
    collectedSources,
    sourcePlan,
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

  emitRunQualitySummary(() => renderRunAnalyticsConsole(result.analytics));

  return result.artifacts.runDir;
}

function asResearchCommand(command: ReturnType<typeof parseArgs>): ResearchCommand {
  if (isResearchCommand(command)) {
    return command;
  }

  throw new Error(`Unsupported research command: ${command.jobType}`);
}
