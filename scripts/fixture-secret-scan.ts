import { readFile } from "node:fs/promises";

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
      const content = await readFile(file, "utf8");
      const leaked = secrets.find((secret) => content.includes(secret));
      if (leaked !== undefined) {
        throw new Error(`Secret-like value leaked into ${file}`);
      }
    }),
  );
}
