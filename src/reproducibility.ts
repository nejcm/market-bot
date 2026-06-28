import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Denylist of secret-bearing config field names, excluded from the reproducibility hash.
// A denylist (rather than a whitelist of hashed fields) is deliberate: an unknown future
// Config field defaults to being *included* in the hash, which is the safe bias for a
// Reproducibility fingerprint. Patterns stay narrow enough to avoid catching legitimate
// Fields such as `maxOutputTokens` (no `api`/`access` prefix). The exclusion guarantee for
// Every known secret field is pinned by tests/reproducibility.test.ts.
const SECRET_KEY =
  /(api[-_]?key|api[-_]?token|access[-_]?token|password|secret|credential|bearer|private[-_]?key|user[-_]?agent)/iu;
const SAFE_UNTRACKED_PATH =
  /^(?:src|tests|scripts|app|prompts|docs|research)[/\\]|^(?:CONTEXT|README|package|tsconfig|oxfmt|oxlint)\b/iu;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function nonSecretValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => nonSecretValue(item));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, nonSecretValue(nested)]),
  );
}

export function effectiveConfigHash(config: unknown): string {
  return sha256(JSON.stringify(nonSecretValue(config)));
}

function gitOutput(args: readonly string[], cwd: string): string | undefined {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return undefined;
  }
  return new TextDecoder().decode(result.stdout);
}

export function dirtySourceHash(cwd: string = process.cwd()): string | undefined {
  const status = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  if (status === undefined || status.trim() === "") {
    return undefined;
  }
  const trackedDiff = gitOutput(["diff", "--no-ext-diff", "--binary", "HEAD", "--"], cwd) ?? "";
  const untracked =
    gitOutput(["ls-files", "--others", "--exclude-standard"], cwd)
      ?.split(/\r?\n/u)
      .filter((path) => path !== "" && SAFE_UNTRACKED_PATH.test(path))
      .toSorted() ?? [];
  const untrackedContent = untracked.map((path) => {
    try {
      return `${path}\0${sha256(readFileSync(resolve(cwd, path)))}`;
    } catch {
      return `${path}\0unreadable`;
    }
  });
  return sha256([status, trackedDiff, ...untrackedContent].join("\0"));
}
