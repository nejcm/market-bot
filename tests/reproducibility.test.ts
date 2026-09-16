import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirtySourceHash, effectiveConfigHash } from "../src/reproducibility";

// Under a git hook the inherited location vars would redirect this at the invoking
// Repository, so the fixture repo must be built with them stripped too.
function gitFixtureEnv(): Record<string, string | undefined> {
  const env = { ...Bun.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: gitFixtureEnv(),
    stdout: "ignore",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

describe("reproducibility fingerprints", () => {
  test("changes with effective non-secret configuration", () => {
    const base = {
      provider: "openai",
      quickModel: "quick-a",
      sourceOptions: { apiKey: "secret-a", sourceTimeoutMs: 1000 },
    };

    expect(
      effectiveConfigHash({
        ...base,
        sourceOptions: { ...base.sourceOptions, apiKey: "secret-b" },
      }),
    ).toBe(effectiveConfigHash(base));
    expect(effectiveConfigHash({ ...base, quickModel: "quick-b" })).not.toBe(
      effectiveConfigHash(base),
    );
  });

  test("excludes every known secret-bearing config field from the hash", () => {
    // Pins the SECRET_KEY denylist against the actual secret fields read in src/config.ts.
    // A new secret field added to config without matching the denylist would change the hash
    // (leaking a secret-derived value), and this test would catch it.
    const secretFields = [
      "apiKey",
      "marketauxApiToken",
      "finnhubApiToken",
      "fredApiKey",
      "tradierApiToken",
      "glassnodeApiKey",
      "massiveApiKey",
      "exaApiKey",
      "secUserAgent",
    ] as const;
    const base = Object.fromEntries(secretFields.map((field) => [field, "value-a"]));
    const baseline = effectiveConfigHash(base);
    for (const field of secretFields) {
      expect(effectiveConfigHash({ ...base, [field]: "value-b" })).toBe(baseline);
    }
    // A non-secret token-suffixed field (maxOutputTokens) still affects the hash.
    expect(effectiveConfigHash({ ...base, maxOutputTokens: 1 })).not.toBe(
      effectiveConfigHash({ ...base, maxOutputTokens: 2 }),
    );
  });

  test("changes with dirty source state and excludes ignored secrets", async () => {
    const dir = await mkdtemp(join(tmpdir(), "market-bot-repro-"));
    try {
      await mkdir(join(dir, "src"));
      await Bun.write(join(dir, ".gitignore"), ".env\n");
      await Bun.write(join(dir, "src", "index.ts"), "export const value = 1;\n");
      git(dir, "init", "-q");
      git(dir, "add", ".");
      git(
        dir,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-qm",
        "init",
      );

      await Bun.write(join(dir, "src", "index.ts"), "export const value = 2;\n");
      const first = dirtySourceHash(dir);
      await Bun.write(join(dir, ".env"), "TOKEN=secret-a\n");
      expect(dirtySourceHash(dir)).toBe(first);

      await Bun.write(join(dir, "src", "index.ts"), "export const value = 3;\n");
      expect(dirtySourceHash(dir)).not.toBe(first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("describes the repository at cwd when git hook location vars are set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "market-bot-repro-"));
    const outer = await mkdtemp(join(tmpdir(), "market-bot-outer-"));
    try {
      await mkdir(join(dir, "src"));
      await Bun.write(join(dir, "src", "index.ts"), "export const value = 1;\n");
      git(dir, "init", "-q");
      git(dir, "add", ".");
      git(
        dir,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-qm",
        "init",
      );
      await Bun.write(join(dir, "src", "index.ts"), "export const value = 2;\n");
      const expected = dirtySourceHash(dir);
      expect(expected).toBeDefined();

      await Bun.write(join(outer, "other.ts"), "export const other = 1;\n");
      git(outer, "init", "-q");

      // The location vars only redirect git when the child inherits them at launch, which is
      // How a git hook invokes this; setting them in-process would not reproduce it.
      const module = join(import.meta.dir, "..", "src", "reproducibility.ts");
      const child = Bun.spawnSync(
        [
          "bun",
          "-e",
          `import { dirtySourceHash } from ${JSON.stringify(module)};
console.log(dirtySourceHash(${JSON.stringify(dir)}) ?? "undefined");`,
        ],
        {
          env: { ...Bun.env, GIT_DIR: join(outer, ".git"), GIT_WORK_TREE: outer },
          stdout: "pipe",
          stderr: "pipe",
        },
      );

      expect(child.exitCode).toBe(0);
      expect(new TextDecoder().decode(child.stdout).trim()).toBe(expected ?? "");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outer, { recursive: true, force: true });
    }
  });
});
