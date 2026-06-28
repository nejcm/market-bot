import type { AppConfig } from "../../config";
import { isInstrumentCommand, type ResearchCommand } from "../../cli/args";
import { legacyMarketUpdateHorizon } from "../../domain/types";
import { cleanResearchProxySymbol } from "../../research/research-subject-identity";
import { runConfig } from "./profiles";
import type { ResolvedRunParams, RunBaseParams, RunConfig, RunKey } from "./types";
import { CODE_DEFAULTS } from "./profiles/shared";

function toRunKey(command: ResearchCommand): RunKey {
  if (isInstrumentCommand(command)) {
    return command.jobType;
  }
  if (command.jobType === "research") {
    return "research-equity";
  }
  return `market-overview-${command.assetClass}` as RunKey;
}

function researchPredictionProxy(command: ResearchCommand): string | undefined {
  if (command.jobType !== "research") {
    return undefined;
  }
  return cleanResearchProxySymbol(command.predictionProxySymbol);
}

function mergeModelParams(
  base: RunBaseParams["modelParams"],
  override: RunBaseParams["modelParams"],
): RunBaseParams["modelParams"] {
  if (base === undefined) {
    return override;
  }

  if (override === undefined) {
    return base;
  }

  return { ...base, ...override };
}

function defaultPredictionHorizonFor(command: ResearchCommand, merged: RunBaseParams): number {
  if (command.jobType === "market-overview") {
    return command.horizonTradingDays;
  }
  if (command.jobType === "daily" || command.jobType === "weekly") {
    return legacyMarketUpdateHorizon(command.jobType);
  }
  return merged.defaultPredictionHorizon ?? CODE_DEFAULTS.defaultPredictionHorizon;
}

function predictionSubjectsFor(
  command: ResearchCommand,
  merged: RunBaseParams,
  proxy: string | undefined,
): readonly string[] {
  if (isInstrumentCommand(command)) {
    return [command.symbol];
  }
  if (command.jobType === "research") {
    return proxy === undefined ? [] : [proxy];
  }
  return merged.predictionSubjects ?? CODE_DEFAULTS.predictionSubjects;
}

function targetPredictionsFor(
  command: ResearchCommand,
  merged: RunBaseParams,
  proxy: string | undefined,
): number {
  if (command.jobType === "research" && proxy === undefined) {
    return 0;
  }
  return merged.targetPredictions ?? CODE_DEFAULTS.targetPredictions;
}

export function resolveRunParams(
  command: ResearchCommand,
  appConfig: AppConfig,
  config: RunConfig = runConfig,
): ResolvedRunParams {
  const key = toRunKey(command);
  const combo = config[key];
  const deepOverride = command.depth === "deep" ? (combo.deep ?? {}) : {};
  const merged: RunBaseParams = { ...combo, ...deepOverride };

  const proxy = researchPredictionProxy(command);
  const predictionSubjects = predictionSubjectsFor(command, merged, proxy);
  const defaultQuickModel =
    appConfig.provider === "codex"
      ? (appConfig.codexQuickModel ?? appConfig.quickModel)
      : appConfig.quickModel;
  const defaultSynthesisModel =
    appConfig.provider === "codex"
      ? (appConfig.codexSynthesisModel ?? appConfig.synthesisModel)
      : appConfig.synthesisModel;

  return {
    quickModel: merged.quickModel ?? defaultQuickModel,
    synthesisModel: merged.synthesisModel ?? defaultSynthesisModel,
    modelParams: mergeModelParams(appConfig.modelParams, merged.modelParams),
    minimumKeyFindings: merged.minimumKeyFindings ?? CODE_DEFAULTS.minimumKeyFindings,
    minimumScenarios: merged.minimumScenarios ?? CODE_DEFAULTS.minimumScenarios,
    targetPredictions: targetPredictionsFor(command, merged, proxy),
    defaultPredictionHorizon: defaultPredictionHorizonFor(command, merged),
    predictionSubjects,
    focus: merged.focus ?? CODE_DEFAULTS.focus,
    analystStyle: merged.analystStyle ?? CODE_DEFAULTS.analystStyle,
    targetKindMix: merged.targetKindMix ?? CODE_DEFAULTS.targetKindMix,
  };
}
