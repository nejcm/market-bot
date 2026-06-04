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
      jobType: "daily",
      assetClass: "equity",
      depth: "brief",
    });
  });

  test("parses weekly crypto deep", () => {
    expect(parseArgs(["weekly", "--asset", "crypto", "--deep"])).toEqual({
      jobType: "weekly",
      assetClass: "crypto",
      depth: "deep",
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
    expect(commandLabel({ jobType: "weekly", assetClass: "crypto", depth: "brief" })).toBe(
      "weekly crypto",
    );
    expect(commandLabel({ jobType: "weekly", assetClass: "equity", depth: "deep" })).toBe(
      "weekly equity deep",
    );
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

  test("labels utility commands", () => {
    expect(commandLabel({ jobType: "score" })).toBe("score");
    expect(commandLabel({ jobType: "calibration" })).toBe("calibration");
    expect(commandLabel({ jobType: "cache-prune" })).toBe("cache-prune");
    expect(commandLabel({ jobType: "provider-health" })).toBe("provider-health");
  });

  test("exposes shared registry job options", () => {
    expect(CONSOLE_JOB_TYPES).toEqual([
      "daily",
      "weekly",
      "ticker",
      "alpha-search",
      "score",
      "calibration",
      "cache-prune",
      "provider-health",
    ]);
    expect(SEARCH_JOB_TYPE_OPTIONS).toEqual(["", "daily", "weekly", "ticker", "alpha-search"]);
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
