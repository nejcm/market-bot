import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addStar, consoleDbPath, listStars, openConsoleDb, removeStar } from "../app/console-db";
import { handleResearchConsoleRequest } from "../app/server";
import { rebuildRunArtifactIndex } from "../src/run-artifact-index";
import { researchReport } from "./support/fixtures";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "research-console-stars-"));
}

function jsonRequest(method: string, body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://127.0.0.1/api/stars", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("console db", () => {
  test("derives the console db path beside the data root", () => {
    expect(consoleDbPath("data/runs")).toBe(join("data", "console", "console.sqlite"));
    expect(consoleDbPath(join("mnt", "bot", "runs"))).toBe(
      join("mnt", "bot", "console", "console.sqlite"),
    );
    const bare = join("tmp", "elsewhere");
    expect(consoleDbPath(bare)).toBe(join(bare, "console", "console.sqlite"));
  });

  test("creates the file and table, listing empty", () => {
    const dbPath = join(tempDataDir(), "console", "console.sqlite");
    const db = openConsoleDb(dbPath);
    try {
      expect(existsSync(dbPath)).toBe(true);
      expect(listStars(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("adds and lists stars, keeping the first created_at on repeat", () => {
    const dbPath = join(tempDataDir(), "console", "console.sqlite");
    const db = openConsoleDb(dbPath);
    try {
      const first = addStar(db, "run", "run-1");
      const repeat = addStar(db, "run", "run-1");
      addStar(db, "instrument", "equity:AAPL");

      expect(repeat).toEqual(first);
      expect(new Date(first.createdAt).getTime()).not.toBeNaN();
      expect(
        listStars(db)
          .map((star) => `${star.kind}:${star.key}`)
          .toSorted(),
      ).toEqual(["instrument:equity:AAPL", "run:run-1"]);
    } finally {
      db.close();
    }
  });

  test("removes stars and reports whether a row was deleted", () => {
    const dbPath = join(tempDataDir(), "console", "console.sqlite");
    const db = openConsoleDb(dbPath);
    try {
      addStar(db, "run", "run-1");

      expect(removeStar(db, "run", "run-1")).toBe(true);
      expect(removeStar(db, "run", "run-1")).toBe(false);
      expect(removeStar(db, "instrument", "equity:AAPL")).toBe(false);
      expect(listStars(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("research console app star API", () => {
  test("reads empty without creating the db file", async () => {
    const dataDir = tempDataDir();

    const response = await handleResearchConsoleRequest(new Request("http://127.0.0.1/api/stars"), {
      dataDir,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ stars: [] });
    expect(existsSync(join(dataDir, "console", "console.sqlite"))).toBe(false);
  });

  test("round-trips stars through put, list, and delete", async () => {
    const dataDir = tempDataDir();

    const putResponse = await handleResearchConsoleRequest(
      jsonRequest("PUT", { kind: "instrument", key: "equity:AAPL" }),
      { dataDir },
    );
    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toMatchObject({
      kind: "instrument",
      key: "equity:AAPL",
    });

    const listResponse = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/stars"),
      { dataDir },
    );
    await expect(listResponse.json()).resolves.toMatchObject({
      stars: [{ kind: "instrument", key: "equity:AAPL" }],
    });

    const deleteResponse = await handleResearchConsoleRequest(
      jsonRequest("DELETE", { kind: "instrument", key: "equity:AAPL" }),
      { dataDir },
    );
    await expect(deleteResponse.json()).resolves.toEqual({ removed: true });

    const emptyResponse = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/stars"),
      { dataDir },
    );
    await expect(emptyResponse.json()).resolves.toEqual({ stars: [] });
  });

  test("marks a starred run missing when its directory is gone", async () => {
    const dataDir = tempDataDir();
    mkdirSync(join(dataDir, "run-live"));

    await handleResearchConsoleRequest(jsonRequest("PUT", { kind: "run", key: "run-live" }), {
      dataDir,
    });
    await handleResearchConsoleRequest(jsonRequest("PUT", { kind: "run", key: "run-gone" }), {
      dataDir,
    });

    const response = await handleResearchConsoleRequest(new Request("http://127.0.0.1/api/stars"), {
      dataDir,
    });
    const payload = (await response.json()) as {
      readonly stars: readonly {
        readonly kind: string;
        readonly key: string;
        readonly createdAt: string;
        readonly missing?: boolean;
      }[];
    };

    expect(response.status).toBe(200);
    expect(payload.stars).toContainEqual({
      key: "run-live",
      kind: "run",
      createdAt: expect.anything(),
    });
    expect(payload.stars.find((star) => star.key === "run-gone")?.missing).toBe(true);
    expect(payload.stars.find((star) => star.key === "run-live")?.missing).toBeUndefined();
  });

  test("rejects cross-origin mutations", async () => {
    const dataDir = tempDataDir();

    const response = await handleResearchConsoleRequest(
      jsonRequest("PUT", { kind: "run", key: "run-1" }, { origin: "http://evil.example" }),
      { dataDir },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Star request origin is not allowed" });
  });

  test("rejects cross-site mutations signalled by fetch metadata", async () => {
    const dataDir = tempDataDir();

    const response = await handleResearchConsoleRequest(
      jsonRequest("DELETE", { kind: "run", key: "run-1" }, { "sec-fetch-site": "cross-site" }),
      { dataDir },
    );

    expect(response.status).toBe(403);
  });

  test("rejects malformed star requests", async () => {
    const dataDir = tempDataDir();
    const invalidBodies = [
      {},
      { kind: "watchlist", key: "w-1" },
      { kind: "run", key: "" },
      { kind: "run", key: "run/../secret" },
      { kind: "run", key: "a\\b" },
      { kind: "run", key: "run:1" },
      { kind: "run", key: "x".repeat(201) },
      { kind: "instrument", key: "forex:EURUSD" },
      { kind: "instrument", key: "equity:bad symbol" },
      { kind: "instrument", key: "equity" },
    ];

    for (const body of invalidBodies) {
      const response = await handleResearchConsoleRequest(jsonRequest("PUT", body), { dataDir });
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid star request" });
    }
  });

  test("rejects non-JSON star bodies", async () => {
    const dataDir = tempDataDir();
    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/stars", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      { dataDir },
    );

    expect(response.status).toBe(400);
  });

  test("returns 500 when the console db cannot be opened", async () => {
    const dataDir = tempDataDir();
    writeFileSync(join(dataDir, "console"), "not a directory", "utf8");

    const response = await handleResearchConsoleRequest(
      jsonRequest("PUT", { kind: "run", key: "run-1" }),
      { dataDir },
    );

    expect(response.status).toBe(500);
    const payload = (await response.json()) as { readonly error: string };
    expect(typeof payload.error).toBe("string");
  });

  test("returns 500 on GET when the console db is corrupt", async () => {
    const dataDir = tempDataDir();
    const dbPath = consoleDbPath(dataDir);
    mkdirSync(join(dbPath, ".."), { recursive: true });
    writeFileSync(dbPath, "not a sqlite database", "utf8");

    const response = await handleResearchConsoleRequest(new Request("http://localhost/api/stars"), {
      dataDir,
    });

    expect(response.status).toBe(500);
  });

  test("rejects unsupported methods", async () => {
    const dataDir = tempDataDir();

    const response = await handleResearchConsoleRequest(
      jsonRequest("POST", { kind: "run", key: "run-1" }),
      { dataDir },
    );

    expect(response.status).toBe(405);
  });

  test("attaches staleness inputs to instrument stars", async () => {
    const root = tempDataDir();
    const dataDir = join(root, "runs");
    mkdirSync(dataDir);
    const runDir = join(dataDir, "run-a");
    mkdirSync(runDir);
    writeFileSync(
      join(runDir, "report.json"),
      `${JSON.stringify(
        researchReport({
          runId: "run-a",
          jobType: "equity",
          assetClass: "equity",
          symbol: "AMD",
          generatedAt: "2026-06-01T00:00:00.000Z",
          extras: { earningsSetup: { event: { date: "2026-06-30" } } },
        }),
      )}\n`,
      "utf8",
    );
    writeFileSync(join(runDir, "report.md"), "# Report\n", "utf8");

    const originalIndexDbPath = process.env.MARKET_BOT_INDEX_DB_PATH;
    process.env.MARKET_BOT_INDEX_DB_PATH = join(root, "index.sqlite");
    try {
      await rebuildRunArtifactIndex(dataDir, { dbPath: process.env.MARKET_BOT_INDEX_DB_PATH });
      await handleResearchConsoleRequest(
        jsonRequest("PUT", { kind: "instrument", key: "equity:AMD" }),
        { dataDir },
      );
      await handleResearchConsoleRequest(jsonRequest("PUT", { kind: "run", key: "run-a" }), {
        dataDir,
      });

      const response = await handleResearchConsoleRequest(
        new Request("http://127.0.0.1/api/stars"),
        { dataDir },
      );
      const payload = (await response.json()) as {
        readonly stars: readonly {
          readonly kind: string;
          readonly key: string;
          readonly staleness?: unknown;
        }[];
      };

      expect(payload.stars.find((star) => star.kind === "instrument")).toMatchObject({
        kind: "instrument",
        key: "equity:AMD",
        staleness: {
          state: "available",
          latestRunAt: "2026-06-01T00:00:00.000Z",
          earningsDates: ["2026-06-30"],
        },
      });
      expect(payload.stars.find((star) => star.kind === "run")?.staleness).toBeUndefined();
    } finally {
      if (originalIndexDbPath === undefined) {
        delete process.env.MARKET_BOT_INDEX_DB_PATH;
      } else {
        process.env.MARKET_BOT_INDEX_DB_PATH = originalIndexDbPath;
      }
    }
  });
});
