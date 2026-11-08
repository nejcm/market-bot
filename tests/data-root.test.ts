import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readCalibrationSummary, readProviderHealth } from "../app/artifacts";
import { defaultPeerUniverseLearnedPath, resolveConfig } from "../src/config";
import { loadCalibrationContext } from "../src/research/calibration-context";
import { buildAndWriteCalibration, runScorePass } from "../src/scoring/index";

let root = "";
let dataDir = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "data-root-test-"));
  dataDir = join(root, "store");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("a MARKET_BOT_DATA_DIR not named runs keeps every shared artifact inside it", async () => {
  const now = new Date("2026-05-01T00:00:00.000Z");
  await runScorePass(dataDir, now);
  await buildAndWriteCalibration(dataDir, now);

  expect(await readdir(root)).toEqual(["store"]);
  expect(await readdir(dataDir)).toEqual(
    expect.arrayContaining(["calibration", "provider-health"]),
  );
  await expect(readProviderHealth(dataDir)).resolves.toHaveProperty("summary");
  await expect(readCalibrationSummary(dataDir)).resolves.toHaveProperty("summary");
  expect(await loadCalibrationContext(dataDir)).toBeDefined();
});

test("derived state paths resolve to the same root as the runs dir", () => {
  const custom = resolveConfig({ MARKET_BOT_DATA_DIR: dataDir });
  expect(custom.sourceOptions.cacheDir).toBe(join(dataDir, "cache"));
  expect(custom.sourceOptions.newsSeenPath).toBe(join(dataDir, "news-seen.json"));
  expect(custom.sourceOptions.peerUniverseLearnedPath).toBe(
    join(dataDir, "peer-universe-learned.json"),
  );

  const defaults = resolveConfig({ MARKET_BOT_CACHE_DIR: "" });
  expect(defaults.sourceOptions.cacheDir).toBe(join("data", "cache"));
  expect(defaults.sourceOptions.newsSeenPath).toBe(join("data", "news-seen.json"));
});

test("the peer-universe fallback path uses the shared data root", () => {
  expect(defaultPeerUniverseLearnedPath("runs")).toBe("peer-universe-learned.json");
  expect(defaultPeerUniverseLearnedPath("/x/runs/")).toBe("/x/peer-universe-learned.json");
  expect(defaultPeerUniverseLearnedPath("/x/store")).toBe("/x/store/peer-universe-learned.json");
});
