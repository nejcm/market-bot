import { describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PAIRWISE_JUDGE_DIMENSIONS } from "./support/deep-equity-judge";
import {
  DEEP_EQUITY_EVALUATION_FILE,
  resumePairedEvaluation,
  runPairedEvaluation,
} from "./support/deep-equity-evaluation-runner";
import type { ModelProvider, ModelRequest } from "../src/model/types";
import { loadFixture } from "./support/run-fixtures";
import { makeReplayProvider } from "./support/run-fixtures/llm-cassette";
import { createDataDirRegistry } from "./support/orchestrator-helpers";

const { cleanupDataDirs, tempDataDir } = createDataDirRegistry();

function judgeResponse(): string {
  return JSON.stringify({
    dimensions: Object.fromEntries(
      PAIRWISE_JUDGE_DIMENSIONS.map((dimension) => [
        dimension,
        { A: 4, B: 3, rationale: `${dimension} comparison` },
      ]),
    ),
    winner: "A",
    rationale: "A is stronger overall.",
    criticalMaterialEvidenceOmissions: { A: [], B: [] },
  });
}

function isJudgeRequest(request: ModelRequest): boolean {
  return request.messages.some((message) =>
    message.content.includes('"stage":"deep-equity-pairwise-judge'),
  );
}

async function provider(scenario: string): Promise<ModelProvider> {
  const fixture = await loadFixture(scenario);
  const replay = makeReplayProvider(fixture.llmCassette);
  return {
    name: "midplan-check",
    generate: async (request) => {
      if (!isJudgeRequest(request)) {
        return replay.generate(request);
      }
      return { content: judgeResponse(), tokenEstimate: 10 };
    },
  };
}

function key(record: { readonly scenario: string; readonly repetition: number }): string {
  return `${record.scenario}/${record.repetition}`;
}

// The committed recovery test proves stream alignment on repetition 3 of a SINGLE fixture, which
// Is the last pair in the walk and therefore cannot detect a fixture-ordering or off-by-one error.
// This covers a pair in the MIDDLE of a two-fixture walk instead.
// Seed 3 is chosen because it makes walk position 2 reversed and position 3 normal, so an
// Off-by-one assigns a visibly different variant order rather than an identical one.
// Verified discriminating: swapping plannedEvaluationPairs to repetition-outer enumeration makes
// This fail with ["legacy","simplified"] against an expected ["simplified","legacy"].
describe("mid-plan recovery stream alignment", () => {
  test("recovered mid-walk pair keeps its original variant order", async () => {
    const root = await tempDataDir("midplan");
    const original = await runPairedEvaluation({
      root,
      fixtureNames: ["equity-aapl-deep", "equity-nbis-deep"],
      repetitions: 2,
      seed: 3,
      live: false,
    });
    const orders = new Map(
      original.records.map((record) => [key(record), JSON.stringify(record.variantOrder)]),
    );
    // Mid-walk target: second of four, so a fixture-ordering or off-by-one error is visible.
    const target = "equity-aapl-deep/2";
    const expectedOrder = orders.get(target) ?? "<missing>";
    const retained = original.records.filter((record) => key(record) !== target);
    await rm(join(root, "equity-aapl-deep", "repetition-2"), { recursive: true, force: true });
    await writeFile(
      join(root, DEEP_EQUITY_EVALUATION_FILE),
      `${JSON.stringify({ ...original, records: retained }, null, 2)}\n`,
      "utf8",
    );

    const recovered = await resumePairedEvaluation({
      root,
      live: false,
      judgeModel: "fixture-judge",
      recoverMissingPairs: true,
      providerForScenario: provider,
    });
    const recoveredTarget = recovered.records.find((record) => key(record) === target);

    // Seed 3 makes this "[simplified,legacy]" while walk position 3 is "[legacy,simplified]".
    expect(expectedOrder).toBe('["simplified","legacy"]');
    expect(JSON.stringify(recoveredTarget?.variantOrder)).toBe(expectedOrder);
    expect(recovered.records).toHaveLength(4);
    expect(recovered.plan.loadSource).toBe("operator-recovery");
    cleanupDataDirs();
  }, 180_000);
});
