import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dataRootFromRunsDir, listRunDirNames } from "../src/data-paths";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "data-paths-test-"));
  tmpDirs.push(dir);
  return dir;
}

function writeFile(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "{}\n", "utf8");
}

describe("listRunDirNames", () => {
  test("keeps report and failed runs and skips shared-state and hidden dirs", async () => {
    const dataDir = tempDir();
    for (const shared of ["alpha-search", "alpha-validation", "cache", "console", "history"]) {
      mkdirSync(join(dataDir, shared));
    }
    writeFile(join(dataDir, "calibration", "summary.json"));
    writeFile(join(dataDir, "provider-health", "summary.json"));
    writeFile(join(dataDir, "run-ok", "report.json"));
    writeFile(join(dataDir, "run-failed", "failure.json"));
    writeFile(join(dataDir, ".runs-x.partial", "report.json"));
    writeFile(join(dataDir, "index.sqlite"));

    await expect(listRunDirNames(dataDir)).resolves.toEqual(["run-failed", "run-ok"]);
  });

  test.skipIf(process.getuid?.() === 0)("keeps a run dir whose marker cannot be read", async () => {
    const dataDir = tempDir();
    writeFile(join(dataDir, "run-ok", "report.json"));
    mkdirSync(join(dataDir, "run-locked"));
    chmodSync(join(dataDir, "run-locked"), 0o000);
    try {
      await expect(listRunDirNames(dataDir)).resolves.toEqual(["run-locked", "run-ok"]);
    } finally {
      chmodSync(join(dataDir, "run-locked"), 0o700);
    }
  });

  test("returns [] when the data dir does not exist", async () => {
    await expect(listRunDirNames(join(tempDir(), "missing"))).resolves.toEqual([]);
  });

  test("rethrows a read error that is not ENOENT", async () => {
    const notADir = join(tempDir(), "runs");
    writeFile(notADir);

    await expect(listRunDirNames(notADir)).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("dataRootFromRunsDir", () => {
  test("returns parent for POSIX runs directory", () => {
    expect(dataRootFromRunsDir("data/runs")).toBe("data");
  });

  test("returns parent for Windows runs directory", () => {
    expect(dataRootFromRunsDir(String.raw`C:\data\runs`)).toBe(String.raw`C:\data`);
  });

  test("handles trailing separators", () => {
    const windowsRunsDir = String.raw`C:\data\runs`;

    expect(dataRootFromRunsDir("data/runs/")).toBe("data");
    expect(dataRootFromRunsDir(`${windowsRunsDir}\\`)).toBe(String.raw`C:\data`);
  });

  test("returns the filesystem root for a top-level runs directory", () => {
    expect(dataRootFromRunsDir("/runs")).toBe("/");
    expect(dataRootFromRunsDir("runs")).toBe(".");
  });

  test("returns non-runs directory unchanged", () => {
    expect(dataRootFromRunsDir("data/archive")).toBe("data/archive");
  });
});
