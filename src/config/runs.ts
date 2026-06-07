import type { AppConfig } from "../config";
import type { ResearchCommand } from "../cli/args";
import type { PredictionKind } from "../domain/types";
import type { ModelParams } from "../model/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunKey = "daily-equity" | "daily-crypto" | "weekly-equity" | "weekly-crypto" | "ticker";

/**
 * Audit finding #10 (prediction mix policy / emission policy): per-kind skill
 * *measurement* already exists (`byKind` calibration). This is the missing
 * *emission* half — a per-run-type target mix that steers `final-synthesis`
 * toward more informative kinds (`relative`, `macro`, `range`, `volatility`)
 * and away from leaning on bare `direction`, whose 1-20d base rate is ~50%
 * (see prompts/playbooks/synthesis-discipline.md base-rate guidance).
 *
 * Soft enforcement only: this shapes prompt guidance, not a validation gate.
 */
export interface ForecastKindMix {
  /** Kinds to favor, in priority order, when the evidence supports them. */
  readonly favored: readonly PredictionKind[];
  /** Soft floor: how many of the emitted predictions should avoid bare `direction`. */
  readonly minNonDirection?: number;
}

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
  readonly minimumPredictions: number;
  readonly defaultPredictionHorizon: number;
  readonly predictionSubjects: readonly string[];
  readonly focus: readonly string[];
  readonly analystStyle: "concise brief" | "fuller analyst-style";
  readonly targetKindMix: ForecastKindMix;
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

// ---------------------------------------------------------------------------
// Target forecast-kind mixes (audit finding #10 — emission policy)
//
// | Run key                      | Favored (priority order)         | minNonDirection |
// |------------------------------|----------------------------------|-----------------|
// | daily-equity / weekly-equity | relative, macro, volatility      | minimumPredictions - 1 |
// | daily-crypto / weekly-crypto | relative, range                  | 1 (macro/iv are equity-only — see src/scoring/observations.ts) |
// | ticker                       | relative, range                  | 1               |
//
// `direction` at 1-20d sits near a ~50% base rate and can mask signal from
// Kinds with more research edge and a more informative Brier (relative/pairs,
// Macro, range/volatility bands).
//
// This mix is *guidance* surfaced in the final-synthesis instruction. It is
// Not a hard validation gate.
// ---------------------------------------------------------------------------

const EQUITY_MARKET_UPDATE_KIND_MIX: ForecastKindMix = {
  favored: ["relative", "macro", "volatility"],
  minNonDirection: 1,
};

const CRYPTO_MARKET_UPDATE_KIND_MIX: ForecastKindMix = {
  favored: ["relative", "range"],
  minNonDirection: 1,
};

const TICKER_KIND_MIX: ForecastKindMix = {
  favored: ["relative", "range"],
  minNonDirection: 1,
};

const CODE_DEFAULTS: Omit<ResolvedRunParams, "quickModel" | "synthesisModel" | "modelParams"> = {
  minimumKeyFindings: 3,
  minimumScenarios: 1,
  minimumPredictions: 2,
  defaultPredictionHorizon: 5,
  predictionSubjects: EQUITY_MARKET_UPDATE_PREDICTION_SUBJECTS,
  focus: ["market regime", "movers", "risks", "source gaps"],
  analystStyle: "concise brief",
  targetKindMix: EQUITY_MARKET_UPDATE_KIND_MIX,
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
    targetKindMix: EQUITY_MARKET_UPDATE_KIND_MIX,
    deep: {
      minimumKeyFindings: 5,
      minimumScenarios: 3,
      minimumPredictions: 3,
      analystStyle: "fuller analyst-style",
      focus: ["market regime", "movers", "cross-asset themes", "risks", "source gaps"],
      targetKindMix: { ...EQUITY_MARKET_UPDATE_KIND_MIX, minNonDirection: 2 },
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
    targetKindMix: CRYPTO_MARKET_UPDATE_KIND_MIX,
    deep: {
      minimumKeyFindings: 5,
      minimumScenarios: 3,
      minimumPredictions: 3,
      analystStyle: "fuller analyst-style",
      focus: ["market regime", "movers", "cross-asset themes", "risks", "source gaps"],
      targetKindMix: { ...CRYPTO_MARKET_UPDATE_KIND_MIX, minNonDirection: 2 },
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
    targetKindMix: EQUITY_MARKET_UPDATE_KIND_MIX,
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
      targetKindMix: { ...EQUITY_MARKET_UPDATE_KIND_MIX, minNonDirection: 2 },
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
    targetKindMix: CRYPTO_MARKET_UPDATE_KIND_MIX,
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
      targetKindMix: { ...CRYPTO_MARKET_UPDATE_KIND_MIX, minNonDirection: 2 },
    },
  },
  ticker: {
    minimumKeyFindings: 4,
    minimumScenarios: 1,
    minimumPredictions: 3,
    defaultPredictionHorizon: 5,
    analystStyle: "concise brief",
    focus: ["thesis", "evidence", "risks", "data gaps"],
    targetKindMix: TICKER_KIND_MIX,
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
      targetKindMix: { ...TICKER_KIND_MIX, minNonDirection: 2 },
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
    targetKindMix: merged.targetKindMix ?? CODE_DEFAULTS.targetKindMix,
  };
}
