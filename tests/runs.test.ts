import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { resolveRunParams, runConfig, type RunConfig, type RunKey } from "../src/config/runs";

const baseConfig: AppConfig = {
  provider: "openai",
  quickModel: "env-quick",
  synthesisModel: "env-synthesis",
  modelTimeoutMs: 120_000,
  dataDir: "data/runs",
  promptDir: "prompts",
  sourceOptions: {
    equityMoverLimit: 5,
    cryptoMoverLimit: 5,
    newsLimit: 8,
    sourceTimeoutMs: 1000,
  },
  evidenceRequestOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
  webGatherOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
  webGatherDisabled: false,
  webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
  alphaSearchOptions: {
    apeWisdomFilter: "all-stocks",
    apeWisdomBriefPageLimit: 5,
    apeWisdomDeepPageLimit: 10,
    validationCandidateLimit: 25,
    leadLimit: 15,
    topCandidateLimit: 15,
    secDiscoveryLimit: 25,
    secFormTypes: ["S-1", "F-1", "8-K", "6-K"],
    minPrice: 0.5,
    minVolume: 100_000,
    minMarketCap: 50_000_000,
    maxMarketCap: 10_000_000_000,
  },
};

describe("runConfig profiles", () => {
  test("has exactly the canonical run profile keys", () => {
    const keys = Object.keys(runConfig).toSorted();
    const expected: RunKey[] = [
      "crypto",
      "equity",
      "market-overview-crypto",
      "market-overview-equity",
      "research-equity",
    ];

    expect(keys).toEqual([...expected].toSorted());
  });

  test("keeps equity and crypto instrument profiles behavior-equivalent", () => {
    expect(runConfig.equity).toEqual(runConfig.crypto);
  });
});

describe("resolveRunParams — fallback chain", () => {
  test("env AppConfig provides quickModel and synthesisModel when combo has none", () => {
    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      baseConfig,
    );

    expect(result.quickModel).toBe("env-quick");
    expect(result.synthesisModel).toBe("env-synthesis");
  });

  test("codex AppConfig overrides provide default run models", () => {
    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      {
        ...baseConfig,
        provider: "codex",
        codexQuickModel: "codex-quick",
        codexSynthesisModel: "codex-synthesis",
      },
    );

    expect(result.quickModel).toBe("codex-quick");
    expect(result.synthesisModel).toBe("codex-synthesis");
  });

  test("combo block model overrides AppConfig", () => {
    const modified = {
      ...runConfig["market-overview-equity"],
      quickModel: "combo-quick",
      synthesisModel: "combo-synthesis",
    };
    const origCombo = runConfig["market-overview-equity"];
    const patchedConfig = {
      ...runConfig,
      "market-overview-equity": { ...modified },
    };

    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      baseConfig,
      patchedConfig,
    );
    expect(origCombo.quickModel).toBeUndefined();
    expect(result.quickModel).toBe("combo-quick");
    expect(result.synthesisModel).toBe("combo-synthesis");
  });

  test("brief depth uses combo-level values", () => {
    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      baseConfig,
    );

    expect(result.minimumKeyFindings).toBe(3);
    expect(result.minimumScenarios).toBe(1);
    expect(result.targetPredictions).toBe(2);
    expect(result.analystStyle).toBe("concise brief");
  });

  test("deep depth merges deep sub-block over combo", () => {
    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "deep" },
      baseConfig,
    );

    expect(result.minimumKeyFindings).toBe(5);
    expect(result.minimumScenarios).toBe(3);
    expect(result.targetPredictions).toBe(3);
    expect(result.analystStyle).toBe("fuller analyst-style");
  });

  test("deep sub-block does not override unset fields (falls back to combo)", () => {
    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "deep" },
      baseConfig,
    );

    // DefaultPredictionHorizon is not set in deep sub-block, falls back to combo value.
    expect(result.defaultPredictionHorizon).toBe(5);
    expect(result.predictionSubjects).toEqual([
      "SPY",
      "QQQ",
      "^VIX",
      "DGS10",
      "DGS2",
      "T10Y2Y",
      "FEDFUNDS",
      "CPIAUCSL",
      "UNRATE",
      "DTWEXBGS",
    ]);
  });
});

describe("resolveRunParams — run keys", () => {
  test("market-overview equity brief", () => {
    const result = resolveRunParams(
      { jobType: "market-overview", assetClass: "equity", depth: "brief", horizonTradingDays: 5 },
      baseConfig,
    );

    expect(result.defaultPredictionHorizon).toBe(5);
    expect(result.predictionSubjects).toContain("DGS10");
    expect(result.predictionSubjects).not.toContain("BTC");
    expect(result.focus).toContain("market regime");
    expect(result.focus).not.toContain("weekly market regime");
  });

  test("market-overview equity brief accepts 15-day horizon", () => {
    const result = resolveRunParams(
      { jobType: "market-overview", assetClass: "equity", depth: "brief", horizonTradingDays: 15 },
      baseConfig,
    );

    expect(result.defaultPredictionHorizon).toBe(15);
    expect(result.focus).toContain("market regime");
    expect(result.focus).toContain("movers");
  });

  test("weekly-equity deep has cross-asset themes in focus", () => {
    const result = resolveRunParams(
      { jobType: "weekly", assetClass: "equity", depth: "deep" },
      baseConfig,
    );

    expect(result.focus).toContain("cross-asset themes");
  });

  test("daily and weekly aliases resolve through market-overview profiles", () => {
    const daily = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      baseConfig,
    );
    const weekly = resolveRunParams(
      { jobType: "weekly", assetClass: "equity", depth: "brief" },
      baseConfig,
    );

    expect(daily.defaultPredictionHorizon).toBe(5);
    expect(weekly.defaultPredictionHorizon).toBe(15);
    expect(daily.predictionSubjects).toEqual(weekly.predictionSubjects);
    expect(daily.predictionSubjects).toContain("DGS10");
    expect(daily.predictionSubjects).not.toContain("BTC");
  });

  test("ticker brief uses command symbol as predictionSubjects", () => {
    const result = resolveRunParams(
      { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      baseConfig,
    );

    expect(result.predictionSubjects).toEqual(["AAPL"]);
    expect(result.minimumKeyFindings).toBe(4);
    expect(result.targetPredictions).toBe(3);
  });

  test("ticker deep uses command symbol and deep overrides", () => {
    const result = resolveRunParams(
      { jobType: "equity", assetClass: "equity", symbol: "TSLA", depth: "deep" },
      baseConfig,
    );

    expect(result.predictionSubjects).toEqual(["TSLA"]);
    expect(result.minimumKeyFindings).toBe(6);
    expect(result.targetPredictions).toBe(5);
    expect(result.analystStyle).toBe("fuller analyst-style");
  });

  test("research with resolved proxy uses proxy-only prediction subjects", () => {
    const result = resolveRunParams(
      {
        jobType: "research",
        assetClass: "equity",
        subject: "Analyze AI biotech",
        subjectKey: "biotech",
        predictionProxySymbol: "xbi",
        depth: "brief",
      },
      baseConfig,
    );

    expect(result.predictionSubjects).toEqual(["XBI"]);
    expect(result.defaultPredictionHorizon).toBe(15);
    expect(result.targetPredictions).toBe(2);
    expect(result.focus).toContain("proxy evidence");
    expect(result.predictionSubjects).not.toContain("^VIX");
  });

  test("research without resolved proxy targets zero predictions", () => {
    const result = resolveRunParams(
      {
        jobType: "research",
        assetClass: "equity",
        subject: "Analyze an unlisted theme",
        depth: "brief",
      },
      baseConfig,
    );

    expect(result.predictionSubjects).toEqual([]);
    expect(result.targetPredictions).toBe(0);
  });

  test("research deep favors non-direction prediction mix", () => {
    const result = resolveRunParams(
      {
        jobType: "research",
        assetClass: "equity",
        subject: "Analyze AI biotech",
        predictionProxySymbol: "xbi",
        depth: "deep",
      },
      baseConfig,
    );

    expect(result.targetPredictions).toBe(3);
    expect(result.targetKindMix).toEqual({ favored: ["range"], minNonDirection: 2 });
  });

  test("daily-crypto keeps depth profile but uses crypto prediction subjects", () => {
    const equity = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      baseConfig,
    );
    const crypto = resolveRunParams(
      { jobType: "daily", assetClass: "crypto", depth: "brief" },
      baseConfig,
    );

    expect(crypto.minimumKeyFindings).toBe(equity.minimumKeyFindings);
    expect(crypto.targetPredictions).toBe(equity.targetPredictions);
    expect(crypto.analystStyle).toBe(equity.analystStyle);
    expect(crypto.predictionSubjects).toEqual(["BTC", "ETH"]);
    expect(crypto.predictionSubjects).not.toContain("SPY");
  });

  test("modelParams is undefined by default (no sampling knobs seeded)", () => {
    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      baseConfig,
    );

    expect(result.modelParams).toBeUndefined();
  });

  test("AppConfig modelParams flow into resolved run params", () => {
    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      { ...baseConfig, modelParams: { reasoningEffort: "medium" } },
    );

    expect(result.modelParams).toEqual({ reasoningEffort: "medium" });
  });

  test("run-specific modelParams override AppConfig defaults", () => {
    const patchedConfig: RunConfig = {
      ...runConfig,
      "market-overview-equity": {
        ...runConfig["market-overview-equity"],
        modelParams: { temperature: 0.2, reasoningEffort: "high" },
      },
    };

    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      { ...baseConfig, modelParams: { reasoningEffort: "low" } },
      patchedConfig,
    );

    expect(result.modelParams).toEqual({ reasoningEffort: "high", temperature: 0.2 });
  });
});
