import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { goldenOutputPath, writeGoldenOutput } from "../tests/support/run-fixtures/artifacts";
import { runFixture, runFixturePair } from "../tests/support/run-fixtures";
import { assertNoSecretsInFiles, knownSecretValues } from "./fixture-secret-scan";

function usage(): never {
  throw new Error(
    "Usage: bun run scripts/replay-fixture-run.ts <fixture-name> [--live] [--write-golden] [--paired [--judge-model <model>]]",
  );
}

const [fixtureName, ...flags] = process.argv.slice(2);
if (fixtureName === undefined) {
  usage();
}
const judgeModelIndex = flags.indexOf("--judge-model");
const judgeModel = judgeModelIndex !== -1 ? flags[judgeModelIndex + 1] : undefined;
if (judgeModelIndex !== -1 && (judgeModel === undefined || judgeModel.startsWith("--"))) {
  usage();
}
const valueIndexes = new Set(judgeModelIndex !== -1 ? [judgeModelIndex + 1] : []);
const unknownFlag = flags.find(
  (flag, index) =>
    !valueIndexes.has(index) &&
    flag !== "--live" &&
    flag !== "--write-golden" &&
    flag !== "--paired" &&
    flag !== "--judge-model",
);
if (unknownFlag !== undefined || (judgeModel !== undefined && !flags.includes("--paired"))) {
  usage();
}

const live = flags.includes("--live");
const writeGolden = flags.includes("--write-golden");
const paired = flags.includes("--paired");
if (paired && writeGolden) {
  throw new Error("--paired cannot be combined with --write-golden");
}

if (paired) {
  const pairRoot = join(
    "data",
    "evaluations",
    `${fixtureName}-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`,
  );
  const result = await runFixturePair(fixtureName, {
    llm: live ? "live" : "replay",
    keepDataDir: true,
    dataDir: pairRoot,
    ...(judgeModel !== undefined ? { judgeModel } : {}),
  });
  const summary = {
    version: 1,
    fixture: fixtureName,
    dataDir: result.dataDir,
    variants: Object.fromEntries(
      Object.entries(result.variants).map(([variant, outcome]) => [
        variant,
        outcome.status === "success"
          ? { status: outcome.status, runDir: outcome.result.artifacts.runDir }
          : { status: outcome.status, error: outcome.error.message },
      ]),
    ),
    ...(result.judge !== undefined ? { judge: result.judge } : {}),
  };
  await mkdir(pairRoot, { recursive: true });
  const summaryPath = join(pairRoot, "evaluation.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  process.stdout.write(`${summaryPath}\n`);
} else {
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
}
