import { describe, expect, test } from "bun:test";

import { dataRootFromRunsDir } from "../src/data-paths";

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

  test("returns non-runs directory unchanged", () => {
    expect(dataRootFromRunsDir("data/archive")).toBe("data/archive");
  });
});
