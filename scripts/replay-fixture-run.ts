import { join } from "node:path";
import { goldenOutputPath, writeGoldenOutput } from "../tests/support/run-fixtures/artifacts";
import { runFixture } from "../tests/support/run-fixtures";
import { assertNoSecretsInFiles, knownSecretValues } from "./fixture-secret-scan";

function usage(): never {
  throw new Error(
    "Usage: bun run scripts/replay-fixture-run.ts <fixture-name> [--live] [--write-golden]",
  );
}

const [fixtureName, ...flags] = process.argv.slice(2);
if (fixtureName === undefined) {
  usage();
}
const unknownFlag = flags.find((flag) => flag !== "--live" && flag !== "--write-golden");
if (unknownFlag !== undefined) {
  throw new Error(`Unknown flag: ${unknownFlag}`);
}

const live = flags.includes("--live");
const writeGolden = flags.includes("--write-golden");
const result = await runFixture(fixtureName, {
  llm: live ? "live" : "replay",
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
