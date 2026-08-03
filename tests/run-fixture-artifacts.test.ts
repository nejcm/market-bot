import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "bun:test";
import { format } from "oxfmt";
import {
  goldenOutputPath,
  scrubbedRunArtifacts,
  writeGoldenOutput,
} from "./support/run-fixtures/artifacts";

test("writes golden output with byte-stable oxfmt serialization", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "market-bot-golden-output-"));
  const runDir = join(tempRoot, "run");
  const outputDir = join(tempRoot, "golden");
  const fixtureRoot = join(import.meta.dir, "fixtures", "runs");
  const fixtureName = relative(fixtureRoot, outputDir);

  try {
    await mkdir(join(runDir, "normalized"), { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await Promise.all([
      writeFile(join(runDir, "report.json"), '{"summary":"A deliberately long report summary"}'),
      writeFile(join(runDir, "analytics.json"), '{"counts":{"sources":3,"gaps":1}}'),
      writeFile(join(runDir, "report.md"), "# Report\n"),
      writeFile(join(runDir, "normalized", "evidence.json"), '{"values":[1,2,3,4,5,6,7,8,9,10]}'),
    ]);

    const outputPath = goldenOutputPath(fixtureName);
    const serialized = JSON.stringify(await scrubbedRunArtifacts(runDir), null, 2);
    const expected = await format(outputPath, serialized);

    expect(expected.errors).toEqual([]);
    expect(expected.code).not.toBe(`${serialized}\n`);

    await writeGoldenOutput(runDir, fixtureName);
    const firstWrite = await readFile(outputPath, "utf8");
    await writeGoldenOutput(runDir, fixtureName);

    expect(firstWrite).toBe(expected.code);
    expect(await readFile(outputPath, "utf8")).toBe(firstWrite);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
