import { collectSources } from "../sources/collector";
import { buildSourcePlan } from "../research/source-plan";
import { persistResearchJob } from "../research/orchestrator";
import type { DeepEquityRunDependencies, DeepEquityRunInput, DeepEquityRunResult } from "./types";

export async function runDeepEquity(
  input: DeepEquityRunInput,
  dependencies: DeepEquityRunDependencies,
): Promise<DeepEquityRunResult> {
  if (
    input.command.jobType !== "equity" ||
    input.command.assetClass !== "equity" ||
    input.command.depth !== "deep"
  ) {
    throw new Error("runDeepEquity requires an equity <symbol> --deep command");
  }
  const now = input.now ?? new Date();
  const sourcePlan = buildSourcePlan(input.command, now.toISOString());
  const collect = dependencies.collectSources ?? collectSources;
  const termStructureConfigured =
    input.config.sourceOptions.tradierApiToken !== undefined &&
    input.config.evidenceRequestOptions.maxRounds > 0 &&
    input.config.evidenceRequestOptions.maxToolCalls > 0 &&
    input.config.evidenceRequestOptions.sourceBudget > 0;
  const collectedSources = await collect(input.command, input.config.sourceOptions, {
    now,
    ...(dependencies.fetchImpl !== undefined ? { fetchImpl: dependencies.fetchImpl } : {}),
    ...(dependencies.retryDelaysMs !== undefined
      ? { retryDelaysMs: dependencies.retryDelaysMs }
      : {}),
    collectTradierTermStructure: termStructureConfigured,
    peerUniverse: {
      provider: dependencies.provider,
      model: input.config.quickModel,
      cachePath:
        input.config.sourceOptions.peerUniverseLearnedPath ??
        `${input.config.dataDir.replace(/[\\/]runs$/u, "")}/peer-universe-learned.json`,
      ...(input.config.sourceOptions.peerUniverseTtlDays !== undefined
        ? { ttlDays: input.config.sourceOptions.peerUniverseTtlDays }
        : {}),
    },
  });
  const persist = dependencies.persistResearchJob ?? persistResearchJob;
  const result = await persist({
    command: input.command,
    config: input.config,
    provider: dependencies.provider,
    collectedSources,
    sourcePlan,
    now,
    ...(input.endClock !== undefined ? { endClock: input.endClock } : {}),
    ...(dependencies.fetchImpl !== undefined ? { sourceFetchImpl: dependencies.fetchImpl } : {}),
    ...(dependencies.retryDelaysMs !== undefined
      ? { sourceRetryDelaysMs: dependencies.retryDelaysMs }
      : {}),
  });
  if (result.deepEquityEvidenceBundle === undefined || result.deepEquityModelPacket === undefined) {
    throw new Error("Deep-equity evidence bundle finalization failed");
  }
  return {
    report: result.report,
    markdown: result.markdown,
    trace: result.trace,
    analytics: result.analytics,
    stageOutputs: result.stageOutputs,
    evidenceBundle: result.deepEquityEvidenceBundle,
    modelPacket: result.deepEquityModelPacket,
    artifacts: result.artifacts,
  };
}

export type {
  DeepEquityEvidenceBundleV1,
  DeepEquityModelPacket,
  DeepEquityRunDependencies,
  DeepEquityRunInput,
  DeepEquityRunResult,
} from "./types";
export type { SecTargetPacket } from "../sources/sec-target-packet";
export type { TradierPacket } from "../sources/tradier-packet";
export type { PeerPacket } from "../sources/extended-evidence/valuation-comps";
