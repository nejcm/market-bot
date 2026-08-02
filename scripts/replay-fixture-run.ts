import { join } from "node:path";
import { goldenOutputPath, writeGoldenOutput } from "../tests/support/run-fixtures/artifacts";
import {
  formatGoldenDiff,
  formatGoldenMismatch,
  parseGoldenReplayArgs,
  reviewFixtureGolden,
} from "../tests/support/run-fixtures/golden-diff";
import { runFixture } from "../tests/support/run-fixtures";
import { assertNoSecretsInFiles, knownSecretValues } from "./fixture-secret-scan";

const { fixtureName, mode } = parseGoldenReplayArgs(process.argv.slice(2));
const result = await runFixture(fixtureName, {
  llm: mode === "live" ? "live" : "replay",
  keepDataDir: mode === "live" || mode === "keep",
  ...(mode === "live" ? { dataDir: join("data", "runs") } : {}),
});

try {
  if (mode !== "live") {
    const review = await reviewFixtureGolden(result.artifacts.runDir, fixtureName);
    if (mode === "keep") {
      process.stdout.write(`${result.artifacts.runDir}\n`);
    }
    if ((mode === "check" || mode === "keep") && !review.equal) {
      throw new Error(formatGoldenMismatch(fixtureName, review.diff));
    }
    process.stdout.write(`${formatGoldenDiff(review.diff)}\n`);
  }
  if (mode === "write") {
    await writeGoldenOutput(result.artifacts.runDir, fixtureName);
    await assertNoSecretsInFiles([goldenOutputPath(fixtureName)], knownSecretValues(process.env));
    process.stdout.write(`${goldenOutputPath(fixtureName)}\n`);
  } else if (mode === "live") {
    process.stdout.write(`${result.artifacts.runDir}\n`);
  }
} finally {
  await result.cleanup();
}
