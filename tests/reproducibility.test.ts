import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dirtySourceHash, effectiveConfigHash } from "../src/reproducibility";

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
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
});
