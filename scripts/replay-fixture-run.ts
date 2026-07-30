import { join } from "node:path";
import { goldenOutputPath, writeGoldenOutput } from "../tests/support/run-fixtures/artifacts";
import { runFixture } from "../tests/support/run-fixtures";
import { assertNoSecretsInFiles, knownSecretValues } from "./fixture-secret-scan";

const args = process.argv.slice(2);
const fixtureNames = args.filter((argument) => !argument.startsWith("--"));
const flags = args.filter((argument) => argument.startsWith("--"));
if (
  fixtureNames.length !== 1 ||
  flags.some((flag) => flag !== "--live" && flag !== "--write-golden")
) {
  throw new Error(
    "Usage: bun run scripts/replay-fixture-run.ts <fixture-name> [--live] [--write-golden]",
  );
}

const fixtureName = fixtureNames[0]!;
const writeGolden = flags.includes("--write-golden");
const result = await runFixture(fixtureName, {
  llm: flags.includes("--live") ? "live" : "replay",
  keepDataDir: !writeGolden,
  ...(writeGolden ? {} : { dataDir: join("data", "runs") }),
});

try {
  if (writeGolden) {
    await writeGoldenOutput(result.artifacts.runDir, fixtureName);
    await assertNoSecretsInFiles([goldenOutputPath(fixtureName)], knownSecretValues(process.env));
    process.stdout.write(`${goldenOutputPath(fixtureName)}\n`);
  } else {
    process.stdout.write(`${result.artifacts.runDir}\n`);
  }
} finally {
  await result.cleanup();
}
