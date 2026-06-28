import type { PredictionKind } from "../../domain/types";
import type { ModelParams } from "../../model/types";

export type RunKey =
  | "market-overview-equity"
  | "market-overview-crypto"
  | "research-equity"
  | "equity"
  | "crypto";

export interface ForecastKindMix {
  readonly favored: readonly PredictionKind[];
  readonly minNonDirection?: number;
}

export interface RunBaseParams {
  readonly quickModel?: string;
  readonly synthesisModel?: string;
  readonly modelParams?: ModelParams;
  readonly minimumKeyFindings?: number;
  readonly minimumScenarios?: number;
  readonly targetPredictions?: number;
  readonly defaultPredictionHorizon?: number;
  readonly predictionSubjects?: readonly string[];
  readonly focus?: readonly string[];
  readonly analystStyle?: "concise brief" | "fuller analyst-style";
  readonly targetKindMix?: ForecastKindMix;
}

export interface RunParams extends RunBaseParams {
  readonly deep?: Partial<RunBaseParams>;
}

export type RunConfig = Record<RunKey, RunParams>;

export interface ResolvedRunParams {
  readonly quickModel: string;
  readonly synthesisModel: string;
  readonly modelParams: ModelParams | undefined;
  readonly minimumKeyFindings: number;
  readonly minimumScenarios: number;
  readonly targetPredictions: number;
  readonly defaultPredictionHorizon: number;
  readonly predictionSubjects: readonly string[];
  readonly focus: readonly string[];
  readonly analystStyle: "concise brief" | "fuller analyst-style";
  readonly targetKindMix: ForecastKindMix;
}
