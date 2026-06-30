export function dataRootFromRunsDir(dataDir: string): string {
  const trimmedDataDir = dataDir.replace(/[\\/]+$/u, "");
  if (trimmedDataDir.split(/[\\/]/u).at(-1) !== "runs") {
    return dataDir;
  }

  const parentDir = trimmedDataDir.replace(/[\\/][^\\/]*$/u, "");
  return parentDir === trimmedDataDir ? "." : parentDir;
}
