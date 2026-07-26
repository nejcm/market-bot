import { resolve } from "node:path";
import { migrateDeepEquityEvidenceBundles } from "../src/deep-equity/migration";

function parseArgs(args: readonly string[]): { readonly runsDir: string; readonly write: boolean } {
  let write = false;
  let runsDir = process.env.MARKET_BOT_DATA_DIR ?? "data/runs";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--write") {
      write = true;
      continue;
    }
    if (arg === "--runs-dir") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--runs-dir requires a path");
      }
      runsDir = value;
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: bun run scripts/migrate-deep-equity-bundles.ts [--write] [--runs-dir <path>]",
    );
  }
  return { runsDir: resolve(runsDir), write };
}

const options = parseArgs(process.argv.slice(2));
const result = await migrateDeepEquityEvidenceBundles(options);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.failures.length > 0) {
  process.exitCode = 1;
}
