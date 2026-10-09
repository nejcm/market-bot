import { join } from "node:path";
import { runFixture } from "../tests/support/run-fixtures";

const args = process.argv.slice(2);
const fixtureNames = args.filter((argument) => !argument.startsWith("--"));
const flags = args.filter((argument) => argument.startsWith("--"));
if (fixtureNames.length !== 1 || flags.some((flag) => flag !== "--live")) {
  throw new Error("Usage: bun run scripts/replay-fixture-run.ts <fixture-name> [--live]");
}
const live = flags.includes("--live");
const result = await runFixture(fixtureNames[0]!, {
  llm: live ? "live" : "replay",
  keepDataDir: true,
  ...(live ? { dataDir: join("data", "runs") } : {}),
});
process.stdout.write(`${result.artifacts.runDir}\n`);
