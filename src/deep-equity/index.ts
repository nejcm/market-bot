import { withRunCapture } from "../replay/capture";
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
  return withRunCapture(
    {
      command: input.command,
      config: input.config,
      provider: dependencies.provider,
      now,
      ...(dependencies.fetchImpl === undefined ? {} : { fetchImpl: dependencies.fetchImpl }),
      ...(dependencies.retryDelaysMs === undefined
        ? {}
        : { retryDelaysMs: dependencies.retryDelaysMs }),
    },
    async (runtime) => {
      const capturedDependencies = { ...dependencies, ...runtime };

      const sourcePlan = buildSourcePlan(input.command, now.toISOString());
      const collect = capturedDependencies.collectSources ?? collectSources;
      const termStructureConfigured =
        input.config.sourceOptions.tradierApiToken !== undefined &&
        input.config.evidenceRequestOptions.maxRounds > 0 &&
        input.config.evidenceRequestOptions.maxToolCalls > 0 &&
        input.config.evidenceRequestOptions.sourceBudget > 0;
      const collectedSources = await collect(input.command, input.config.sourceOptions, {
        now,
        ...(capturedDependencies.fetchImpl !== undefined
          ? { fetchImpl: capturedDependencies.fetchImpl }
          : {}),
        ...(capturedDependencies.retryDelaysMs !== undefined
          ? { retryDelaysMs: capturedDependencies.retryDelaysMs }
          : {}),
        collectTradierTermStructure: termStructureConfigured,
        peerUniverse: {
          provider: capturedDependencies.provider,
          model: input.config.quickModel,
          cachePath:
            input.config.sourceOptions.peerUniverseLearnedPath ??
            `${input.config.dataDir.replace(/[\\/]runs$/u, "")}/peer-universe-learned.json`,
          ...(input.config.sourceOptions.peerUniverseTtlDays !== undefined
            ? { ttlDays: input.config.sourceOptions.peerUniverseTtlDays }
            : {}),
        },
      });
      const persist = capturedDependencies.persistResearchJob ?? persistResearchJob;
      const result = await persist({
        command: input.command,
        config: input.config,
        provider: capturedDependencies.provider,
        collectedSources,
        sourcePlan,
        ...runtime.codeState,
        now,
        ...(input.endClock !== undefined ? { endClock: input.endClock } : {}),
        ...(capturedDependencies.fetchImpl !== undefined
          ? { sourceFetchImpl: capturedDependencies.fetchImpl }
          : {}),
        ...(capturedDependencies.retryDelaysMs !== undefined
          ? { sourceRetryDelaysMs: capturedDependencies.retryDelaysMs }
          : {}),
      });
      if (result.deepEquityEvidenceBundle === undefined) {
        throw new Error("Deep-equity evidence bundle finalization failed");
      }
      return {
        report: result.report,
        markdown: result.markdown,
        trace: result.trace,
        analytics: result.analytics,
        stageOutputs: result.stageOutputs,
        evidenceBundle: result.deepEquityEvidenceBundle,
        artifacts: result.artifacts,
      };
    },
  );
}

export type { DeepEquityRunDependencies, DeepEquityRunInput, DeepEquityRunResult } from "./types";
