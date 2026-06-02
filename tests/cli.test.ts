import { describe, expect, test } from "bun:test";
import { commandLabel, parseArgs } from "../src/cli/args";

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
});
