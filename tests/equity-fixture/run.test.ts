import { afterEach, describe, expect, test } from "bun:test";
import type { ModelRequest } from "../../src/model/types";
import {
  assertComprehensiveAnalysisPath,
  assertEstimatedEarningsSuppressionPath,
  assertInvariants,
  assertNbisUnsupportedInputs,
  factForms,
  factTaxonomies,
} from "../support/run-fixtures/assertions";
import { readGoldenOutput, scrubbedRunArtifacts } from "../support/run-fixtures/artifacts";
import { loadFixture, runFixture, type RunFixtureResult } from "../support/run-fixtures";
import { makeReplayProvider } from "../support/run-fixtures/llm-cassette";

const FIXTURES = [
  "equity-aapl-brief",
  "equity-aapl-deep",
  "equity-nbis-deep",
  "equity-fpi-quarterly",
  "equity-fpi-ifrs-semiannual",
  "equity-analysis-comprehensive",
  "equity-analysis-estimated-suppressed",
] as const;

const CAPTURE_EARNINGS_FIXTURES = new Set<string>([
  "equity-analysis-comprehensive",
  "equity-analysis-estimated-suppressed",
]);

const runResults: RunFixtureResult[] = [];

afterEach(async () => {
  await Promise.all(runResults.splice(0).map((result) => result.cleanup()));
});

describe("static equity run fixtures", () => {
  for (const name of FIXTURES) {
    test(`${name} replays through the real equity pipeline`, async () => {
      const fixture = await loadFixture(name);
      const modelRequests: ModelRequest[] = [];
      const modelOutputs: string[] = [];
      const replayProvider = makeReplayProvider(fixture.llmCassette);
      const result = await runFixture(name, {
        llm: "replay",
        ...(CAPTURE_EARNINGS_FIXTURES.has(name)
          ? {
              provider: {
                name: replayProvider.name,
                generate: async (request: ModelRequest) => {
                  modelRequests.push(request);
                  const response = await replayProvider.generate(request);
                  modelOutputs.push(response.content);
                  return response;
                },
              },
            }
          : {}),
      });
      runResults.push(result);

      assertInvariants(result, fixture.meta);
      if (name === "equity-nbis-deep") {
        expect(factTaxonomies(result)).toContain("us-gaap");
        expect(factForms(result).has("20-F")).toBe(true);
        await assertNbisUnsupportedInputs();
      }
      if (name === "equity-fpi-quarterly") {
        expect(factTaxonomies(result)).toEqual(["us-gaap"]);
        expect([...factForms(result)]).toEqual(expect.arrayContaining(["20-F", "6-K"]));
      }
      if (name === "equity-fpi-ifrs-semiannual") {
        expect(factTaxonomies(result)).toEqual(["ifrs-full"]);
        expect([...factForms(result)]).toEqual(expect.arrayContaining(["20-F", "6-K"]));
      }
      if (name === "equity-analysis-comprehensive") {
        assertComprehensiveAnalysisPath(result, modelRequests);
      }
      if (name === "equity-analysis-estimated-suppressed") {
        assertEstimatedEarningsSuppressionPath(result, modelRequests, modelOutputs);
      }
      expect(await scrubbedRunArtifacts(result.artifacts.runDir)).toEqual(
        await readGoldenOutput(name),
      );
    });
  }
});
