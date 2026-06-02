import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, scorePassOptions } from "../src/app";

const dataDirs: string[] = [];
const originalDataDir = process.env.MARKET_BOT_DATA_DIR;
const originalRedditSubreddits = process.env.MARKET_BOT_REDDIT_SUBREDDITS;

afterEach(async () => {
  if (originalDataDir === undefined) {
    delete process.env.MARKET_BOT_DATA_DIR;
  } else {
    process.env.MARKET_BOT_DATA_DIR = originalDataDir;
  }
  if (originalRedditSubreddits === undefined) {
    delete process.env.MARKET_BOT_REDDIT_SUBREDDITS;
  } else {
    process.env.MARKET_BOT_REDDIT_SUBREDDITS = originalRedditSubreddits;
  }

  await Promise.all(
    dataDirs.splice(0).map((dataDir) => rm(dataDir, { recursive: true, force: true })),
  );
});

describe("scorePassOptions", () => {
  test("disables scorer close cache when source cache is disabled", () => {
    expect(
      scorePassOptions({
        equityMoverLimit: 5,
        cryptoMoverLimit: 5,
        newsLimit: 8,
        sourceTimeoutMs: 15_000,
        cacheDir: "data/cache",
        cacheDisabled: true,
      }),
    ).toEqual({});
  });

  test("uses cache dir for scorer close cache when cache is enabled", () => {
    expect(
      scorePassOptions({
        equityMoverLimit: 5,
        cryptoMoverLimit: 5,
        newsLimit: 8,
        sourceTimeoutMs: 15_000,
        cacheDir: "data/cache",
        cacheDisabled: false,
      }),
    ).toEqual({ closeCacheDir: "data/cache" });
  });

  test("passes macro and IV provider keys to scorer options", () => {
    expect(
      scorePassOptions({
        equityMoverLimit: 5,
        cryptoMoverLimit: 5,
        newsLimit: 8,
        sourceTimeoutMs: 15_000,
        fredApiKey: "fred-key",
        tradierApiToken: "tradier-token",
        cacheDir: "data/cache",
        cacheDisabled: false,
      }),
    ).toEqual({
      closeCacheDir: "data/cache",
      fredApiKey: "fred-key",
      tradierApiToken: "tradier-token",
    });
  });
});

describe("runCli", () => {
  test("reports when calibration has no resolved predictions to write", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-app-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;

    await expect(runCli(["calibration"])).resolves.toBe(
      "Calibration summary not written: no resolved predictions found",
    );
  });

  test("handles alpha-search without score or calibration side effects", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-alpha-search-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;

    await expect(runCli(["alpha-search", "--asset", "equity"])).resolves.toBe(
      "Alpha search phase 1 ready: Reddit discovery implementation is pending",
    );
    expect(existsSync(join(dataDir, "..", "calibration", "summary.json"))).toBe(false);
  });

  test("ignores malformed alpha-search config for unrelated commands", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-calibration-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    dataDirs.push(dataDir);
    process.env.MARKET_BOT_DATA_DIR = dataDir;
    process.env.MARKET_BOT_REDDIT_SUBREDDITS = "stocks,bad-name";

    await expect(runCli(["calibration"])).resolves.toBe(
      "Calibration summary not written: no resolved predictions found",
    );
  });

  test("validates alpha-search config for alpha-search commands", async () => {
    process.env.MARKET_BOT_REDDIT_SUBREDDITS = "stocks,bad-name";

    await expect(runCli(["alpha-search", "--asset", "equity"])).rejects.toThrow(
      "Invalid subreddit name: bad-name",
    );
  });
});
