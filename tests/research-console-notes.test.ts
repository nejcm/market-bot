import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRunDetail, searchRunReports } from "../app/artifacts";
import { buildRunChatContext } from "../app/chat-context";
import { consoleDbPath, openConsoleDb } from "../app/console-db";
import { handleResearchConsoleRequest } from "../app/server";
import { RUN_NOTE_MAX_LENGTH, type RunNote } from "../app/types";
import { rebuildHistoryArtifacts, searchHistoryIndex } from "../src/history/artifacts";
import { rebuildRunArtifactIndex } from "../src/run-artifact-index";
import { researchReport } from "./support/fixtures";

function tempDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "research-console-notes-"));
  const dataDir = join(root, "runs");
  mkdirSync(dataDir);
  return dataDir;
}

function getRequest(kind = "run", key = "run-1"): Request {
  return new Request(`http://127.0.0.1/api/notes?${new URLSearchParams({ kind, key })}`);
}

function putRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1/api/notes", {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("Run Notes API", () => {
  test("reads absent storage without creating a file or directory", async () => {
    const dataDir = tempDataDir();
    const response = await handleResearchConsoleRequest(getRequest(), { dataDir });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ note: null });
    expect(existsSync(join(dataDir, "..", "console"))).toBe(false);
  });

  test("persists separate run and instrument notes, updates, and deletes only empty text", async () => {
    const dataDir = tempDataDir();
    const targets = [
      { kind: "run", key: "run-1" },
      { kind: "instrument", key: "equity:AAPL" },
    ];
    const body = "  <script>alert('private')</script>\n**plain text** & whitespace  ";
    for (const target of targets) {
      const put = await handleResearchConsoleRequest(putRequest({ ...target, body }), { dataDir });
      expect(put.status).toBe(200);
      const payload = (await put.json()) as { readonly note: RunNote };
      expect(payload.note).toMatchObject({ ...target, body });
      expect(Number.isFinite(Date.parse(payload.note.updatedAt))).toBe(true);
      const get = await handleResearchConsoleRequest(getRequest(target.kind, target.key), {
        dataDir,
      });
      await expect(get.json()).resolves.toEqual(payload);
    }
    const target = targets[0]!;
    for (const nextBody of [" ", "x".repeat(RUN_NOTE_MAX_LENGTH), ""]) {
      const response = await handleResearchConsoleRequest(
        putRequest({ ...target, body: nextBody }),
        { dataDir },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        note: nextBody === "" ? null : { body: nextBody },
      });
    }
    const deleted = await handleResearchConsoleRequest(getRequest(), { dataDir });
    await expect(deleted.json()).resolves.toEqual({ note: null });
    const retained = await handleResearchConsoleRequest(getRequest("instrument", "equity:AAPL"), {
      dataDir,
    });
    await expect(retained.json()).resolves.toMatchObject({ note: { body } });
    const db = openConsoleDb(consoleDbPath(dataDir));
    try {
      expect(db.query("SELECT COUNT(*) AS count FROM notes").get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("rejects invalid targets and bodies without creating storage", async () => {
    const dataDir = tempDataDir();
    const invalidTargets = [
      { kind: "watchlist", key: "1" },
      { kind: "run", key: "" },
      { kind: "run", key: "a/../b" },
      { kind: "run", key: "a\\b" },
      { kind: "run", key: "run:1" },
      { kind: "run", key: "x".repeat(201) },
      { kind: "instrument", key: "equity" },
      { kind: "instrument", key: "forex:EURUSD" },
      { kind: "instrument", key: "equity:bad symbol" },
    ];
    for (const target of invalidTargets) {
      for (const request of [
        getRequest(target.kind, target.key),
        putRequest({ ...target, body: "note" }),
      ]) {
        const response = await handleResearchConsoleRequest(request, { dataDir });
        expect(response.status).toBe(400);
      }
    }
    for (const body of [
      {},
      null,
      { kind: "run", key: "run-1" },
      { kind: "run", key: "run-1", body: 1 },
      { kind: "run", key: "run-1", body: "x".repeat(RUN_NOTE_MAX_LENGTH + 1) },
    ]) {
      const response = await handleResearchConsoleRequest(putRequest(body), { dataDir });
      expect(response.status).toBe(400);
    }
    const malformed = new Request("http://127.0.0.1/api/notes", { method: "PUT", body: "{" });
    const malformedResponse = await handleResearchConsoleRequest(malformed, { dataDir });
    expect(malformedResponse.status).toBe(400);
    const missingTarget = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/notes"),
      { dataDir },
    );
    expect(missingTarget.status).toBe(400);
    expect(existsSync(consoleDbPath(dataDir))).toBe(false);
  });

  test("gates mutations by origin and method", async () => {
    const dataDir = tempDataDir();
    for (const headers of [{ origin: "http://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
      const response = await handleResearchConsoleRequest(
        putRequest({ kind: "run", key: "run-1", body: "private" }, headers),
        { dataDir },
      );
      expect(response.status).toBe(403);
    }
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const response = await handleResearchConsoleRequest(
        new Request("http://127.0.0.1/api/notes", { method }),
        { dataDir },
      );
      expect(response.status).toBe(405);
    }
    expect(existsSync(consoleDbPath(dataDir))).toBe(false);
  });

  test("isolates locked storage errors and retains the saved note after failure", async () => {
    const dataDir = tempDataDir();
    const target = { kind: "run", key: "run-1" };
    await handleResearchConsoleRequest(putRequest({ ...target, body: "saved" }), { dataDir });
    const db = openConsoleDb(consoleDbPath(dataDir));
    db.exec("BEGIN EXCLUSIVE");
    try {
      for (const request of [getRequest(), putRequest({ ...target, body: "replacement" })]) {
        const response = await handleResearchConsoleRequest(request, { dataDir });
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
      }
      const runsResponse = await handleResearchConsoleRequest(
        new Request("http://127.0.0.1/api/runs"),
        { dataDir },
      );
      expect(runsResponse.status).toBe(200);
    } finally {
      db.exec("ROLLBACK");
      db.close();
    }
    const response = await handleResearchConsoleRequest(getRequest(), { dataDir });
    await expect(response.json()).resolves.toMatchObject({ note: { body: "saved" } });
  });

  test("returns an error for unusable storage while run browsing still works", async () => {
    const dataDir = tempDataDir();
    mkdirSync(consoleDbPath(dataDir), { recursive: true });
    for (const request of [getRequest(), putRequest({ kind: "run", key: "run-1", body: "note" })]) {
      const response = await handleResearchConsoleRequest(request, { dataDir });
      expect(response.status).toBe(500);
    }
    const runsResponse = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/runs"),
      { dataDir },
    );
    expect(runsResponse.status).toBe(200);
  });

  test("reports unwritable storage without losing the saved note", async () => {
    const dataDir = tempDataDir();
    const target = { kind: "run", key: "run-1" };
    await handleResearchConsoleRequest(putRequest({ ...target, body: "saved" }), { dataDir });
    const dbPath = consoleDbPath(dataDir);
    chmodSync(dbPath, 0o444);
    try {
      const response = await handleResearchConsoleRequest(putRequest({ ...target, body: "" }), {
        dataDir,
      });
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ error: expect.any(String) });
    } finally {
      chmodSync(dbPath, 0o644);
    }
    const response = await handleResearchConsoleRequest(getRequest(), { dataDir });
    await expect(response.json()).resolves.toMatchObject({ note: { body: "saved" } });
  });

  test("never sends stored notes into Run Chat, exports, or either history search index", async () => {
    const dataDir = tempDataDir();
    const runDir = join(dataDir, "run-1");
    mkdirSync(runDir);
    const report = researchReport({
      runId: "run-1",
      jobType: "equity",
      assetClass: "equity",
      symbol: "AAPL",
      summary: "Public research summary",
    });
    const reportJson = JSON.stringify(report);
    const markdown = "# Public research summary\n";
    writeFileSync(join(runDir, "report.json"), reportJson);
    writeFileSync(join(runDir, "report.md"), markdown);
    const before = await readRunDetail(dataDir, "run-1");
    expect(before).toBeDefined();
    const markers = ["PrivateRunSentinel9x", "PrivateInstrumentSentinel7z"];
    for (const [index, target] of [
      { kind: "run", key: "run-1" },
      { kind: "instrument", key: "equity:AAPL" },
    ].entries()) {
      const response = await handleResearchConsoleRequest(
        putRequest({ ...target, body: markers[index] }),
        { dataDir },
      );
      expect(response.status).toBe(200);
    }
    const after = await readRunDetail(dataDir, "run-1");
    expect(after).toEqual(before);
    expect(buildRunChatContext(after!)).toBe(buildRunChatContext(before!));
    expect(readFileSync(join(runDir, "report.json"), "utf8")).toBe(reportJson);
    expect(readFileSync(join(runDir, "report.md"), "utf8")).toBe(markdown);

    await rebuildHistoryArtifacts(dataDir);
    const historyIndex = readFileSync(join(dataDir, "..", "history", "index.json"), "utf8");
    expect(historyIndex).toContain("Public research summary");
    for (const marker of markers) {
      expect(buildRunChatContext(after!)).not.toContain(marker);
      expect(historyIndex).not.toContain(marker);
      expect(await searchHistoryIndex(dataDir, { query: marker })).toEqual([]);
    }
    await rebuildRunArtifactIndex(dataDir);
    expect(await searchHistoryIndex(dataDir, { query: "Public research summary" })).not.toEqual([]);
    for (const marker of markers) {
      expect(await searchHistoryIndex(dataDir, { query: marker })).toEqual([]);
      expect(await searchRunReports(dataDir, { query: marker })).toEqual([]);
    }
    const note = await handleResearchConsoleRequest(getRequest(), { dataDir });
    await expect(note.json()).resolves.toMatchObject({ note: { body: markers[0] } });
  });
});
