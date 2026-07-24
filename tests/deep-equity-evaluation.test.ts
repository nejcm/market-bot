import { afterEach, describe, expect, test } from "bun:test";
import {
  judgeDeepEquityPair,
  PAIRWISE_JUDGE_DIMENSIONS,
  SimplifiedPipelineNotImplementedError,
} from "./support/deep-equity-evaluation";
import type { ModelRequest } from "../src/model/types";
import {
  measureDeepEquityLegacyBaseline,
  readDeepEquityLegacyBaseline,
} from "./support/deep-equity-pipeline-baseline";
import { researchReport } from "./support/fixtures";
import { runFixturePair, type RunFixturePairResult } from "./support/run-fixtures";

const pairResults: RunFixturePairResult[] = [];

afterEach(async () => {
  await Promise.all(pairResults.splice(0).map((result) => result.cleanup()));
});

function judgeResponse(): string {
  return JSON.stringify({
    dimensions: Object.fromEntries(
      PAIRWISE_JUDGE_DIMENSIONS.map((dimension) => [
        dimension,
        { A: 5, B: 3, rationale: `${dimension} comparison` },
      ]),
    ),
    winner: "A",
    rationale: "A is stronger overall.",
    criticalMaterialEvidenceOmissions: { A: [], B: ["material event omitted"] },
  });
}

describe("deep-equity pipeline evaluation", () => {
  test("pins the regenerable legacy baseline to fixed fixture cassettes", async () => {
    const measured = await measureDeepEquityLegacyBaseline();
    expect(measured).toEqual(await readDeepEquityLegacyBaseline());
    for (const fixture of measured.fixtures) {
      expect(fixture.modelCallTotals.callCount).toBeGreaterThanOrEqual(fixture.modelStages.length);
      expect(fixture.modelCallTotals.promptTokenEstimate).toBeGreaterThanOrEqual(
        fixture.modelStages.reduce((total, call) => total + call.promptTokenEstimate, 0),
      );
      expect(fixture.modelCallTotals.providerTokenEstimate).toBeGreaterThanOrEqual(
        fixture.modelStages.reduce((total, call) => total + call.providerTokenEstimate, 0),
      );
    }
  });

  test("collects once and exposes the typed simplified placeholder in paired mode", async () => {
    const requests: string[] = [];
    const result = await runFixturePair("equity-aapl-deep", {
      llm: "replay",
      onDataRequest: (request) => requests.push(request.url),
    });
    pairResults.push(result);

    expect(result.variants.legacy.status).toBe("success");
    expect(result.variants.simplified.status).toBe("not-implemented");
    if (result.variants.simplified.status === "not-implemented") {
      expect(result.variants.simplified.error).toBeInstanceOf(
        SimplifiedPipelineNotImplementedError,
      );
      expect(result.variants.simplified.error.message).toBe(
        "simplified pipeline not yet implemented",
      );
    }
    expect(
      requests.filter((url) => new URL(url).searchParams.get("symbols") === "AAPL"),
    ).toHaveLength(1);
    expect(result.judge).toBeUndefined();
  });

  test("blinds randomized labels and maps judge scores back to variants", async () => {
    const requests: ModelRequest[] = [];
    const result = await judgeDeepEquityPair({
      provider: {
        name: "judge-provider",
        generate: async (request) => {
          requests.push(request);
          return { content: judgeResponse(), tokenEstimate: 123 };
        },
      },
      judgeModel: "independent-judge",
      synthesisModels: ["synthesis-model"],
      reports: {
        legacy: researchReport({ summary: "legacy report" }),
        simplified: researchReport({ summary: "simplified report" }),
      },
      random: () => 0.75,
    });

    expect(result.blindLabels).toEqual({ legacy: "B", simplified: "A" });
    expect(result.decision).toBe("simplified");
    expect(result.dimensions[0]).toEqual({
      dimension: "evidence-grounding-citations",
      legacyScore: 3,
      simplifiedScore: 5,
      rationale: "evidence-grounding-citations comparison",
    });
    expect(result.criticalMaterialEvidenceOmissions).toEqual({
      legacy: ["material event omitted"],
      simplified: [],
    });
    expect(result.tokenEstimate).toBe(123);
    const prompt = JSON.parse(
      requests[0]?.messages.findLast((message) => message.role === "user")?.content ?? "{}",
    ) as {
      readonly reports?: readonly {
        readonly label: string;
        readonly report: { readonly summary?: string };
      }[];
    };
    expect(prompt.reports?.map((entry) => [entry.label, entry.report.summary])).toEqual([
      ["A", "simplified report"],
      ["B", "legacy report"],
    ]);
    expect(JSON.stringify(prompt)).not.toContain("pipelineVariant");
  });

  test("rejects a judge model used for synthesis before calling the provider", async () => {
    let called = false;

    await expect(
      judgeDeepEquityPair({
        provider: {
          name: "judge-provider",
          generate: async () => {
            called = true;
            return { content: judgeResponse(), tokenEstimate: 1 };
          },
        },
        judgeModel: "same-model",
        synthesisModels: ["same-model"],
        reports: {
          legacy: researchReport(),
          simplified: researchReport(),
        },
      }),
    ).rejects.toThrow('judge model "same-model" must differ from synthesis model(s): same-model');
    expect(called).toBe(false);
  });
});
