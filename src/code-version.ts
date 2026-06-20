import type { CodeVersion } from "./domain/types";

export type { CodeVersion };

function gitOutput(args: readonly string[], cwd: string): string | undefined {
  try {
    const result = Bun.spawnSync(["git", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      return undefined;
    }
    const output = new TextDecoder().decode(result.stdout).trim();
    return output === "" ? undefined : output;
  } catch {
    return undefined;
  }
}

export function readCodeVersion(cwd: string = process.cwd()): CodeVersion {
  const branch = gitOutput(["branch", "--show-current"], cwd);
  const commit = gitOutput(["rev-parse", "HEAD"], cwd);
  const dirtyOutput = gitOutput(["status", "--porcelain"], cwd);
  return {
    ...(branch !== undefined ? { branch } : {}),
    ...(commit !== undefined ? { commit, commitShort: commit.slice(0, 12) } : {}),
    dirty: dirtyOutput !== undefined && dirtyOutput.length > 0,
  };
}
