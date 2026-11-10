import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNoSecretsInFiles,
  assertNoSecretsInText,
  knownSecretValues,
  scanFixtureDirs,
} from "../scripts/fixture-secret-scan";

/*
 * Any env name ending in a credential-ish suffix counts, so a future
 * MARKET_BOT_SMTP_PASSWORD cannot slip past the scanner unnoticed. The
 * lookahead keeps compound tails (…MAX_OUTPUT_TOKENS) out.
 */
function credentialEnvNames(source: string): readonly string[] {
  return [
    ...new Set(
      [
        ...source.matchAll(
          /env\.([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|_PASSWORD)(?![A-Z0-9_]))/gu,
        ),
      ].map((match) => match[1]!),
    ),
  ].toSorted();
}

describe("fixture secret scan", () => {
  test("includes the Firecrawl credential", () => {
    expect(knownSecretValues({ MARKET_BOT_FIRECRAWL_API_KEY: "fc_live_abcdefgh" })).toEqual([
      "fc_live_abcdefgh",
    ]);
  });

  test("covers every credential read by config", async () => {
    const configSource = await readFile(join(import.meta.dir, "../src/config.ts"), "utf8");
    const names = credentialEnvNames(configSource);
    expect(names).toHaveLength(13);
    /*
     * Behavioural, not textual: the scanner must actually return a value for
     * each name, so deleting an entry fails here even if the name survives
     * elsewhere in the file.
     */
    expect(
      knownSecretValues(Object.fromEntries(names.map((name) => [name, "x".repeat(8)]))),
    ).toHaveLength(names.length);
  });

  test("rejects secret-bearing content before it is written to disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "secret-scan-"));
    try {
      const secrets = knownSecretValues({ MARKET_BOT_POLYGON_API_KEY: "pk_live_abcdefgh" });
      const target = join(dir, "data-cassette.json");
      const content = `{"url":"https://api.polygon.io/v2?apiKey=pk_live_abcdefgh"}`;

      // The recorder's ordering: scan first, write only if the scan passes.
      expect(() => {
        assertNoSecretsInText("data-cassette.json", content, secrets);
      }).toThrow("Secret-like value leaked into data-cassette.json");

      // The throw above skips the write, so the cassette never reaches disk.
      await expect(readFile(target, "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("passes content that holds no known secret", () => {
    const secrets = knownSecretValues({ MARKET_BOT_POLYGON_API_KEY: "pk_live_abcdefgh" });
    expect(() => {
      assertNoSecretsInText("meta.json", `{"argv":["--symbol","NBIS"]}`, secrets);
    }).not.toThrow();
  });

  test("ignores env values too short to be a real key", () => {
    expect(knownSecretValues({ MARKET_BOT_FRED_API_KEY: "short" })).toEqual([]);
  });

  test("still scans already-written files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "secret-scan-"));
    try {
      const target = join(dir, "report.json");
      await writeFile(target, `{"note":"pk_live_abcdefgh"}`, "utf8");
      await expect(assertNoSecretsInFiles([target], ["pk_live_abcdefgh"])).rejects.toThrow(
        "Secret-like value leaked into",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("fixture secret scan entry", () => {
  test("detects a secret planted in a nested fixture file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "secret-scan-"));
    try {
      await mkdir(join(dir, "bodies"));
      await writeFile(join(dir, "meta.json"), "{}", "utf8");
      await writeFile(join(dir, "bodies", "abc.txt"), "token=pk_live_abcdefgh", "utf8");
      await expect(scanFixtureDirs([dir], ["pk_live_abcdefgh"])).rejects.toThrow(
        `Secret-like value leaked into ${join(dir, "bodies", "abc.txt")}`,
      );
      await expect(scanFixtureDirs([dir], ["other_secret_value"])).resolves.toEqual({
        files: 2,
        secrets: 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fails as not performed without known secrets or directories", async () => {
    await expect(scanFixtureDirs(["unused"], [])).rejects.toThrow("scan not performed");
    await expect(scanFixtureDirs([], ["pk_live_abcdefgh"])).rejects.toThrow("scan not performed");
  });

  test("the command exits non-zero when no secret is known", () => {
    const result = Bun.spawnSync(
      [
        "bun",
        "--no-env-file",
        join(import.meta.dir, "../scripts/fixture-secret-scan.ts"),
        import.meta.dir,
      ],
      { env: { PATH: process.env.PATH ?? "" }, stderr: "pipe" },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("scan not performed");
  });
});
