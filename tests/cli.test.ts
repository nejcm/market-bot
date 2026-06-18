import { describe, expect, test } from "bun:test";
import { commandLabel, parseArgs } from "../src/cli/args";
import {
  CONSOLE_JOB_TYPES,
  SEARCH_JOB_TYPE_OPTIONS,
  jobRequestArgv,
  jobSupportsAsset,
  jobSupportsDepth,
} from "../src/cli/job-registry";

describe("parseArgs", () => {
  test("parses daily equity brief", () => {
    expect(parseArgs(["daily", "--asset", "equity"])).toEqual({
      jobType: "market-overview",
      assetClass: "equity",
      depth: "brief",
      horizonTradingDays: 5,
      legacyAlias: "daily",
    });
  });

  test("parses weekly crypto deep", () => {
    expect(parseArgs(["weekly", "--asset", "crypto", "--deep"])).toEqual({
      jobType: "market-overview",
      assetClass: "crypto",
      depth: "deep",
      horizonTradingDays: 15,
      legacyAlias: "weekly",
    });
  });

  test("parses market overview horizon and prompt", () => {
    expect(
      parseArgs(["market-overview", "--asset", "equity", "--horizon", "7", "banks", "credit"]),
    ).toEqual({
      jobType: "market-overview",
      assetClass: "equity",
      depth: "brief",
      horizonTradingDays: 7,
      prompt: "banks credit",
    });
  });

  test("parses ticker crypto deep and normalizes symbol", () => {
    expect(parseArgs(["ticker", "btc", "--asset", "crypto", "--deep"])).toEqual({
      jobType: "ticker",
      assetClass: "crypto",
      symbol: "BTC",
      depth: "deep",
    });
  });

  test("parses alpha-search equity deep", () => {
    expect(parseArgs(["alpha-search", "--asset", "equity", "--deep"])).toEqual({
      jobType: "alpha-search",
      assetClass: "equity",
      depth: "deep",
    });
  });

  test("rejects alpha-search non-equity assets", () => {
    expect(() => parseArgs(["alpha-search", "--asset", "crypto"])).toThrow(
      "alpha-search supports only --asset equity in V1",
    );
  });

  test("rejects missing asset class", () => {
    expect(() => parseArgs(["daily"])).toThrow("Expected --asset equity|crypto");
  });

  test("rejects unknown flags", () => {
    expect(() => parseArgs(["daily", "--asset", "equity", "--deeep"])).toThrow("Unknown flag");
  });

  test("labels commands for CLI output", () => {
    expect(
      commandLabel({ jobType: "ticker", assetClass: "equity", symbol: "AAPL", depth: "deep" }),
    ).toBe("ticker AAPL equity deep");
    expect(
      commandLabel({
        jobType: "market-overview",
        assetClass: "crypto",
        depth: "brief",
        horizonTradingDays: 15,
        legacyAlias: "weekly",
      }),
    ).toBe("weekly crypto 15d");
    expect(
      commandLabel({
        jobType: "market-overview",
        assetClass: "equity",
        depth: "deep",
        horizonTradingDays: 15,
      }),
    ).toBe("market-overview equity 15d deep");
    expect(commandLabel({ jobType: "alpha-search", assetClass: "equity", depth: "deep" })).toBe(
      "alpha-search equity deep",
    );
  });

  test("parses score command", () => {
    expect(parseArgs(["score"])).toEqual({ jobType: "score" });
  });

  test("parses calibration command", () => {
    expect(parseArgs(["calibration"])).toEqual({ jobType: "calibration" });
  });

  test("parses cache prune command", () => {
    expect(parseArgs(["cache", "prune"])).toEqual({ jobType: "cache-prune" });
  });

  test("parses provider health command", () => {
    expect(parseArgs(["provider-health"])).toEqual({ jobType: "provider-health" });
  });

  test("parses history rebuild command", () => {
    expect(parseArgs(["history", "rebuild"])).toEqual({ jobType: "history-rebuild" });
  });

  test("parses index rebuild command", () => {
    expect(parseArgs(["index", "rebuild"])).toEqual({ jobType: "index-rebuild" });
  });

  test("parses history search command with filters", () => {
    expect(
      parseArgs([
        "history",
        "search",
        "--query",
        "margin",
        "--symbol",
        "aapl",
        "--asset",
        "equity",
        "--job-type",
        "ticker",
        "--from",
        "2026-06-01",
        "--to",
        "2026-06-05",
        "--section",
        "risks",
        "--provider",
        "yahoo",
        "--limit",
        "5",
      ]),
    ).toEqual({
      jobType: "history-search",
      query: "margin",
      symbol: "AAPL",
      assetClass: "equity",
      sourceJobType: "ticker",
      from: "2026-06-01",
      to: "2026-06-05",
      section: "risks",
      provider: "yahoo",
      limit: 5,
    });
  });

  test("parses research job type in history search filter", () => {
    expect(parseArgs(["history", "search", "--query", "chips", "--job-type", "research"])).toEqual({
      jobType: "history-search",
      query: "chips",
      sourceJobType: "research",
    });
  });

  test("parses history thesis-delta command", () => {
    expect(
      parseArgs([
        "history",
        "thesis-delta",
        "aapl",
        "--asset",
        "equity",
        "--since",
        "2026-06-01",
        "--narrative",
      ]),
    ).toEqual({
      jobType: "history-thesis-delta",
      symbol: "AAPL",
      assetClass: "equity",
      since: "2026-06-01",
      narrative: true,
    });
  });

  test("labels utility commands", () => {
    expect(commandLabel({ jobType: "score" })).toBe("score");
    expect(commandLabel({ jobType: "calibration" })).toBe("calibration");
    expect(commandLabel({ jobType: "cache-prune" })).toBe("cache-prune");
    expect(commandLabel({ jobType: "provider-health" })).toBe("provider-health");
    expect(commandLabel({ jobType: "history-rebuild" })).toBe("history-rebuild");
    expect(commandLabel({ jobType: "index-rebuild" })).toBe("index-rebuild");
    expect(commandLabel({ jobType: "history-search", query: "margin" })).toBe(
      "history search margin",
    );
    expect(
      commandLabel({
        jobType: "history-thesis-delta",
        assetClass: "equity",
        symbol: "AAPL",
        narrative: false,
      }),
    ).toBe("history thesis-delta equity:AAPL");
  });

  test("exposes shared registry job options", () => {
    expect(CONSOLE_JOB_TYPES).toEqual([
      "daily",
      "weekly",
      "market-overview",
      "ticker",
      "alpha-search",
      "score",
      "calibration",
      "cache-prune",
      "provider-health",
    ]);
    expect(SEARCH_JOB_TYPE_OPTIONS).toEqual([
      "",
      "market-overview",
      "daily",
      "weekly",
      "ticker",
      "alpha-search",
      "research",
    ]);
    expect(jobSupportsAsset("ticker")).toBe(true);
    expect(jobSupportsAsset("score")).toBe(false);
    expect(jobSupportsDepth("alpha-search")).toBe(true);
    expect(jobSupportsDepth("provider-health")).toBe(false);
  });

  test("converts job requests from the shared registry", () => {
    expect(jobRequestArgv({ jobType: "ticker", symbol: "aapl", assetClass: "equity" })).toEqual([
      "ticker",
      "aapl",
      "--asset",
      "equity",
    ]);
  });
});
