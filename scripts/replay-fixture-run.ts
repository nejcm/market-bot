import { join } from "node:path";
import { runFixture } from "../tests/support/run-fixtures";

function usage(): never {
  throw new Error("Usage: bun run scripts/replay-fixture-run.ts <fixture-name> [--live]");
}

const [fixtureName, ...flags] = process.argv.slice(2);
if (fixtureName === undefined) {
  usage();
}
const unknownFlag = flags.find((flag) => flag !== "--live");
if (unknownFlag !== undefined) {
  throw new Error(`Unknown flag: ${unknownFlag}`);
}

const live = flags.includes("--live");
const result = await runFixture(fixtureName, {
  llm: live ? "live" : "replay",
  keepDataDir: true,
  dataDir: join("data", "runs"),
});
process.stdout.write(`${result.artifacts.runDir}\n`);
