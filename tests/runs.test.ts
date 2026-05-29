import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { resolveRunParams, runConfig } from "../src/config/runs";

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
};

describe("resolveRunParams — fallback chain", () => {
  test("env AppConfig provides quickModel and synthesisModel when combo has none", () => {
    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      baseConfig,
    );

    expect(result.quickModel).toBe("env-quick");
    expect(result.synthesisModel).toBe("env-synthesis");
  });

  test("combo block model overrides AppConfig", () => {
    const modified = {
      ...runConfig["daily-equity"],
      quickModel: "combo-quick",
      synthesisModel: "combo-synthesis",
    };
    const origCombo = runConfig["daily-equity"];
    const patchedConfig = {
      ...runConfig,
      "daily-equity": { ...modified },
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
    expect(result.minimumPredictions).toBe(2);
    expect(result.analystStyle).toBe("concise brief");
  });

  test("deep depth merges deep sub-block over combo", () => {
    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "deep" },
      baseConfig,
    );

    expect(result.minimumKeyFindings).toBe(5);
    expect(result.minimumScenarios).toBe(3);
    expect(result.minimumPredictions).toBe(3);
    expect(result.analystStyle).toBe("fuller analyst-style");
  });

  test("deep sub-block does not override unset fields (falls back to combo)", () => {
    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "deep" },
      baseConfig,
    );

    // DefaultPredictionHorizon is not set in deep sub-block, falls back to combo value.
    expect(result.defaultPredictionHorizon).toBe(5);
    expect(result.predictionSubjects).toEqual(["SPY", "QQQ", "^VIX", "BTC"]);
  });
});

describe("resolveRunParams — run keys", () => {
  test("daily-equity brief", () => {
    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      baseConfig,
    );

    expect(result.defaultPredictionHorizon).toBe(5);
    expect(result.focus).toContain("market regime");
    expect(result.focus).not.toContain("weekly market regime");
  });

  test("weekly-equity brief has 15-day horizon and weekly focus", () => {
    const result = resolveRunParams(
      { jobType: "weekly", assetClass: "equity", depth: "brief" },
      baseConfig,
    );

    expect(result.defaultPredictionHorizon).toBe(15);
    expect(result.focus).toContain("weekly market regime");
    expect(result.focus).toContain("5-session movers");
  });

  test("weekly-equity deep has cross-asset themes in focus", () => {
    const result = resolveRunParams(
      { jobType: "weekly", assetClass: "equity", depth: "deep" },
      baseConfig,
    );

    expect(result.focus).toContain("cross-asset themes");
  });

  test("ticker brief uses command symbol as predictionSubjects", () => {
    const result = resolveRunParams(
      { jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      baseConfig,
    );

    expect(result.predictionSubjects).toEqual(["AAPL"]);
    expect(result.minimumKeyFindings).toBe(4);
    expect(result.minimumPredictions).toBe(3);
  });

  test("ticker deep uses command symbol and deep overrides", () => {
    const result = resolveRunParams(
      { jobType: "ticker", assetClass: "equity", symbol: "TSLA", depth: "deep" },
      baseConfig,
    );

    expect(result.predictionSubjects).toEqual(["TSLA"]);
    expect(result.minimumKeyFindings).toBe(6);
    expect(result.minimumPredictions).toBe(5);
    expect(result.analystStyle).toBe("fuller analyst-style");
  });

  test("daily-crypto has same depth profile as daily-equity", () => {
    const equity = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      baseConfig,
    );
    const crypto = resolveRunParams(
      { jobType: "daily", assetClass: "crypto", depth: "brief" },
      baseConfig,
    );

    expect(crypto.minimumKeyFindings).toBe(equity.minimumKeyFindings);
    expect(crypto.minimumPredictions).toBe(equity.minimumPredictions);
    expect(crypto.analystStyle).toBe(equity.analystStyle);
  });

  test("modelParams is undefined by default (no sampling knobs seeded)", () => {
    const result = resolveRunParams(
      { jobType: "daily", assetClass: "equity", depth: "brief" },
      baseConfig,
    );

    expect(result.modelParams).toBeUndefined();
  });
});
