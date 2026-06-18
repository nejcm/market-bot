import type { AppConfig } from "../config";
import type { ResearchCommand } from "../cli/args";
import { legacyMarketUpdateHorizon, type PredictionKind } from "../domain/types";
import type { ModelParams } from "../model/types";
import { cleanResearchProxySymbol } from "../research/research-subject-identity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunKey =
  | "market-overview-equity"
  | "market-overview-crypto"
  | "research-equity"
  | "ticker";

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
// | Run key                      | Favored (priority order)    | minNonDirection (brief → deep) |
// |------------------------------|-----------------------------|--------------------------------|
// | market-overview-equity | relative, macro, volatility | 1 → 2 |
// | market-overview-crypto | relative, range             | 1 → 2 (macro/iv are equity-only — see src/scoring/observations.ts) |
// | ticker                       | relative, range             | 1 → 2 |
//
// The `deep` override raises every floor to 2; brief profiles use 1.
//
// `direction` at short horizons sits near a 50% base rate.
//
// Other kinds carry more research edge: relative, macro, range, volatility.
//
// This mix is prompt guidance for final-synthesis, not a validation gate.
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

const RESEARCH_KIND_MIX: ForecastKindMix = {
  favored: ["range"],
};

const CODE_DEFAULTS: Omit<ResolvedRunParams, "quickModel" | "synthesisModel" | "modelParams"> = {
  minimumKeyFindings: 3,
  minimumScenarios: 1,
  targetPredictions: 2,
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
  "market-overview-equity": {
    minimumKeyFindings: 3,
    minimumScenarios: 1,
    targetPredictions: 2,
    defaultPredictionHorizon: 15,
    predictionSubjects: EQUITY_MARKET_UPDATE_PREDICTION_SUBJECTS,
    analystStyle: "concise brief",
    focus: ["market regime", "movers", "narratives", "catalysts", "risks", "source gaps"],
    targetKindMix: EQUITY_MARKET_UPDATE_KIND_MIX,
    deep: {
      minimumKeyFindings: 5,
      minimumScenarios: 3,
      targetPredictions: 3,
      analystStyle: "fuller analyst-style",
      focus: [
        "market regime",
        "movers",
        "cross-asset themes",
        "narratives",
        "catalysts",
        "risks",
        "source gaps",
      ],
      targetKindMix: { ...EQUITY_MARKET_UPDATE_KIND_MIX, minNonDirection: 2 },
    },
  },
  "market-overview-crypto": {
    minimumKeyFindings: 3,
    minimumScenarios: 1,
    targetPredictions: 2,
    defaultPredictionHorizon: 15,
    predictionSubjects: CRYPTO_MARKET_UPDATE_PREDICTION_SUBJECTS,
    analystStyle: "concise brief",
    focus: ["market regime", "movers", "narratives", "catalysts", "risks", "source gaps"],
    targetKindMix: CRYPTO_MARKET_UPDATE_KIND_MIX,
    deep: {
      minimumKeyFindings: 5,
      minimumScenarios: 3,
      targetPredictions: 3,
      analystStyle: "fuller analyst-style",
      focus: [
        "market regime",
        "movers",
        "cross-asset themes",
        "narratives",
        "catalysts",
        "risks",
        "source gaps",
      ],
      targetKindMix: { ...CRYPTO_MARKET_UPDATE_KIND_MIX, minNonDirection: 2 },
    },
  },
  ticker: {
    minimumKeyFindings: 4,
    minimumScenarios: 1,
    targetPredictions: 3,
    defaultPredictionHorizon: 5,
    analystStyle: "concise brief",
    focus: ["thesis", "evidence", "risks", "data gaps"],
    targetKindMix: TICKER_KIND_MIX,
    deep: {
      minimumKeyFindings: 6,
      minimumScenarios: 3,
      targetPredictions: 5,
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
  "research-equity": {
    minimumKeyFindings: 3,
    minimumScenarios: 1,
    targetPredictions: 2,
    defaultPredictionHorizon: 15,
    predictionSubjects: [],
    analystStyle: "concise brief",
    focus: [
      "subject evidence",
      "proxy evidence",
      "representative instruments",
      "risks",
      "data gaps",
    ],
    targetKindMix: RESEARCH_KIND_MIX,
    deep: {
      minimumKeyFindings: 5,
      minimumScenarios: 3,
      targetPredictions: 3,
      analystStyle: "fuller analyst-style",
      focus: [
        "subject evidence",
        "proxy evidence",
        "representative instruments",
        "catalysts",
        "scenarios",
        "risks",
        "data gaps",
      ],
      targetKindMix: { ...RESEARCH_KIND_MIX, minNonDirection: 2 },
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
  if (command.jobType === "ticker") {
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
