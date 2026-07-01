import { afterEach, describe, expect, test } from "bun:test";
import { parseObservableExpression } from "../src/forecast/observable";
import { assertSafeReportLanguage, validateResearchReport } from "../src/report/schema";
import { readGoldenOutput, scrubbedRunArtifacts } from "./support/run-fixtures/artifacts";
import {
  loadFixture,
  runFixture,
  type FixtureMeta,
  type RunFixtureResult,
} from "./support/run-fixtures";

const FIXTURES = ["equity-aapl-brief", "equity-aapl-deep"] as const;

const runResults: RunFixtureResult[] = [];

afterEach(async () => {
  await Promise.all(runResults.splice(0).map((result) => result.cleanup()));
});

function assertInvariants(result: RunFixtureResult, name: string, meta: FixtureMeta): void {
  const report = validateResearchReport(result.report);
  assertSafeReportLanguage(report);
  for (const prediction of report.predictions) {
    expect(() => parseObservableExpression(prediction.measurableAs)).not.toThrow();
  }
  expect(result.markdown.match(/Research-only note/gu)?.length).toBe(1);
  expect(result.sourcePlan).toBeDefined();
  expect(result.evidenceLanes.summary.plannedLaneCount).toBeGreaterThan(0);
  expect(result.analytics.sourcePlan?.plannedLaneCount).toBeGreaterThan(0);
  if (name.endsWith("-deep")) {
    expect(result.stageOutputs.map((output) => output.stage)).toEqual(
      expect.arrayContaining(["instrument-evidence-analysis", "market-behavior-analysis"]),
    );
    if ((meta.challengerModels ?? []).length > 0) {
      expect(result.trace.forecastDisagreement?.challengerModelCount).toBe(
        meta.challengerModels?.length,
      );
    }
  }
}

describe("static equity run fixtures", () => {
  for (const name of FIXTURES) {
    test(`${name} replays through the real equity pipeline`, async () => {
      const fixture = await loadFixture(name);
      const result = await runFixture(name, { llm: "replay" });
      runResults.push(result);

      assertInvariants(result, name, fixture.meta);
      expect(await scrubbedRunArtifacts(result.artifacts.runDir)).toEqual(
        await readGoldenOutput(name),
      );
    });
  }
});
