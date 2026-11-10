import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNoSecretsInText } from "../src/replay/secret-scan";

export { assertNoSecretsInText } from "../src/replay/secret-scan";

export function knownSecretValues(env: Record<string, string | undefined>): readonly string[] {
  return [
    env.OPENAI_API_KEY,
    env.MARKET_BOT_OPENAI_API_KEY,
    env.ANTHROPIC_API_KEY,
    env.MARKET_BOT_ANTHROPIC_API_KEY,
    env.MARKET_BOT_MARKETAUX_API_TOKEN,
    env.MARKET_BOT_FINNHUB_API_TOKEN,
    env.MARKET_BOT_FRED_API_KEY,
    env.MARKET_BOT_TRADIER_API_TOKEN,
    env.MARKET_BOT_GLASSNODE_API_KEY,
    env.MARKET_BOT_MASSIVE_API_KEY,
    env.MARKET_BOT_POLYGON_API_KEY,
    env.MARKET_BOT_EXA_API_KEY,
    env.MARKET_BOT_FIRECRAWL_API_KEY,
  ].filter((value): value is string => value !== undefined && value.length >= 8);
}

export async function assertNoSecretsInFiles(
  files: readonly string[],
  secrets: readonly string[],
): Promise<void> {
  if (secrets.length === 0) {
    return;
  }
  await Promise.all(
    files.map(async (file) => {
      assertNoSecretsInText(file, await readFile(file, "utf8"), secrets);
    }),
  );
}

export async function scanFixtureDirs(
  dirs: readonly string[],
  secrets: readonly string[],
): Promise<{ files: number; secrets: number }> {
  if (secrets.length === 0) {
    throw new Error("Secret scan not performed: no known secret values in the environment");
  }
  if (dirs.length === 0) {
    throw new Error("Secret scan not performed: no directories given");
  }
  const files = (
    await Promise.all(
      dirs.map(async (dir) =>
        (await readdir(dir, { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name)),
      ),
    )
  ).flat();
  await assertNoSecretsInFiles(files, secrets);
  return { files: files.length, secrets: secrets.length };
}

if (import.meta.main) {
  try {
    const { files, secrets } = await scanFixtureDirs(
      process.argv.slice(2),
      knownSecretValues(process.env),
    );
    process.stdout.write(`Scanned ${files} files against ${secrets} secrets: none found\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
