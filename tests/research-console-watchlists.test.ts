import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addWatchlistItem,
  consoleDbPath,
  createWatchlist,
  deleteWatchlist,
  getRunEarningsDates,
  getWatchlist,
  listWatchlistIdsContaining,
  listWatchlistItems,
  listWatchlists,
  openConsoleDb,
  removeWatchlistItem,
  renameWatchlist,
  reorderWatchlistItems,
} from "../app/console-db";
import {
  addWatchlistItem as addWatchlistItemFromClient,
  fetchWatchlistMembership,
} from "../app/client/api";
import { handleResearchConsoleRequest } from "../app/server";
import { readInstrumentWatchlistRows, rebuildRunArtifactIndex } from "../src/run-artifact-index";
import { prediction, predictionScore, researchReport } from "./support/fixtures";

const tmpDirs: string[] = [];
const originalIndexDbPath = process.env.MARKET_BOT_INDEX_DB_PATH;
const originalIndexDisable = process.env.MARKET_BOT_INDEX_DISABLE;

afterEach(() => {
  if (originalIndexDbPath === undefined) {
    delete process.env.MARKET_BOT_INDEX_DB_PATH;
  } else {
    process.env.MARKET_BOT_INDEX_DB_PATH = originalIndexDbPath;
  }
  if (originalIndexDisable === undefined) {
    delete process.env.MARKET_BOT_INDEX_DISABLE;
  } else {
    process.env.MARKET_BOT_INDEX_DISABLE = originalIndexDisable;
  }
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDataDir(): { readonly root: string; readonly dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "research-console-watchlists-"));
  tmpDirs.push(root);
  const dataDir = join(root, "runs");
  mkdirSync(dataDir);
  return { root, dataDir };
}

function jsonRequest(method: string, path: string, body?: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function writeRun(
  dataDir: string,
  runDirName: string,
  options: {
    readonly runId: string;
    readonly symbol: string;
    readonly generatedAt: string;
    readonly depth?: string;
    readonly predictions?: readonly ReturnType<typeof prediction>[];
    readonly scores?: readonly unknown[];
    readonly extras?: Record<string, unknown>;
    readonly failed?: boolean;
  },
): void {
  const runDir = join(dataDir, runDirName);
  mkdirSync(join(runDir, "normalized"), { recursive: true });
  if (options.failed === true) {
    // Failed final-synthesis runs leave a failure sidecar and no report.
    writeFileSync(join(runDir, "failure.json"), "{}\n", "utf8");
    return;
  }
  writeFileSync(
    join(runDir, "report.json"),
    `${JSON.stringify(
      researchReport({
        runId: options.runId,
        jobType: "equity",
        assetClass: "equity",
        symbol: options.symbol,
        generatedAt: options.generatedAt,
        predictions: options.predictions ?? [],
        ...(options.depth !== undefined || options.extras !== undefined
          ? {
              extras: {
                ...(options.depth !== undefined ? { depth: options.depth } : {}),
                ...options.extras,
              },
            }
          : {}),
      }),
    )}\n`,
    "utf8",
  );
  if (options.scores !== undefined) {
    writeFileSync(
      join(runDir, "score.json"),
      `${JSON.stringify({ runId: options.runId, scores: options.scores })}\n`,
      "utf8",
    );
  }
  writeFileSync(join(runDir, "report.md"), "# Report\n", "utf8");
}

describe("console db watchlists", () => {
  test("derives the console db path beside the data root", () => {
    expect(consoleDbPath("data/runs")).toBe(join("data", "console", "console.sqlite"));
    expect(consoleDbPath(join("mnt", "bot", "runs"))).toBe(
      join("mnt", "bot", "console", "console.sqlite"),
    );
    const bare = join("tmp", "elsewhere");
    expect(consoleDbPath(bare)).toBe(join(bare, "console", "console.sqlite"));
  });

  test("lists the watchlists containing an instrument", () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "research-console-watchlists-db-")),
      "db.sqlite",
    );
    const db = openConsoleDb(dbPath);
    try {
      const tech = createWatchlist(db, "Tech");
      const chips = createWatchlist(db, "Chips");
      createWatchlist(db, "Empty");
      addWatchlistItem(db, chips.id, "equity", "AMD");
      addWatchlistItem(db, tech.id, "equity", "AMD");
      addWatchlistItem(db, tech.id, "equity", "AAPL");

      expect(listWatchlistIdsContaining(db, "equity", "AMD")).toEqual([tech.id, chips.id]);
      expect(listWatchlistIdsContaining(db, "equity", "MSFT")).toEqual([]);
      removeWatchlistItem(db, tech.id, "equity", "AMD");
      expect(listWatchlistIdsContaining(db, "equity", "AMD")).toEqual([chips.id]);
    } finally {
      db.close();
    }
  });

  test("creates, lists, renames, and deletes watchlists", () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "research-console-watchlists-db-")),
      "db.sqlite",
    );
    const db = openConsoleDb(dbPath);
    try {
      expect(listWatchlists(db)).toEqual([]);

      const first = createWatchlist(db, "Tech");
      expect(first).toMatchObject({ id: 1, name: "Tech" });
      expect(new Date(first.createdAt).getTime()).not.toBeNaN();
      expect(listWatchlists(db)).toHaveLength(1);

      expect(renameWatchlist(db, first.id, "Big Tech")).toBe(true);
      expect(getWatchlist(db, first.id)?.name).toBe("Big Tech");
      expect(renameWatchlist(db, 999, "Nobody")).toBe(false);

      expect(deleteWatchlist(db, first.id)).toBe(true);
      expect(deleteWatchlist(db, first.id)).toBe(false);
      expect(listWatchlists(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("keeps unpositioned items in (asset_class, symbol) order", () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "research-console-watchlists-db-")),
      "db.sqlite",
    );
    const db = openConsoleDb(dbPath);
    try {
      const watchlist = createWatchlist(db, "List");
      addWatchlistItem(db, watchlist.id, "equity", "MSFT");
      addWatchlistItem(db, watchlist.id, "equity", "AAPL");

      expect(listWatchlistItems(db, watchlist.id)).toEqual([
        { assetClass: "equity", symbol: "AAPL", position: null },
        { assetClass: "equity", symbol: "MSFT", position: null },
      ]);
    } finally {
      db.close();
    }
  });

  test("reorder writes positions and later adds append", () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "research-console-watchlists-db-")),
      "db.sqlite",
    );
    const db = openConsoleDb(dbPath);
    try {
      const watchlist = createWatchlist(db, "List");
      addWatchlistItem(db, watchlist.id, "equity", "AAPL");
      addWatchlistItem(db, watchlist.id, "equity", "MSFT");

      reorderWatchlistItems(db, watchlist.id, [
        { assetClass: "equity", symbol: "MSFT" },
        { assetClass: "equity", symbol: "AAPL" },
      ]);
      expect(listWatchlistItems(db, watchlist.id)).toEqual([
        { assetClass: "equity", symbol: "MSFT", position: 1 },
        { assetClass: "equity", symbol: "AAPL", position: 2 },
      ]);

      // A manual order exists, so new items append after it.
      addWatchlistItem(db, watchlist.id, "equity", "AMZN");
      expect(listWatchlistItems(db, watchlist.id).map((item) => item.symbol)).toEqual([
        "MSFT",
        "AAPL",
        "AMZN",
      ]);
    } finally {
      db.close();
    }
  });

  test("removes items and cascades them when the watchlist is deleted", () => {
    const dbPath = join(
      mkdtempSync(join(tmpdir(), "research-console-watchlists-db-")),
      "db.sqlite",
    );
    const db = openConsoleDb(dbPath);
    try {
      const watchlist = createWatchlist(db, "List");
      addWatchlistItem(db, watchlist.id, "equity", "AAPL");

      expect(removeWatchlistItem(db, watchlist.id, "equity", "AAPL")).toBe(true);
      expect(removeWatchlistItem(db, watchlist.id, "equity", "AAPL")).toBe(false);

      addWatchlistItem(db, watchlist.id, "equity", "MSFT");
      deleteWatchlist(db, watchlist.id);
      const orphanCount = db.query("SELECT COUNT(*) AS count FROM watchlist_items").get() as {
        readonly count: number;
      };
      expect(orphanCount.count).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("watchlist index rows", () => {
  test("derives latest run, depth, open predictions, and calibration per symbol", async () => {
    const { dataDir } = tempDataDir();
    const dbPath = join(dataDir, "..", "index.sqlite");
    process.env.MARKET_BOT_INDEX_DB_PATH = dbPath;
    const aaplOpen = prediction({
      id: "aapl-open",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
    });
    const aaplHit = prediction({
      id: "aapl-hit",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
    });
    const aaplMiss = prediction({
      id: "aapl-miss",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
    });
    const spyRelative = prediction({
      id: "aapl-about-spy",
      subject: "SPY",
      measurableAs: "close(SPY, +5) > close(SPY, 0)",
    });
    const aaplPending = prediction({
      id: "aapl-pending",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
    });
    const aaplVoided = prediction({
      id: "aapl-voided",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
    });
    const aaplAbandoned = prediction({
      id: "aapl-abandoned",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
    });
    const aaplVoidedUnresolved = prediction({
      id: "aapl-voided-unresolved",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
    });
    writeRun(dataDir, "run-a", {
      runId: "run-a",
      symbol: "AAPL",
      generatedAt: "2026-06-01T00:00:00.000Z",
      depth: "deep",
      predictions: [
        aaplOpen,
        aaplHit,
        aaplMiss,
        spyRelative,
        aaplPending,
        aaplVoided,
        aaplAbandoned,
        aaplVoidedUnresolved,
      ],
      scores: [
        predictionScore("hit", {
          predictionId: "aapl-hit",
          runId: "run-a",
          observedAt: "2026-06-05T00:00:00.000Z",
          scoringVersion: 3,
        }),
        predictionScore("miss", {
          predictionId: "aapl-miss",
          runId: "run-a",
          observedAt: "2026-06-06T00:00:00.000Z",
          scoringVersion: 3,
        }),
        {
          predictionId: "aapl-pending",
          runId: "run-a",
          resolved: false,
          status: "pending",
          attemptCount: 0,
          evidence: {},
        },
        {
          predictionId: "aapl-voided",
          runId: "run-a",
          resolved: true,
          status: "voided",
          attemptCount: 1,
          evidence: {},
        },
        {
          predictionId: "aapl-abandoned",
          runId: "run-a",
          resolved: true,
          status: "abandoned",
          attemptCount: 4,
          evidence: {},
        },
        // Defensive: producers stamp voided resolved=true; a score stored otherwise must not count.
        {
          predictionId: "aapl-voided-unresolved",
          runId: "run-a",
          resolved: false,
          status: "voided",
          attemptCount: 1,
          evidence: {},
        },
      ],
    });
    const briefOpen = prediction({
      id: "brief-open",
      subject: "AAPL",
      measurableAs: "close(AAPL, +5) > close(AAPL, 0)",
    });
    writeRun(dataDir, "run-b", {
      runId: "run-b",
      symbol: "AAPL",
      generatedAt: "2026-06-02T00:00:00.000Z",
      depth: "brief",
      predictions: [briefOpen],
      scores: [],
    });
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    const rows = await readInstrumentWatchlistRows(dataDir, [
      { assetClass: "equity", symbol: "AAPL" },
      { assetClass: "equity", symbol: "MSFT" },
    ]);

    expect(rows?.[0]).toEqual({
      state: "available",
      latestRunId: "run-b",
      latestRunAt: "2026-06-02T00:00:00.000Z",
      depth: "brief",
      openPredictionCount: 3,
      latestCalibration: { outcome: "miss", at: "2026-06-06T00:00:00.000Z" },
    });
    expect(rows?.[1]).toEqual({ state: "never-run" });
  });

  test("returns undefined when the index is missing or disabled", async () => {
    const { dataDir } = tempDataDir();
    process.env.MARKET_BOT_INDEX_DB_PATH = join(dataDir, "..", "index.sqlite");

    expect(
      await readInstrumentWatchlistRows(dataDir, [{ assetClass: "equity", symbol: "AAPL" }]),
    ).toBeUndefined();

    process.env.MARKET_BOT_INDEX_DISABLE = "1";
    expect(
      await readInstrumentWatchlistRows(dataDir, [{ assetClass: "equity", symbol: "AAPL" }]),
    ).toBeUndefined();
  });
});

describe("watchlists API", () => {
  test("reads empty without creating the db file", async () => {
    const { dataDir } = tempDataDir();

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ watchlists: [] });
    expect(existsSync(consoleDbPath(dataDir))).toBe(false);
  });

  test("reports membership for a symbol, empty on an absent db", async () => {
    const { dataDir } = tempDataDir();
    const absent = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists?symbol=AMD"),
      { dataDir },
    );
    await expect(absent.json()).resolves.toEqual({ watchlists: [], memberIds: [] });
    expect(existsSync(consoleDbPath(dataDir))).toBe(false);

    await handleResearchConsoleRequest(jsonRequest("POST", "/api/watchlists", { name: "Tech" }), {
      dataDir,
    });
    await handleResearchConsoleRequest(jsonRequest("POST", "/api/watchlists", { name: "Chips" }), {
      dataDir,
    });
    await handleResearchConsoleRequest(
      jsonRequest("PUT", "/api/watchlists/2/items", { assetClass: "equity", symbol: "AMD" }),
      { dataDir },
    );

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists?symbol=amd"),
      { dataDir },
    );
    await expect(response.json()).resolves.toMatchObject({ memberIds: [2] });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) =>
      handleResearchConsoleRequest(new Request(`http://127.0.0.1${input}`, init), {
        dataDir,
      })) as typeof fetch;
    try {
      await expect(fetchWatchlistMembership("AMD")).resolves.toEqual([2]);
      await expect(fetchWatchlistMembership("bad symbol")).rejects.toThrow(
        "Invalid watchlist request",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("membership GET returns 500 when the console db is corrupt", async () => {
    const { dataDir } = tempDataDir();
    const dbPath = consoleDbPath(dataDir);
    mkdirSync(join(dbPath, ".."), { recursive: true });
    writeFileSync(dbPath, "not a sqlite database", "utf8");

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists?symbol=AMD"),
      { dataDir },
    );

    expect(response.status).toBe(500);
  });

  test("detail GET on an absent db returns 404 without creating the file", async () => {
    const { dataDir } = tempDataDir();

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists/1"),
      { dataDir },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Watchlist not found" });
    expect(existsSync(consoleDbPath(dataDir))).toBe(false);
  });

  test("round-trips create, list, rename, and delete", async () => {
    const { dataDir } = tempDataDir();

    const createResponse = await handleResearchConsoleRequest(
      jsonRequest("POST", "/api/watchlists", { name: "Tech" }),
      { dataDir },
    );
    expect(createResponse.status).toBe(200);
    await expect(createResponse.json()).resolves.toMatchObject({ id: 1, name: "Tech" });

    const listResponse = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists"),
      { dataDir },
    );
    await expect(listResponse.json()).resolves.toMatchObject({
      watchlists: [{ id: 1, name: "Tech" }],
    });

    const renameResponse = await handleResearchConsoleRequest(
      jsonRequest("PUT", "/api/watchlists/1", { name: "Big Tech" }),
      { dataDir },
    );
    expect(renameResponse.status).toBe(200);
    await expect(renameResponse.json()).resolves.toMatchObject({ id: 1, name: "Big Tech" });

    const detailResponse = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists/1"),
      { dataDir },
    );
    await expect(detailResponse.json()).resolves.toMatchObject({
      watchlist: { id: 1, name: "Big Tech", items: [] },
    });

    const deleteResponse = await handleResearchConsoleRequest(
      jsonRequest("DELETE", "/api/watchlists/1"),
      { dataDir },
    );
    await expect(deleteResponse.json()).resolves.toEqual({ removed: true });

    const missingResponse = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists/1"),
      { dataDir },
    );
    expect(missingResponse.status).toBe(404);
  });

  test("declares never-run and available rows with an index, index-unavailable without", async () => {
    const { dataDir } = tempDataDir();
    const dbPath = join(dataDir, "..", "index.sqlite");
    process.env.MARKET_BOT_INDEX_DB_PATH = dbPath;
    writeRun(dataDir, "run-a", {
      runId: "run-a",
      symbol: "AAPL",
      generatedAt: "2026-06-01T00:00:00.000Z",
      depth: "deep",
    });
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    await handleResearchConsoleRequest(jsonRequest("POST", "/api/watchlists", { name: "Tech" }), {
      dataDir,
    });
    await handleResearchConsoleRequest(
      jsonRequest("PUT", "/api/watchlists/1/items", { assetClass: "equity", symbol: "aapl" }),
      { dataDir },
    );
    await handleResearchConsoleRequest(
      jsonRequest("PUT", "/api/watchlists/1/items", { assetClass: "equity", symbol: "msft" }),
      { dataDir },
    );

    const detailResponse = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists/1"),
      { dataDir },
    );
    const payload = (await detailResponse.json()) as {
      readonly watchlist: {
        readonly items: readonly { readonly symbol: string; readonly row: unknown }[];
      };
    };
    expect(payload.watchlist.items).toMatchObject([
      {
        symbol: "AAPL",
        row: {
          state: "available",
          latestRunId: "run-a",
          latestRunAt: "2026-06-01T00:00:00.000Z",
          depth: "deep",
          openPredictionCount: 0,
        },
      },
      { symbol: "MSFT", row: { state: "never-run" } },
    ]);

    // Same list, index removed: rows declare the unavailable index.
    rmSync(dbPath);
    const withoutIndex = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists/1"),
      { dataDir },
    );
    const payloadWithoutIndex = (await withoutIndex.json()) as {
      readonly watchlist: {
        readonly items: readonly { readonly row: { readonly state: string } }[];
      };
    };
    expect(payloadWithoutIndex.watchlist.items.map((item) => item.row.state)).toEqual([
      "index-unavailable",
      "index-unavailable",
    ]);
  });

  test("client accepts the server's add-item response", async () => {
    const { dataDir } = tempDataDir();
    await handleResearchConsoleRequest(jsonRequest("POST", "/api/watchlists", { name: "Tech" }), {
      dataDir,
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string, init?: RequestInit) =>
      handleResearchConsoleRequest(new Request(`http://127.0.0.1${input}`, init), {
        dataDir,
      })) as typeof fetch;
    try {
      await addWatchlistItemFromClient(1, "aapl");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reorders items through the API and rejects wrong sets", async () => {
    const { dataDir } = tempDataDir();
    await handleResearchConsoleRequest(jsonRequest("POST", "/api/watchlists", { name: "Tech" }), {
      dataDir,
    });
    for (const symbol of ["aapl", "msft"]) {
      await handleResearchConsoleRequest(
        jsonRequest("PUT", "/api/watchlists/1/items", { assetClass: "equity", symbol }),
        { dataDir },
      );
    }

    const reorderResponse = await handleResearchConsoleRequest(
      jsonRequest("PUT", "/api/watchlists/1/order", {
        items: [
          { assetClass: "equity", symbol: "MSFT" },
          { assetClass: "equity", symbol: "AAPL" },
        ],
      }),
      { dataDir },
    );
    expect(reorderResponse.status).toBe(200);
    await expect(reorderResponse.json()).resolves.toEqual({ reordered: true });

    const detailResponse = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists/1"),
      { dataDir },
    );
    const payload = (await detailResponse.json()) as {
      readonly watchlist: {
        readonly items: readonly { readonly symbol: string; readonly position: number | null }[];
      };
    };
    expect(payload.watchlist.items.map((item) => item.symbol)).toEqual(["MSFT", "AAPL"]);
    expect(payload.watchlist.items.map((item) => item.position)).toEqual([1, 2]);

    const wrongSet = await handleResearchConsoleRequest(
      jsonRequest("PUT", "/api/watchlists/1/order", {
        items: [{ assetClass: "equity", symbol: "MSFT" }],
      }),
      { dataDir },
    );
    expect(wrongSet.status).toBe(400);
    await expect(wrongSet.json()).resolves.toEqual({
      error: "Reorder must include every watchlist item exactly once",
    });
  });

  test("removes items", async () => {
    const { dataDir } = tempDataDir();
    await handleResearchConsoleRequest(jsonRequest("POST", "/api/watchlists", { name: "Tech" }), {
      dataDir,
    });
    await handleResearchConsoleRequest(
      jsonRequest("PUT", "/api/watchlists/1/items", { assetClass: "equity", symbol: "AAPL" }),
      { dataDir },
    );

    const removeResponse = await handleResearchConsoleRequest(
      jsonRequest("DELETE", "/api/watchlists/1/items/equity/AAPL"),
      { dataDir },
    );
    await expect(removeResponse.json()).resolves.toEqual({ removed: true });

    const repeatResponse = await handleResearchConsoleRequest(
      jsonRequest("DELETE", "/api/watchlists/1/items/equity/AAPL"),
      { dataDir },
    );
    await expect(repeatResponse.json()).resolves.toEqual({ removed: false });
  });

  test("rejects cross-origin mutations", async () => {
    const { dataDir } = tempDataDir();
    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://evil.example" },
        body: JSON.stringify({ name: "Tech" }),
      }),
      { dataDir },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Watchlist request origin is not allowed",
    });
  });

  test("rejects malformed requests", async () => {
    const { dataDir } = tempDataDir();
    const cases: readonly {
      readonly method: string;
      readonly path: string;
      readonly body: unknown;
    }[] = [
      { method: "POST", path: "/api/watchlists", body: { name: "" } },
      { method: "POST", path: "/api/watchlists", body: { name: "x".repeat(101) } },
      { method: "POST", path: "/api/watchlists", body: {} },
      {
        method: "PUT",
        path: "/api/watchlists/0/items",
        body: { assetClass: "equity", symbol: "AAPL" },
      },
      {
        method: "PUT",
        path: "/api/watchlists/1/items",
        body: { assetClass: "crypto", symbol: "BTC" },
      },
      {
        method: "PUT",
        path: "/api/watchlists/1/items",
        body: { assetClass: "equity", symbol: "bad symbol" },
      },
      { method: "PUT", path: "/api/watchlists/1/order", body: { items: "not-an-array" } },
      { method: "DELETE", path: "/api/watchlists/1/items/equity/bad symbol", body: undefined },
    ];

    for (const requestCase of cases) {
      const response = await handleResearchConsoleRequest(
        jsonRequest(requestCase.method, requestCase.path, requestCase.body),
        { dataDir },
      );
      expect(response.status, `${requestCase.method} ${requestCase.path}`).toBe(400);
    }
  });

  test("returns 404 for mutations on missing watchlists", async () => {
    const { dataDir } = tempDataDir();
    const addResponse = await handleResearchConsoleRequest(
      jsonRequest("PUT", "/api/watchlists/9/items", { assetClass: "equity", symbol: "AAPL" }),
      { dataDir },
    );
    expect(addResponse.status).toBe(404);

    const renameResponse = await handleResearchConsoleRequest(
      jsonRequest("PUT", "/api/watchlists/9", { name: "Tech" }),
      { dataDir },
    );
    expect(renameResponse.status).toBe(404);

    const reorderResponse = await handleResearchConsoleRequest(
      jsonRequest("PUT", "/api/watchlists/9/order", { items: [] }),
      { dataDir },
    );
    expect(reorderResponse.status).toBe(404);
  });

  test("rejects unsupported methods", async () => {
    const { dataDir } = tempDataDir();
    const response = await handleResearchConsoleRequest(jsonRequest("PATCH", "/api/watchlists"), {
      dataDir,
    });
    expect(response.status).toBe(405);
  });

  test("returns 500 when the console db cannot be opened", async () => {
    const { root, dataDir } = tempDataDir();
    writeFileSync(join(root, "console"), "not a directory", "utf8");

    const response = await handleResearchConsoleRequest(
      jsonRequest("POST", "/api/watchlists", { name: "Tech" }),
      { dataDir },
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as { readonly error: string };
    expect(typeof payload.error).toBe("string");
  });
});

describe("watchlist staleness", () => {
  async function detailFor(
    dataDir: string,
    symbol: string,
  ): Promise<
    readonly { readonly symbol: string; readonly row: unknown; readonly staleness: unknown }[]
  > {
    await handleResearchConsoleRequest(jsonRequest("POST", "/api/watchlists", { name: "Tech" }), {
      dataDir,
    });
    await handleResearchConsoleRequest(
      jsonRequest("PUT", "/api/watchlists/1/items", { assetClass: "equity", symbol }),
      { dataDir },
    );
    const detailResponse = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/watchlists/1"),
      { dataDir },
    );
    const payload = (await detailResponse.json()) as {
      readonly watchlist: {
        readonly items: readonly {
          readonly symbol: string;
          readonly row: unknown;
          readonly staleness: unknown;
        }[];
      };
    };
    return payload.watchlist.items;
  }

  test("returns the latest successful run's earnings dates as staleness inputs", async () => {
    const { dataDir } = tempDataDir();
    const dbPath = join(dataDir, "..", "index.sqlite");
    process.env.MARKET_BOT_INDEX_DB_PATH = dbPath;
    writeRun(dataDir, "run-a", {
      runId: "run-a",
      symbol: "AAPL",
      generatedAt: "2026-06-02T00:00:00.000Z",
      extras: { earningsSetup: { event: { date: "2026-06-30" } } },
    });
    writeRun(dataDir, "run-b", {
      runId: "run-b",
      symbol: "AAPL",
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    const detail = await detailFor(dataDir, "aapl");

    expect(detail).toMatchObject([
      {
        symbol: "AAPL",
        staleness: {
          state: "available",
          latestRunAt: "2026-06-02T00:00:00.000Z",
          earningsDates: ["2026-06-30"],
        },
      },
    ]);
  });

  test("returns empty earnings dates when the run has no Finnhub events evidence", async () => {
    const { dataDir } = tempDataDir();
    const dbPath = join(dataDir, "..", "index.sqlite");
    process.env.MARKET_BOT_INDEX_DB_PATH = dbPath;
    writeRun(dataDir, "run-a", {
      runId: "run-a",
      symbol: "AAPL",
      generatedAt: "2026-06-01T00:00:00.000Z",
      extras: { earningsSetup: { expectationBar: [] } },
    });
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    const detail = await detailFor(dataDir, "aapl");

    expect(detail).toMatchObject([
      {
        symbol: "AAPL",
        staleness: {
          state: "available",
          latestRunAt: "2026-06-01T00:00:00.000Z",
          earningsDates: [],
        },
      },
    ]);
  });

  test("skips a failed latest run and uses the newest successful one", async () => {
    const { dataDir } = tempDataDir();
    const dbPath = join(dataDir, "..", "index.sqlite");
    process.env.MARKET_BOT_INDEX_DB_PATH = dbPath;
    writeRun(dataDir, "run-old", {
      runId: "run-old",
      symbol: "AMD",
      generatedAt: "2026-06-01T00:00:00.000Z",
      extras: { earningsSetup: { event: { date: "2026-06-10" } } },
    });
    // A failed run leaves no report, so it carries no symbol in the index.
    writeRun(dataDir, "run-failed", {
      runId: "run-failed",
      symbol: "AMD",
      generatedAt: "2026-06-02T00:00:00.000Z",
      failed: true,
    });
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    const detail = await detailFor(dataDir, "amd");

    expect(detail).toMatchObject([
      {
        symbol: "AMD",
        row: { state: "available", latestRunId: "run-old" },
        staleness: {
          state: "available",
          latestRunAt: "2026-06-01T00:00:00.000Z",
          earningsDates: ["2026-06-10"],
        },
      },
    ]);
  });

  test("declares never-run staleness for a symbol with no runs", async () => {
    const { dataDir } = tempDataDir();
    const dbPath = join(dataDir, "..", "index.sqlite");
    process.env.MARKET_BOT_INDEX_DB_PATH = dbPath;
    await rebuildRunArtifactIndex(dataDir, { dbPath });

    const detail = await detailFor(dataDir, "msft");

    expect(detail).toMatchObject([{ symbol: "MSFT", staleness: { state: "never-run" } }]);
  });

  test("caches the extracted dates in the console db for the next read", async () => {
    const { dataDir } = tempDataDir();
    const dbPath = join(dataDir, "..", "index.sqlite");
    process.env.MARKET_BOT_INDEX_DB_PATH = dbPath;
    writeRun(dataDir, "run-a", {
      runId: "run-a",
      symbol: "AAPL",
      generatedAt: "2026-06-01T00:00:00.000Z",
      extras: { earningsSetup: { event: { date: "2026-06-30" } } },
    });
    await rebuildRunArtifactIndex(dataDir, { dbPath });
    await detailFor(dataDir, "aapl");

    const consoleDb = openConsoleDb(consoleDbPath(dataDir));
    try {
      expect(getRunEarningsDates(consoleDb, "run-a")).toEqual(["2026-06-30"]);
    } finally {
      consoleDb.close();
    }
  });
});
