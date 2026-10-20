import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPin, consoleDbPath, listPins, openConsoleDb, removePin } from "../app/console-db";
import { handleResearchConsoleRequest } from "../app/server";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "research-console-pins-"));
}

function jsonRequest(method: string, body: unknown, headers?: Record<string, string>): Request {
  return new Request("http://127.0.0.1/api/pins", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("console db pins", () => {
  test("adds, lists, and removes pins, keeping the first created_at on repeat", () => {
    const db = openConsoleDb(join(tempDataDir(), "console", "console.sqlite"));
    try {
      expect(listPins(db)).toEqual([]);
      const first = addPin(db, "run-1");
      expect(addPin(db, "run-1")).toEqual(first);
      expect(new Date(first.createdAt).getTime()).not.toBeNaN();
      addPin(db, "run-2");
      expect(
        listPins(db)
          .map((pin) => pin.runId)
          .toSorted(),
      ).toEqual(["run-1", "run-2"]);

      expect(removePin(db, "run-1")).toBe(true);
      expect(removePin(db, "run-1")).toBe(false);
      expect(listPins(db).map((pin) => pin.runId)).toEqual(["run-2"]);
    } finally {
      db.close();
    }
  });
});

describe("research console app pin API", () => {
  test("reads empty without creating the db file", async () => {
    const dataDir = tempDataDir();

    const response = await handleResearchConsoleRequest(new Request("http://127.0.0.1/api/pins"), {
      dataDir,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ pins: [] });
    expect(existsSync(consoleDbPath(dataDir))).toBe(false);
  });

  test("round-trips pins and marks a pinned run missing when its directory is gone", async () => {
    const dataDir = tempDataDir();
    mkdirSync(join(dataDir, "run-live"));

    const putResponse = await handleResearchConsoleRequest(
      jsonRequest("PUT", { runId: " run-live " }),
      { dataDir },
    );
    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toMatchObject({ runId: "run-live" });
    await handleResearchConsoleRequest(jsonRequest("PUT", { runId: "run-gone" }), { dataDir });

    const listResponse = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/pins"),
      { dataDir },
    );
    const payload = (await listResponse.json()) as {
      readonly pins: readonly { readonly runId: string; readonly missing?: boolean }[];
    };
    expect(payload.pins.find((pin) => pin.runId === "run-live")?.missing).toBeUndefined();
    expect(payload.pins.find((pin) => pin.runId === "run-gone")?.missing).toBe(true);

    const deleteResponse = await handleResearchConsoleRequest(
      jsonRequest("DELETE", { runId: "run-gone" }),
      { dataDir },
    );
    await expect(deleteResponse.json()).resolves.toEqual({ removed: true });
    const afterDelete = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/pins"),
      { dataDir },
    );
    await expect(afterDelete.json()).resolves.toMatchObject({ pins: [{ runId: "run-live" }] });
  });

  test("rejects cross-origin and cross-site mutations", async () => {
    const dataDir = tempDataDir();

    const crossOrigin = await handleResearchConsoleRequest(
      jsonRequest("PUT", { runId: "run-1" }, { origin: "http://evil.example" }),
      { dataDir },
    );
    expect(crossOrigin.status).toBe(403);
    await expect(crossOrigin.json()).resolves.toEqual({
      error: "Pin request origin is not allowed",
    });

    const crossSite = await handleResearchConsoleRequest(
      jsonRequest("DELETE", { runId: "run-1" }, { "sec-fetch-site": "cross-site" }),
      { dataDir },
    );
    expect(crossSite.status).toBe(403);
    expect(existsSync(consoleDbPath(dataDir))).toBe(false);
  });

  test("rejects malformed pin requests", async () => {
    const dataDir = tempDataDir();
    const invalidBodies = [
      {},
      { runId: 7 },
      { runId: "" },
      { runId: "run/../secret" },
      { runId: "a\\b" },
      { runId: "run:1" },
      { runId: "x".repeat(201) },
    ];

    for (const body of invalidBodies) {
      const response = await handleResearchConsoleRequest(jsonRequest("PUT", body), { dataDir });
      expect(response.status, JSON.stringify(body)).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "Invalid pin request" });
    }

    const nonJson = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/pins", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
      { dataDir },
    );
    expect(nonJson.status).toBe(400);
    expect(existsSync(consoleDbPath(dataDir))).toBe(false);
  });

  test("rejects unsupported methods", async () => {
    const response = await handleResearchConsoleRequest(jsonRequest("POST", { runId: "run-1" }), {
      dataDir: tempDataDir(),
    });

    expect(response.status).toBe(405);
  });

  test("returns 500 when the console db is corrupt or cannot be opened", async () => {
    const corruptDir = tempDataDir();
    const dbPath = consoleDbPath(corruptDir);
    mkdirSync(join(dbPath, ".."), { recursive: true });
    writeFileSync(dbPath, "not a sqlite database", "utf8");
    const corruptGet = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/pins"),
      { dataDir: corruptDir },
    );
    expect(corruptGet.status).toBe(500);

    const blockedDir = tempDataDir();
    writeFileSync(join(blockedDir, "console"), "not a directory", "utf8");
    const blockedPut = await handleResearchConsoleRequest(jsonRequest("PUT", { runId: "run-1" }), {
      dataDir: blockedDir,
    });
    expect(blockedPut.status).toBe(500);
    expect(typeof ((await blockedPut.json()) as { readonly error: unknown }).error).toBe("string");
  });
});
