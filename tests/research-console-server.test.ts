import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResearchConsoleRequest, researchConsoleStaticPath } from "../app/server";
import { researchReport } from "./support/fixtures";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("research console static assets", () => {
  test("resolves built files under dist", () => {
    const distDir = mkdtempSync(join(tmpdir(), "research-console-dist-"));
    const assetDir = join(distDir, "assets");
    mkdirSync(assetDir);
    const assetPath = join(assetDir, "index.js");
    writeFileSync(assetPath, "export {};\n", "utf8");

    expect(researchConsoleStaticPath("/assets/index.js", distDir)).toBe(assetPath);
  });

  test("falls back to index for client routes", () => {
    const distDir = mkdtempSync(join(tmpdir(), "research-console-dist-"));
    const indexPath = join(distDir, "index.html");
    writeFileSync(indexPath, "<main></main>\n", "utf8");

    expect(researchConsoleStaticPath("/runs/abc", distDir)).toBe(indexPath);
  });

  test("rejects paths outside dist", () => {
    const distDir = mkdtempSync(join(tmpdir(), "research-console-dist-"));
    writeFileSync(join(distDir, "index.html"), "<main></main>\n", "utf8");

    expect(researchConsoleStaticPath("/../secret.txt", distDir)).toBeUndefined();
    expect(researchConsoleStaticPath("/%2e%2e/secret.txt", distDir)).toBeUndefined();
  });
});

describe("research console API", () => {
  test("serves run summaries", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-1");
    mkdirSync(runDir);
    writeJson(join(runDir, "report.json"), researchReport({ runId: "run-1", summary: "Summary" }));

    const response = await handleResearchConsoleRequest(new Request("http://127.0.0.1/api/runs"), {
      dataDir,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      runs: [{ runId: "run-1", findingCount: 0, predictionCount: 0 }],
    });
  });

  test("serves run detail", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-2");
    mkdirSync(runDir);
    writeJson(join(runDir, "report.json"), researchReport({ runId: "run-2", summary: "Detail" }));

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/runs/run-2"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      summary: { runId: "run-2" },
      report: { summary: "Detail" },
    });
  });

  test("returns not found for missing runs", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/runs/missing"),
      { dataDir },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Run not found" });
  });

  test("serves provider health", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "research-console-data-"));
    const dataDir = join(rootDir, "runs");
    const healthDir = join(rootDir, "provider-health");
    mkdirSync(dataDir);
    mkdirSync(healthDir);
    writeJson(join(healthDir, "summary.json"), { verdict: "warn" });
    writeFileSync(join(healthDir, "summary.md"), "# Health\n", "utf8");

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/provider-health"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      summary: { verdict: "warn" },
      markdown: "# Health\n",
    });
  });

  test("serves run files by safe relative path", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-3");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    writeFileSync(join(runDir, "normalized", "source-gaps.json"), "[]\n", "utf8");

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/runs/run-3/files?path=normalized%2Fsource-gaps.json"),
      { dataDir },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      path: "normalized/source-gaps.json",
      content: "[]\n",
    });
  });

  test("rejects unsafe run file paths", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-4");
    mkdirSync(runDir);

    const response = await handleResearchConsoleRequest(
      new Request("http://127.0.0.1/api/runs/run-4/files?path=..%2Fsecret.txt"),
      { dataDir },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "File not found" });
  });
});
