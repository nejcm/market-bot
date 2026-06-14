import { basename, dirname, join } from "node:path";

export function dataRootFromRunsDir(dataDir: string): string {
  return basename(dataDir) === "runs" ? dirname(dataDir) : dataDir;
}

export function joinDataRoot(dataDir: string, ...segments: readonly string[]): string {
  return join(dataRootFromRunsDir(dataDir), ...segments);
}
