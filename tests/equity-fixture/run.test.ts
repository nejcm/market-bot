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
      if (fixture.meta.argv.includes("--deep")) {
        expect(result.deepEquityEvidenceBundle).toMatchObject({
          schemaVersion: 1,
          run: { symbol: expect.any(String), analysisAsOf: fixture.meta.now },
          evidence: {
            marketSnapshots: expect.any(Array),
            supplementalMarketSnapshots: expect.any(Array),
            newsSources: expect.any(Array),
            extendedSources: expect.any(Array),
          },
          derived: expect.any(Object),
          governance: {
            sourceGaps: expect.any(Array),
            sourcePlan: expect.any(Object),
            evidenceLanes: expect.any(Object),
            sourceLedger: expect.any(Object),
          },
          context: { historicalContext: expect.any(Object) },
        });
        expect(result.deepEquityModelPacket).toMatchObject({
          schemaVersion: 1,
          canonicalFacts: expect.any(Object),
          evidenceItems: expect.any(Array),
          sources: expect.any(Array),
          gaps: expect.any(Array),
        });
        expect(JSON.stringify(result.deepEquityEvidenceBundle)).not.toContain("rawSnapshots");
        expect(JSON.stringify(result.deepEquityModelPacket)).not.toContain("rawSnapshots");
      }
      expect(await scrubbedRunArtifacts(result.artifacts.runDir)).toEqual(
        await readGoldenOutput(name),
      );
    });
  }
});
