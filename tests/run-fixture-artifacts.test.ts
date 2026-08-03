import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "bun:test";
import { format } from "oxfmt";
import {
  goldenOutputDirectory,
  readGoldenOutput,
  scrubbedRunArtifacts,
  writeGoldenOutput,
  type JsonValue,
} from "./support/run-fixtures/artifacts";

async function formattedJson(path: string, value: JsonValue): Promise<string> {
  const formatted = await format(path, JSON.stringify(value, null, 2));
  expect(formatted.errors).toEqual([]);
  return formatted.code;
}

async function writtenFiles(directory: string): Promise<readonly string[]> {
  const rootEntries = await readdir(directory, { withFileTypes: true });
  const normalizedDirectory = join(directory, "normalized");
  const normalizedEntries = await readdir(normalizedDirectory, { withFileTypes: true });
  return [
    ...rootEntries.filter((entry) => entry.isFile()).map((entry) => join(directory, entry.name)),
    ...normalizedEntries
      .filter((entry) => entry.isFile())
      .map((entry) => join(normalizedDirectory, entry.name)),
  ].toSorted();
}

test("writes and reads an exact, byte-stable split golden output", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "market-bot-golden-output-"));
  const runDir = join(tempRoot, "run");
  const fixtureRoot = join(import.meta.dir, "fixtures", "runs");
  const fixtureParent = join(tempRoot, "fixture");
  const fixtureName = relative(fixtureRoot, fixtureParent);
  const outputDirectory = goldenOutputDirectory(fixtureName);
  const markdown = "# Report\n\nA deliberately exact Markdown body";

  try {
    await mkdir(join(runDir, "normalized"), { recursive: true });
    await Promise.all([
      writeFile(join(runDir, "report.json"), '{"summary":"A deliberately long report summary"}'),
      writeFile(join(runDir, "analytics.json"), '{"counts":{"sources":3,"gaps":1}}'),
      writeFile(join(runDir, "report.md"), markdown),
      writeFile(join(runDir, "normalized", "evidence.json"), '{"values":[1,2,3,4,5,6,7,8,9,10]}'),
    ]);

    const scrubbed = await scrubbedRunArtifacts(runDir);
    const firstFiles = await writeGoldenOutput(runDir, fixtureName);
    const expectedFiles = [
      join(outputDirectory, "analytics.json"),
      join(outputDirectory, "report.json"),
      join(outputDirectory, "report.md"),
      join(outputDirectory, "normalized", "evidence.json"),
    ].toSorted();

    expect(firstFiles).toEqual(expectedFiles);
    expect(await writtenFiles(outputDirectory)).toEqual(expectedFiles);
    const rootEntries = await readdir(outputDirectory, { withFileTypes: true });
    expect(
      rootEntries
        .map((entry) => `${entry.isDirectory() ? "dir" : "file"}:${entry.name}`)
        .toSorted(),
    ).toEqual(
      ["dir:normalized", "file:analytics.json", "file:report.json", "file:report.md"].toSorted(),
    );
    const normalizedEntries = await readdir(join(outputDirectory, "normalized"), {
      withFileTypes: true,
    });
    expect(
      normalizedEntries.map((entry) => `${entry.isFile() ? "file" : "other"}:${entry.name}`),
    ).toEqual(["file:evidence.json"]);

    expect(await readGoldenOutput(fixtureName)).toEqual(scrubbed);
    expect(await readFile(join(outputDirectory, "report.json"), "utf8")).toBe(
      await formattedJson(join(outputDirectory, "report.json"), scrubbed.report),
    );
    expect(await readFile(join(outputDirectory, "analytics.json"), "utf8")).toBe(
      await formattedJson(join(outputDirectory, "analytics.json"), scrubbed.analytics),
    );
    expect(await readFile(join(outputDirectory, "normalized", "evidence.json"), "utf8")).toBe(
      await formattedJson(
        join(outputDirectory, "normalized", "evidence.json"),
        scrubbed.normalized["evidence.json"]!,
      ),
    );
    const reportMarkdown = await readFile(join(outputDirectory, "report.md"), "utf8");
    expect(reportMarkdown).toBe(markdown);
    expect(reportMarkdown.endsWith("\n")).toBe(false);

    const firstContents = await Promise.all(firstFiles.map((path) => readFile(path, "utf8")));
    await writeFile(join(outputDirectory, "normalized", "stale.json"), "{}", "utf8");
    const secondFiles = await writeGoldenOutput(runDir, fixtureName);
    const secondContents = await Promise.all(secondFiles.map((path) => readFile(path, "utf8")));

    expect(secondFiles).toEqual(firstFiles);
    expect(await writtenFiles(outputDirectory)).toEqual(expectedFiles);
    expect(secondContents).toEqual(firstContents);
    expect(await readGoldenOutput(fixtureName)).toEqual(scrubbed);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
