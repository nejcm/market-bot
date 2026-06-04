import type { AppConfig } from "../config";
import type { ResearchCommand } from "../cli/args";
import type { ModelParams } from "../model/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunKey = "daily-equity" | "daily-crypto" | "weekly-equity" | "weekly-crypto" | "ticker";

export interface RunBaseParams {
  readonly quickModel?: string;
  readonly synthesisModel?: string;
  readonly modelParams?: ModelParams;
  readonly minimumKeyFindings?: number;
  readonly minimumScenarios?: number;
  readonly minimumPredictions?: number;
  readonly defaultPredictionHorizon?: number;
  readonly predictionSubjects?: readonly string[];
  readonly focus?: readonly string[];
  readonly analystStyle?: "concise brief" | "fuller analyst-style";
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
  readonly minimumPredictions: number;
  readonly defaultPredictionHorizon: number;
  readonly predictionSubjects: readonly string[];
  readonly focus: readonly string[];
  readonly analystStyle: "concise brief" | "fuller analyst-style";
}

// ---------------------------------------------------------------------------
// Code defaults — last-resort fallback when nothing else is configured
// ---------------------------------------------------------------------------

const EQUITY_MARKET_UPDATE_PREDICTION_SUBJECTS = [
  "SPY",
  "QQQ",
  "^VIX",
  // FRED series are eligible observable macro forecast subjects for market updates.
  "DGS10",
  "DGS2",
  "T10Y2Y",
  "FEDFUNDS",
  "CPIAUCSL",
  "UNRATE",
  "DTWEXBGS",
] as const;

const CRYPTO_MARKET_UPDATE_PREDICTION_SUBJECTS = ["BTC", "ETH"] as const;

const CODE_DEFAULTS: Omit<ResolvedRunParams, "quickModel" | "synthesisModel" | "modelParams"> = {
  minimumKeyFindings: 3,
  minimumScenarios: 1,
  minimumPredictions: 2,
  defaultPredictionHorizon: 5,
  predictionSubjects: EQUITY_MARKET_UPDATE_PREDICTION_SUBJECTS,
  focus: ["market regime", "movers", "risks", "source gaps"],
  analystStyle: "concise brief",
};

// ---------------------------------------------------------------------------
// Seeded run config — current values extracted from buildDepthProfile
// Behavior is identical to the code-conditional version; this is a pure refactor.
// ---------------------------------------------------------------------------

export const runConfig: RunConfig = {
  "daily-equity": {
    minimumKeyFindings: 3,
    minimumScenarios: 1,
    minimumPredictions: 2,
    defaultPredictionHorizon: 5,
    predictionSubjects: EQUITY_MARKET_UPDATE_PREDICTION_SUBJECTS,
    analystStyle: "concise brief",
    focus: ["market regime", "movers", "risks", "source gaps"],
    deep: {
      minimumKeyFindings: 5,
      minimumScenarios: 3,
      minimumPredictions: 3,
      analystStyle: "fuller analyst-style",
      focus: ["market regime", "movers", "cross-asset themes", "risks", "source gaps"],
    },
  },
  "daily-crypto": {
    minimumKeyFindings: 3,
    minimumScenarios: 1,
    minimumPredictions: 2,
    defaultPredictionHorizon: 5,
    predictionSubjects: CRYPTO_MARKET_UPDATE_PREDICTION_SUBJECTS,
    analystStyle: "concise brief",
    focus: ["market regime", "movers", "risks", "source gaps"],
    deep: {
      minimumKeyFindings: 5,
      minimumScenarios: 3,
      minimumPredictions: 3,
      analystStyle: "fuller analyst-style",
      focus: ["market regime", "movers", "cross-asset themes", "risks", "source gaps"],
    },
  },
  "weekly-equity": {
    minimumKeyFindings: 3,
    minimumScenarios: 1,
    minimumPredictions: 2,
    defaultPredictionHorizon: 15,
    predictionSubjects: EQUITY_MARKET_UPDATE_PREDICTION_SUBJECTS,
    analystStyle: "concise brief",
    focus: ["weekly market regime", "5-session movers", "risks", "source gaps"],
    deep: {
      minimumKeyFindings: 5,
      minimumScenarios: 3,
      minimumPredictions: 3,
      analystStyle: "fuller analyst-style",
      focus: [
        "weekly market regime",
        "5-session movers",
        "cross-asset themes",
        "risks",
        "source gaps",
      ],
    },
  },
  "weekly-crypto": {
    minimumKeyFindings: 3,
    minimumScenarios: 1,
    minimumPredictions: 2,
    defaultPredictionHorizon: 15,
    predictionSubjects: CRYPTO_MARKET_UPDATE_PREDICTION_SUBJECTS,
    analystStyle: "concise brief",
    focus: ["weekly market regime", "5-session movers", "risks", "source gaps"],
    deep: {
      minimumKeyFindings: 5,
      minimumScenarios: 3,
      minimumPredictions: 3,
      analystStyle: "fuller analyst-style",
      focus: [
        "weekly market regime",
        "5-session movers",
        "cross-asset themes",
        "risks",
        "source gaps",
      ],
    },
  },
  ticker: {
    minimumKeyFindings: 4,
    minimumScenarios: 1,
    minimumPredictions: 3,
    defaultPredictionHorizon: 5,
    analystStyle: "concise brief",
    focus: ["thesis", "evidence", "risks", "data gaps"],
    deep: {
      minimumKeyFindings: 6,
      minimumScenarios: 3,
      minimumPredictions: 5,
      analystStyle: "fuller analyst-style",
      focus: [
        "thesis",
        "evidence",
        "catalysts",
        "bull case",
        "bear case",
        "scenarios",
        "data gaps",
      ],
    },
  },
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

function toRunKey(command: ResearchCommand): RunKey {
  if (command.jobType === "ticker") {
    return "ticker";
  }
  return `${command.jobType}-${command.assetClass}` as RunKey;
}

function mergeModelParams(
  base: ModelParams | undefined,
  override: ModelParams | undefined,
): ModelParams | undefined {
  if (base === undefined) {
    return override;
  }

  if (override === undefined) {
    return base;
  }

  return { ...base, ...override };
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

  // Ticker prediction subjects are always derived from the symbol at runtime.
  const predictionSubjects =
    command.jobType === "ticker"
      ? [command.symbol]
      : (merged.predictionSubjects ?? CODE_DEFAULTS.predictionSubjects);
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
    minimumPredictions: merged.minimumPredictions ?? CODE_DEFAULTS.minimumPredictions,
    defaultPredictionHorizon:
      merged.defaultPredictionHorizon ?? CODE_DEFAULTS.defaultPredictionHorizon,
    predictionSubjects,
    focus: merged.focus ?? CODE_DEFAULTS.focus,
    analystStyle: merged.analystStyle ?? CODE_DEFAULTS.analystStyle,
  };
}
