import type { AppConfig } from "../config";
import { resolveRunParams, type ResolvedRunParams } from "../config/runs";
import type { ResearchCommand } from "../cli/args";
import type { DepthProfile } from "./research-context-types";

export function buildDepthProfileFromParams(
  command: ResearchCommand,
  params: ResolvedRunParams,
): DepthProfile {
  return {
    depth: command.depth,
    analystStyle: params.analystStyle,
    minimumKeyFindings: params.minimumKeyFindings,
    minimumScenarios: params.minimumScenarios,
    targetPredictions: params.targetPredictions,
    defaultPredictionHorizon: params.defaultPredictionHorizon,
    predictionSubjects: params.predictionSubjects,
    focus: params.focus,
    targetKindMix: params.targetKindMix,
  };
}

export function buildDepthProfile(command: ResearchCommand, appConfig: AppConfig): DepthProfile {
  return buildDepthProfileFromParams(command, resolveRunParams(command, appConfig));
}

// Config-driven mover cap for the command's asset class. Shared so the orchestrator's
// Market-update mover set matches the ranked movers handed to the model.
export function moverLimitFor(command: ResearchCommand, config: AppConfig): number {
  return command.assetClass === "equity"
    ? config.sourceOptions.equityMoverLimit
    : config.sourceOptions.cryptoMoverLimit;
}
