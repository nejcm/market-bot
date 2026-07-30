import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCodeVersion } from "../src/code-version";
import type { ModelProvider, ModelRequest } from "../src/model/types";
import {
  DEEP_EQUITY_EVALUATION_FILE,
  resumePairedEvaluation,
  runPairedEvaluation,
} from "./support/deep-equity-evaluation-runner";
import { PAIRWISE_JUDGE_DIMENSIONS } from "./support/deep-equity-evaluation";
import {
  DEEP_EQUITY_OPERATOR_GATE_RECORD_TYPE,
  deepEquityEvaluationRootIdentifier,
} from "./support/deep-equity-operator-gates";
import { DEEP_EQUITY_VARIANT_FAILURE_FILE, loadFixture } from "./support/run-fixtures";
import { llmCassetteKey, makeReplayProvider } from "./support/run-fixtures/llm-cassette";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function judgeResponse(winner: "A" | "tie" = "A"): string {
  return JSON.stringify({
    dimensions: Object.fromEntries(
      PAIRWISE_JUDGE_DIMENSIONS.map((dimension) => [
        dimension,
        { A: 4, B: winner === "tie" ? 4 : 3, rationale: `${dimension} comparison` },
      ]),
    ),
    winner,
    rationale: winner === "tie" ? "The reports are equivalent." : "A is stronger overall.",
    criticalMaterialEvidenceOmissions: { A: [], B: [] },
  });
}

function isJudgeRequest(request: ModelRequest): boolean {
  return request.messages.some((message) =>
    message.content.includes('"stage":"deep-equity-pairwise-judge'),
  );
}

async function fixtureProvider(
  judgeResponses: readonly string[],
  judgeCalls: ModelRequest[],
): Promise<ModelProvider> {
  const fixture = await loadFixture("equity-aapl-deep");
  const replay = makeReplayProvider(fixture.llmCassette);
  return {
    name: "evaluation-runner-test",
    generate: async (request) => {
      if (!isJudgeRequest(request)) {
        return replay.generate(request);
      }
      judgeCalls.push(request);
      return {
        content: judgeResponses[judgeCalls.length - 1] ?? judgeResponses.at(-1) ?? "{}",
        tokenEstimate: 10,
      };
    },
  };
}

async function tempEvaluationRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `market-bot-${name}-`));
  tempRoots.push(root);
  return root;
}

function runGit(repositoryRoot: string, args: readonly string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repositoryRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  }
}

async function tempApprovalRepository(name: string): Promise<{
  readonly repositoryRoot: string;
  readonly recordPath: string;
}> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), `market-bot-operator-record-${name}-`));
  tempRoots.push(repositoryRoot);
  runGit(repositoryRoot, ["init", "--quiet"]);
  runGit(repositoryRoot, ["config", "user.email", "operator-gates@example.invalid"]);
  runGit(repositoryRoot, ["config", "user.name", "Operator Gate Tests"]);
  await writeFile(join(repositoryRoot, "baseline.txt"), "baseline\n", "utf8");
  runGit(repositoryRoot, ["add", "baseline.txt"]);
  runGit(repositoryRoot, ["commit", "--quiet", "-m", "test baseline"]);
  const approvalDirectory = join(repositoryRoot, "operator-approvals", "deep-equity", name);
  await mkdir(approvalDirectory, { recursive: true });
  return {
    repositoryRoot,
    recordPath: join(approvalDirectory, "approval.json"),
  };
}

// Fails exactly one variant by rejecting its first final-synthesis call.
async function firstFinalSynthesisFailsProvider(message: string): Promise<ModelProvider> {
  const fixture = await loadFixture("equity-aapl-deep");
  const replay = makeReplayProvider(fixture.llmCassette);
  let finalSynthesisCalls = 0;
  return {
    name: "evaluation-runner-variant-failure",
    generate: async (request) => {
      if (llmCassetteKey(request).startsWith("final-synthesis|")) {
        finalSynthesisCalls += 1;
        if (finalSynthesisCalls === 1) {
          throw new Error(message);
        }
      }
      return replay.generate(request);
    },
  };
}

describe("deep-equity evaluation runner", () => {
  test("a failed variant keeps its artifacts and stays out of judging, aggregation, and gates", async () => {
    const root = await tempEvaluationRoot("variant-failure");
    const artifact = await runPairedEvaluation({
      root,
      fixtureNames: ["equity-aapl-deep"],
      repetitions: 1,
      seed: 42,
      live: false,
      judgeModel: "fixture-judge",
      provider: await firstFinalSynthesisFailsProvider("simulated synthesis transport failure"),
    });
    const persisted = JSON.parse(
      await readFile(join(root, DEEP_EQUITY_EVALUATION_FILE), "utf8"),
    ) as typeof artifact;
    const [record] = persisted.records;
    if (record === undefined) {
      throw new Error("evaluation must record the attempted pair");
    }
    const failed = [record.variants.legacy, record.variants.simplified].filter(
      (variant) => variant.status === "error",
    );
    const succeeded = [record.variants.legacy, record.variants.simplified].filter(
      (variant) => variant.status === "success",
    );

    expect(failed).toHaveLength(1);
    expect(succeeded).toHaveLength(1);
    expect(failed[0]?.error).toBe("simulated synthesis transport failure");

    // Forensics: the failed variant's directory survives and holds the raw model exchange.
    const failedRunDir = failed[0]?.runDir;
    if (failedRunDir === undefined) {
      throw new Error("failed variant must record where its artifacts were preserved");
    }
    const preserved = JSON.parse(
      await readFile(join(failedRunDir, DEEP_EQUITY_VARIANT_FAILURE_FILE), "utf8"),
    ) as {
      readonly error: readonly { readonly message: string }[];
      readonly modelExchanges: readonly {
        readonly stage: string;
        readonly response: string | null;
      }[];
    };
    expect(preserved.error[0]?.message).toBe("simulated synthesis transport failure");
    expect(preserved.modelExchanges.length).toBeGreaterThan(0);
    expect(preserved.modelExchanges.at(-1)?.stage).toBe("final-synthesis");
    expect(preserved.modelExchanges.at(-1)?.response).toBeNull();
    expect(
      preserved.modelExchanges.some(
        (exchange) => typeof exchange.response === "string" && exchange.response.length > 0,
      ),
    ).toBe(true);

    // Failure counting is unchanged: unjudged, unaggregated, and every hard gate fails closed.
    expect(record.judge).toBeUndefined();
    expect(record.unjudged?.code).toBe("variant-failure");
    expect(persisted.judging).toMatchObject({
      expectedPairCount: 1,
      judgedPairCount: 0,
      unjudgedPairCount: 1,
      incompletePairCount: 0,
    });
    expect(persisted.aggregate.runCount).toBe(0);
    expect(persisted.aggregate.rubric.evaluatedPairCount).toBe(0);
    expect(persisted.hardGateInputs).toMatchObject({
      allReportsValidate: false,
      allCitedSourceIdsResolve: false,
      zeroResearchOnlyBoundaryViolations: false,
      zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: false,
      noAdditionalLowIntegrityReports: false,
      noDeterministicEvidenceCoverageRegression: false,
      noInvalidPredictionsPersist: false,
      humanReviewApproved: false,
      liveSmokePassed: false,
    });
    expect(persisted.operatorGateRecord).toMatchObject({
      status: "not-supplied",
      authentication: "none",
      sourcePath: null,
      effectiveInputs: {
        zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: false,
        humanReviewApproved: false,
        liveSmokePassed: false,
      },
    });
    expect(persisted.gateVerdict.status).toBe("fail");
    expect(persisted.gateVerdict.failingGates).toEqual(
      expect.arrayContaining(["all-reports-validate", "rubric-non-inferiority"]),
    );
  }, 30_000);

  test("records the quick model each variant ran with and round-trips it through resume", async () => {
    const root = await tempEvaluationRoot("quick-model");
    const artifact = await runPairedEvaluation({
      root,
      fixtureNames: ["equity-aapl-deep"],
      repetitions: 1,
      seed: 63,
      live: false,
      provider: await fixtureProvider([judgeResponse()], []),
    });
    const persisted = JSON.parse(
      await readFile(join(root, DEEP_EQUITY_EVALUATION_FILE), "utf8"),
    ) as typeof artifact;

    expect(persisted.records[0]?.variants.legacy).toMatchObject({
      status: "success",
      quickModel: "fixture-quick",
      synthesisModel: "fixture-synthesis",
    });
    expect(persisted.records[0]?.variants.simplified).toMatchObject({
      status: "success",
      quickModel: "fixture-quick",
      synthesisModel: "fixture-synthesis",
    });

    const resumed = await resumePairedEvaluation({
      root,
      live: false,
      judgeModel: "fixture-judge",
      providerForScenario: async () => fixtureProvider([judgeResponse()], []),
    });
    expect(resumed.records[0]?.variants.legacy).toMatchObject({ quickModel: "fixture-quick" });
    expect(resumed.records[0]?.variants.simplified).toMatchObject({ quickModel: "fixture-quick" });
  }, 30_000);

  test("persists no-record, rejected-record, and explicit-false operator states distinctly", async () => {
    const root = await tempEvaluationRoot("operator-record-states");
    const approvalRepository = await tempApprovalRepository("states");
    const approvalRecordPath = approvalRepository.recordPath;
    const judgeCalls: ModelRequest[] = [];
    const initial = await runPairedEvaluation({
      root,
      fixtureNames: ["equity-aapl-deep"],
      repetitions: 1,
      seed: 64,
      live: false,
      judgeModel: "fixture-judge",
      provider: await fixtureProvider([judgeResponse()], judgeCalls),
    });
    expect(judgeCalls).toHaveLength(1);
    expect(initial.operatorGateRecord.status).toBe("not-supplied");

    await writeFile(approvalRecordPath, "{not-json", "utf8");
    const rejected = await resumePairedEvaluation({
      root,
      live: false,
      judgeModel: "fixture-judge",
      approvalRecordPath,
      repositoryRoot: approvalRepository.repositoryRoot,
      providerForScenario: async () => {
        throw new Error("stored verdict must not request a provider");
      },
    });
    expect(rejected.operatorGateRecord).toMatchObject({
      status: "rejected",
      rejectionReasons: [{ code: "invalid-json" }],
    });
    expect(rejected.hardGateInputs).toMatchObject({
      zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: false,
      humanReviewApproved: false,
      liveSmokePassed: false,
    });

    const { commit } = readCodeVersion(approvalRepository.repositoryRoot);
    if (commit === undefined) {
      throw new Error("Test requires a repository HEAD commit.");
    }
    await writeFile(
      approvalRecordPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          recordType: DEEP_EQUITY_OPERATOR_GATE_RECORD_TYPE,
          authentication: "none",
          evaluationRoot: deepEquityEvaluationRootIdentifier(
            root,
            approvalRepository.repositoryRoot,
          ),
          repositoryCommit: commit,
          statedBy: "repository-owner@example.invalid",
          statedOn: "2026-07-29",
          statedVerdicts: {
            zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: {
              verdict: true,
              rationale: "The adjudicated omission ledger was reviewed.",
            },
            humanReviewApproved: {
              verdict: false,
              rationale: "The operator found an unresolved blinded-review concern.",
            },
            liveSmokePassed: {
              verdict: true,
              rationale: "The separately authorized live-smoke matrix passed.",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const explicitFalse = await resumePairedEvaluation({
      root,
      live: false,
      judgeModel: "fixture-judge",
      approvalRecordPath,
      repositoryRoot: approvalRepository.repositoryRoot,
      providerForScenario: async () => {
        throw new Error("stored verdict must not request a provider");
      },
    });
    const persisted = JSON.parse(
      await readFile(join(root, DEEP_EQUITY_EVALUATION_FILE), "utf8"),
    ) as typeof explicitFalse;

    expect(persisted.operatorGateRecord.status).toBe("accepted");
    expect(persisted.operatorGateRecord.gates.humanReviewApproved).toMatchObject({
      status: "accepted",
      statedVerdict: false,
      effectiveVerdict: false,
      rationale: "The operator found an unresolved blinded-review concern.",
    });
    expect(persisted.hardGateInputs).toMatchObject({
      zeroCriticalMaterialEvidenceOmissionsAfterAdjudication: true,
      humanReviewApproved: false,
      liveSmokePassed: true,
    });
  }, 30_000);

  test("writes a complete fail-closed artifact when both judge responses omit dimensions", async () => {
    const root = await tempEvaluationRoot("judge-malformed");
    const judgeCalls: ModelRequest[] = [];
    const provider = await fixtureProvider(
      [
        JSON.stringify({ winner: "A", rationale: "missing dimensions" }),
        JSON.stringify({ winner: "B", rationale: "still missing dimensions" }),
      ],
      judgeCalls,
    );

    const artifact = await runPairedEvaluation({
      root,
      fixtureNames: ["equity-aapl-deep"],
      repetitions: 1,
      seed: 42,
      live: false,
      judgeModel: "fixture-judge",
      provider,
    });
    const persisted = JSON.parse(
      await readFile(join(root, DEEP_EQUITY_EVALUATION_FILE), "utf8"),
    ) as typeof artifact;

    expect(judgeCalls).toHaveLength(2);
    expect(persisted.records).toHaveLength(1);
    expect(persisted.judging).toMatchObject({
      judgedPairCount: 0,
      unjudgedPairCount: 1,
      incompletePairCount: 0,
    });
    expect(persisted.records[0]?.unjudged).toEqual({
      code: "missing-dimensions",
      message: "pairwise judge response must contain a dimensions object",
      attempts: 2,
      tokenEstimate: 20,
    });
    expect(persisted.judging.tokenEstimates).toEqual({
      judgedPairs: 0,
      unjudgedPairs: 20,
      totalRecorded: 20,
      unjudgedPairsWithoutEstimate: 0,
    });
    expect(persisted.gateVerdict.failingGates).toEqual(
      expect.arrayContaining([
        "rubric-non-inferiority",
        "pairwise-loss-rate",
        "scenario-repetition-losses",
      ]),
    );
    expect(persisted.tokenMetrics.wholeRunTraceTokenImprovement.gateMetric).toBe(true);
    expect(persisted.tokenMetrics.reasoningPromptTokenEstimateReduction.gateMetric).toBe(false);
  }, 30_000);

  test("resumes persisted variants equivalently and skips an already usable verdict", async () => {
    const uninterruptedRoot = await tempEvaluationRoot("judge-uninterrupted");
    const uninterruptedCalls: ModelRequest[] = [];
    const uninterrupted = await runPairedEvaluation({
      root: uninterruptedRoot,
      fixtureNames: ["equity-aapl-deep"],
      repetitions: 1,
      seed: 77,
      live: false,
      judgeModel: "fixture-judge",
      provider: await fixtureProvider([judgeResponse()], uninterruptedCalls),
    });
    expect(uninterruptedCalls).toHaveLength(1);

    const resumeRoot = await tempEvaluationRoot("judge-resume");
    await cp(join(uninterruptedRoot, "equity-aapl-deep"), join(resumeRoot, "equity-aapl-deep"), {
      recursive: true,
    });
    const resumedCalls: ModelRequest[] = [];
    let resumeProviderCalls = 0;
    const resumeProvider = async () => {
      resumeProviderCalls += 1;
      return fixtureProvider([judgeResponse()], resumedCalls);
    };
    const resumed = await resumePairedEvaluation({
      root: resumeRoot,
      live: false,
      judgeModel: "fixture-judge",
      seed: 77,
      plan: { scenarios: ["equity-aapl-deep"], repetitions: [1] },
      providerForScenario: resumeProvider,
    });

    expect(resumeProviderCalls).toBe(1);
    expect(resumedCalls).toHaveLength(1);
    expect(resumed.aggregate).toEqual(uninterrupted.aggregate);
    expect(resumed.tokenMetrics).toEqual(uninterrupted.tokenMetrics);
    expect(resumed.records).toHaveLength(1);
    expect(resumed.plan).toMatchObject({
      provenance: "operator-recovery-input",
      loadSource: "operator-recovery",
    });

    const rerun = await resumePairedEvaluation({
      root: resumeRoot,
      live: false,
      judgeModel: "fixture-judge",
      providerForScenario: resumeProvider,
    });

    expect(resumeProviderCalls).toBe(1);
    expect(rerun.records).toHaveLength(1);
    expect(rerun.aggregate).toEqual(resumed.aggregate);
    expect(rerun.plan).toMatchObject({
      provenance: "operator-recovery-input",
      loadSource: "existing-artifact",
    });
    await expect(
      resumePairedEvaluation({
        root: resumeRoot,
        live: false,
        judgeModel: "fixture-judge",
        seed: 78,
        providerForScenario: resumeProvider,
      }),
    ).rejects.toThrow("resume seed 78 does not match recorded seed 77");

    const validArtifact = JSON.parse(
      await readFile(join(resumeRoot, DEEP_EQUITY_EVALUATION_FILE), "utf8"),
    ) as Record<string, unknown>;
    if (
      !("plan" in validArtifact) ||
      validArtifact.plan === null ||
      typeof validArtifact.plan !== "object" ||
      Array.isArray(validArtifact.plan)
    ) {
      throw new Error("resumed artifact must contain an explicit plan");
    }
    const invalidProvenanceArtifact = {
      ...validArtifact,
      plan: { ...validArtifact.plan, provenance: "survivor-discovery" },
    };
    await writeFile(
      join(resumeRoot, DEEP_EQUITY_EVALUATION_FILE),
      `${JSON.stringify(invalidProvenanceArtifact, null, 2)}\n`,
      "utf8",
    );
    await expect(
      resumePairedEvaluation({
        root: resumeRoot,
        live: false,
        judgeModel: "fixture-judge",
        providerForScenario: resumeProvider,
      }),
    ).rejects.toThrow("resume evaluation.json explicit plan provenance is unsupported");

    const invalidLoadSourceArtifact = {
      ...validArtifact,
      plan: { ...validArtifact.plan, loadSource: "fabricated-artifact" },
    };
    await writeFile(
      join(resumeRoot, DEEP_EQUITY_EVALUATION_FILE),
      `${JSON.stringify(invalidLoadSourceArtifact, null, 2)}\n`,
      "utf8",
    );
    await expect(
      resumePairedEvaluation({
        root: resumeRoot,
        live: false,
        judgeModel: "fixture-judge",
        providerForScenario: resumeProvider,
      }),
    ).rejects.toThrow("resume evaluation.json explicit plan load source is unsupported");

    const circularProvenanceArtifact = {
      ...validArtifact,
      plan: { ...validArtifact.plan, provenance: "existing-artifact" },
    };
    await writeFile(
      join(resumeRoot, DEEP_EQUITY_EVALUATION_FILE),
      `${JSON.stringify(circularProvenanceArtifact, null, 2)}\n`,
      "utf8",
    );
    await expect(
      resumePairedEvaluation({
        root: resumeRoot,
        live: false,
        judgeModel: "fixture-judge",
        providerForScenario: resumeProvider,
      }),
    ).rejects.toThrow(
      "resume evaluation.json has circular plan provenance existing-artifact; supply --fixtures and --repetitions to recover it",
    );
    const recoveredCircular = await resumePairedEvaluation({
      root: resumeRoot,
      live: false,
      judgeModel: "fixture-judge",
      plan: { scenarios: ["equity-aapl-deep"], repetitions: [1] },
      providerForScenario: resumeProvider,
    });
    expect(recoveredCircular.plan).toMatchObject({
      provenance: "operator-recovery-input",
      loadSource: "operator-recovery",
      expectedPairCount: 1,
    });

    const malformedArtifact = { ...validArtifact };
    delete malformedArtifact.fixtures;
    await writeFile(
      join(resumeRoot, DEEP_EQUITY_EVALUATION_FILE),
      `${JSON.stringify(malformedArtifact, null, 2)}\n`,
      "utf8",
    );
    await expect(
      resumePairedEvaluation({
        root: resumeRoot,
        live: false,
        judgeModel: "fixture-judge",
        plan: { scenarios: ["equity-aapl-deep"], repetitions: [1] },
        providerForScenario: resumeProvider,
      }),
    ).rejects.toThrow(
      "resume evaluation.json must contain valid fixtures and repetitions plan fields",
    );
  }, 30_000);

  test("an interrupted resume preserves later usable verdicts in the complete snapshot", async () => {
    const root = await tempEvaluationRoot("judge-interrupted-resume");
    const setupJudgeCalls: ModelRequest[] = [];
    const initial = await runPairedEvaluation({
      root,
      fixtureNames: ["equity-aapl-deep"],
      repetitions: 1,
      seed: 91,
      live: false,
      judgeModel: "fixture-judge",
      provider: await fixtureProvider([judgeResponse()], setupJudgeCalls),
    });
    const scenarioRoot = join(root, "equity-aapl-deep");
    await cp(join(scenarioRoot, "repetition-1"), join(scenarioRoot, "repetition-2"), {
      recursive: true,
    });
    await cp(join(scenarioRoot, "repetition-1"), join(scenarioRoot, "repetition-3"), {
      recursive: true,
    });
    const [baseRecord] = initial.records;
    const retainedJudge = baseRecord?.judge;
    if (retainedJudge === undefined || baseRecord === undefined) {
      throw new Error("setup evaluation must contain a usable judge verdict");
    }
    const pendingReason = {
      code: "missing-dimensions" as const,
      message: "prior malformed judge response",
      attempts: 2 as const,
      tokenEstimate: 20,
    };
    const interruptedSetup = {
      ...initial,
      repetitions: 3,
      plan: {
        ...initial.plan,
        repetitions: [1, 2, 3],
        expectedPairCount: 3,
      },
      records: [1, 2, 3].map((repetition) => ({
        ...baseRecord,
        repetition,
        ...(repetition === 2 ? { judge: retainedJudge } : { unjudged: pendingReason }),
        ...(repetition === 2 ? { unjudged: undefined } : { judge: undefined }),
      })),
    };
    await writeFile(
      join(root, DEEP_EQUITY_EVALUATION_FILE),
      `${JSON.stringify(interruptedSetup, null, 2)}\n`,
      "utf8",
    );

    const firstResumeJudgeCalls: ModelRequest[] = [];
    let firstResumeProviderCalls = 0;
    await expect(
      resumePairedEvaluation({
        root,
        live: false,
        judgeModel: "fixture-judge",
        providerForScenario: async () => {
          firstResumeProviderCalls += 1;
          if (firstResumeProviderCalls === 2) {
            throw new Error("simulated process interruption");
          }
          return fixtureProvider([judgeResponse()], firstResumeJudgeCalls);
        },
      }),
    ).rejects.toThrow("simulated process interruption");

    const afterInterruption = JSON.parse(
      await readFile(join(root, DEEP_EQUITY_EVALUATION_FILE), "utf8"),
    ) as typeof initial;
    expect(afterInterruption.records).toHaveLength(3);
    expect(afterInterruption.records.find((record) => record.repetition === 2)?.judge).toEqual(
      retainedJudge,
    );
    expect(afterInterruption.records.find((record) => record.repetition === 3)?.unjudged).toEqual(
      pendingReason,
    );

    const secondResumeJudgeCalls: ModelRequest[] = [];
    let secondResumeProviderCalls = 0;
    const completed = await resumePairedEvaluation({
      root,
      live: false,
      judgeModel: "fixture-judge",
      providerForScenario: async () => {
        secondResumeProviderCalls += 1;
        return fixtureProvider([judgeResponse()], secondResumeJudgeCalls);
      },
    });

    expect(secondResumeProviderCalls).toBe(1);
    expect(secondResumeJudgeCalls).toHaveLength(1);
    expect(completed.records).toHaveLength(3);
    expect(completed.judging.judgedPairCount).toBe(3);
  }, 30_000);

  test("recovers an artifact-free pair with its original random-stream position", async () => {
    const root = await tempEvaluationRoot("missing-pair-stream-alignment");
    const originalJudgeCalls: ModelRequest[] = [];
    const original = await runPairedEvaluation({
      root,
      fixtureNames: ["equity-aapl-deep"],
      repetitions: 3,
      seed: 137,
      live: false,
      judgeModel: "fixture-judge",
      provider: await fixtureProvider([judgeResponse()], originalJudgeCalls),
    });
    const originalTarget = original.records.find((record) => record.repetition === 3);
    const retainedRecords = original.records.filter((record) => record.repetition !== 3);
    if (
      originalTarget?.variantOrder === undefined ||
      originalTarget.judge === undefined ||
      retainedRecords.some((record) => record.judge === undefined)
    ) {
      throw new Error("setup evaluation must record execution order and usable judges");
    }
    await expect(
      resumePairedEvaluation({
        root,
        live: false,
        judgeModel: "fixture-judge",
        recoverMissingPairs: true,
        providerForScenario: async () => {
          throw new Error("complete evaluations must not enter recovery");
        },
      }),
    ).rejects.toThrow("recovery found no planned pairs without arm artifacts");
    await rm(join(root, "equity-aapl-deep", "repetition-3"), {
      recursive: true,
      force: true,
    });
    await writeFile(
      join(root, DEEP_EQUITY_EVALUATION_FILE),
      `${JSON.stringify({ ...original, records: retainedRecords }, null, 2)}\n`,
      "utf8",
    );

    let implicitProviderCalls = 0;
    const implicit = await resumePairedEvaluation({
      root,
      live: false,
      judgeModel: "fixture-judge",
      providerForScenario: async () => {
        implicitProviderCalls += 1;
        throw new Error("missing-pair recovery must be opt-in");
      },
    });
    expect(implicitProviderCalls).toBe(0);
    expect(implicit.records).toHaveLength(2);
    expect(implicit.judging.incompletePairCount).toBe(1);

    const recoveryJudgeCalls: ModelRequest[] = [];
    let recoveryProviderCalls = 0;
    const recovered = await resumePairedEvaluation({
      root,
      live: false,
      judgeModel: "fixture-judge",
      recoverMissingPairs: true,
      providerForScenario: async () => {
        recoveryProviderCalls += 1;
        return fixtureProvider([judgeResponse()], recoveryJudgeCalls);
      },
    });
    const recoveredTarget = recovered.records.find((record) => record.repetition === 3);

    expect(recoveryProviderCalls).toBe(1);
    expect(recoveryJudgeCalls).toHaveLength(1);
    expect(originalTarget.variantOrder).toEqual(["legacy", "simplified"]);
    expect(originalTarget.judge.blindLabels).toEqual({ legacy: "A", simplified: "B" });
    expect(recoveredTarget?.variantOrder).toEqual(originalTarget.variantOrder);
    expect(recoveredTarget?.judge?.blindLabels).toEqual(originalTarget.judge.blindLabels);
    expect(recovered.plan.loadSource).toBe("operator-recovery");
    expect(recovered.judging).toMatchObject({
      expectedPairCount: 3,
      judgedPairCount: 3,
      incompletePairCount: 0,
    });
    for (const retained of retainedRecords) {
      expect(
        recovered.records.find((record) => record.repetition === retained.repetition)?.judge,
      ).toEqual(retained.judge);
    }
  }, 60_000);

  test("recovery refuses a pair with one surviving arm", async () => {
    const root = await tempEvaluationRoot("missing-pair-surviving-arm");
    const original = await runPairedEvaluation({
      root,
      fixtureNames: ["equity-aapl-deep"],
      repetitions: 1,
      seed: 138,
      live: false,
    });
    const legacyRunDir = original.records[0]?.variants.legacy.runDir;
    if (legacyRunDir === undefined) {
      throw new Error("setup evaluation must persist the legacy arm");
    }
    await rm(join(root, "equity-aapl-deep", "repetition-1", "simplified"), {
      recursive: true,
      force: true,
    });
    await writeFile(
      join(root, DEEP_EQUITY_EVALUATION_FILE),
      `${JSON.stringify({ ...original, records: [] }, null, 2)}\n`,
      "utf8",
    );
    let providerCalls = 0;

    await expect(
      resumePairedEvaluation({
        root,
        live: false,
        judgeModel: "fixture-judge",
        recoverMissingPairs: true,
        providerForScenario: async () => {
          providerCalls += 1;
          return fixtureProvider([judgeResponse()], []);
        },
      }),
    ).rejects.toThrow("because arm artifacts already exist");
    expect(providerCalls).toBe(0);
    expect(JSON.parse(await readFile(join(legacyRunDir, "report.json"), "utf8"))).toBeObject();
  }, 30_000);

  test("recovery refuses a recorded outcome even when both arm directories are absent", async () => {
    const root = await tempEvaluationRoot("missing-pair-recorded-outcome");
    await runPairedEvaluation({
      root,
      fixtureNames: ["equity-aapl-deep"],
      repetitions: 1,
      seed: 139,
      live: false,
    });
    await rm(join(root, "equity-aapl-deep", "repetition-1"), {
      recursive: true,
      force: true,
    });
    let providerCalls = 0;

    await expect(
      resumePairedEvaluation({
        root,
        live: false,
        judgeModel: "fixture-judge",
        recoverMissingPairs: true,
        providerForScenario: async () => {
          providerCalls += 1;
          return fixtureProvider([judgeResponse()], []);
        },
      }),
    ).rejects.toThrow("because evaluation.json already records an outcome");
    expect(providerCalls).toBe(0);
    await expect(
      resumePairedEvaluation({
        root,
        live: false,
        judgeModel: "fixture-judge",
        recoverMissingPairs: true,
        forceRejudge: true,
        providerForScenario: async () => fixtureProvider([judgeResponse()], []),
      }),
    ).rejects.toThrow("missing-pair recovery cannot be combined with force re-judging");
  }, 30_000);

  test("manifest-less and plan-less legacy resume keep the operator's missing fixture planned", async () => {
    const sourceRoot = await tempEvaluationRoot("judge-recovery-source");
    await runPairedEvaluation({
      root: sourceRoot,
      fixtureNames: ["equity-aapl-deep"],
      repetitions: 1,
      seed: 105,
      live: false,
    });
    const recoveryRoot = await tempEvaluationRoot("judge-recovery-root");
    const sourceRepetition = join(sourceRoot, "equity-aapl-deep", "repetition-1");
    for (const scenario of ["scenario-a", "scenario-b", "scenario-c"]) {
      await mkdir(join(recoveryRoot, scenario), { recursive: true });
      for (const repetition of [1, 2, 3]) {
        await cp(
          sourceRepetition,
          join(recoveryRoot, scenario, `repetition-${String(repetition)}`),
          {
            recursive: true,
          },
        );
      }
    }
    await expect(readFile(join(recoveryRoot, DEEP_EQUITY_EVALUATION_FILE))).rejects.toThrow();
    await expect(
      resumePairedEvaluation({
        root: recoveryRoot,
        live: false,
        judgeModel: "fixture-judge",
        seed: 106,
        providerForScenario: async () => fixtureProvider([judgeResponse("tie")], []),
      }),
    ).rejects.toThrow(
      "resume without evaluation.json requires an authoritative --fixtures and --repetitions plan",
    );

    const judgeCalls: ModelRequest[] = [];
    const artifact = await resumePairedEvaluation({
      root: recoveryRoot,
      live: false,
      judgeModel: "fixture-judge",
      seed: 106,
      plan: {
        scenarios: ["scenario-a", "scenario-b", "scenario-c", "scenario-d"],
        repetitions: [1, 2, 3],
      },
      providerForScenario: async () => fixtureProvider([judgeResponse("tie")], judgeCalls),
    });
    const missingScenario = artifact.aggregate.scenarios.find(
      (scenario) => scenario.scenario === "scenario-d",
    );

    expect(judgeCalls).toHaveLength(9);
    expect(artifact.plan).toEqual({
      provenance: "operator-recovery-input",
      loadSource: "operator-recovery",
      scenarios: ["scenario-a", "scenario-b", "scenario-c", "scenario-d"],
      repetitions: [1, 2, 3],
      expectedPairCount: 12,
    });
    expect(artifact.judging.expectedPairCount).toBe(12);
    expect(artifact.aggregate).toMatchObject({
      plannedPairCount: 12,
      runCount: 9,
      rubric: { evaluatedPairCount: 9 },
    });
    expect(missingScenario).toMatchObject({
      expectedRepetitions: [1, 2, 3],
      repetitions: [],
      judgedRepetitions: [],
    });
    expect(artifact.gateVerdict.failingGates).toEqual(
      expect.arrayContaining([
        "rubric-non-inferiority",
        "pairwise-loss-rate",
        "scenario-repetition-losses",
      ]),
    );

    const legacyArtifact = structuredClone(artifact) as unknown as Record<string, unknown>;
    delete legacyArtifact.plan;
    legacyArtifact.fixtures = ["scenario-a", "scenario-b", "scenario-c"];
    legacyArtifact.repetitions = 3;
    await writeFile(
      join(recoveryRoot, DEEP_EQUITY_EVALUATION_FILE),
      `${JSON.stringify(legacyArtifact, null, 2)}\n`,
      "utf8",
    );
    let legacyProviderCalls = 0;
    const failIfProviderRequested = async (): Promise<ModelProvider> => {
      legacyProviderCalls += 1;
      throw new Error("stored verdicts must not request a provider");
    };
    await expect(
      resumePairedEvaluation({
        root: recoveryRoot,
        live: false,
        judgeModel: "fixture-judge",
        providerForScenario: failIfProviderRequested,
      }),
    ).rejects.toThrow(
      "resume evaluation.json has no explicit authoritative plan; supply --fixtures and --repetitions to recover this legacy artifact",
    );
    expect(legacyProviderCalls).toBe(0);

    const recoveredLegacy = await resumePairedEvaluation({
      root: recoveryRoot,
      live: false,
      judgeModel: "fixture-judge",
      plan: {
        scenarios: ["scenario-a", "scenario-b", "scenario-c", "scenario-d"],
        repetitions: [1, 2, 3],
      },
      providerForScenario: failIfProviderRequested,
    });

    expect(legacyProviderCalls).toBe(0);
    expect(recoveredLegacy.plan).toEqual({
      provenance: "operator-recovery-input",
      loadSource: "operator-recovery",
      scenarios: ["scenario-a", "scenario-b", "scenario-c", "scenario-d"],
      repetitions: [1, 2, 3],
      expectedPairCount: 12,
    });
    expect(recoveredLegacy.aggregate).toMatchObject({
      plannedPairCount: 12,
      runCount: 9,
      rubric: { evaluatedPairCount: 9 },
    });
    expect(
      recoveredLegacy.aggregate.scenarios.find((scenario) => scenario.scenario === "scenario-d"),
    ).toMatchObject({
      expectedRepetitions: [1, 2, 3],
      repetitions: [],
      judgedRepetitions: [],
    });
    expect(recoveredLegacy.gateVerdict.failingGates).toEqual(
      expect.arrayContaining([
        "rubric-non-inferiority",
        "pairwise-loss-rate",
        "scenario-repetition-losses",
      ]),
    );

    const secondResume = await resumePairedEvaluation({
      root: recoveryRoot,
      live: false,
      judgeModel: "fixture-judge",
      providerForScenario: failIfProviderRequested,
    });
    expect(legacyProviderCalls).toBe(0);
    expect(secondResume.plan).toMatchObject({
      provenance: "operator-recovery-input",
      loadSource: "existing-artifact",
      expectedPairCount: 12,
    });
    expect(secondResume.aggregate).toMatchObject({
      plannedPairCount: 12,
      runCount: 9,
      rubric: { evaluatedPairCount: 9 },
    });

    const forceJudgeCalls: ModelRequest[] = [];
    const forced = await resumePairedEvaluation({
      root: recoveryRoot,
      live: false,
      judgeModel: "fixture-judge",
      forceRejudge: true,
      providerForScenario: async () => fixtureProvider([judgeResponse("tie")], forceJudgeCalls),
    });
    expect(forceJudgeCalls).toHaveLength(9);
    expect(forced.plan).toMatchObject({
      provenance: "operator-recovery-input",
      loadSource: "existing-artifact",
      expectedPairCount: 12,
    });
    expect(forced.aggregate).toMatchObject({
      plannedPairCount: 12,
      runCount: 9,
      rubric: { evaluatedPairCount: 9 },
    });

    const interruptedJudgeCalls: ModelRequest[] = [];
    let interruptedProviderCalls = 0;
    await expect(
      resumePairedEvaluation({
        root: recoveryRoot,
        live: false,
        judgeModel: "fixture-judge",
        forceRejudge: true,
        providerForScenario: async () => {
          interruptedProviderCalls += 1;
          if (interruptedProviderCalls === 2) {
            throw new Error("simulated operator-origin interruption");
          }
          return fixtureProvider([judgeResponse("tie")], interruptedJudgeCalls);
        },
      }),
    ).rejects.toThrow("simulated operator-origin interruption");
    expect(interruptedJudgeCalls).toHaveLength(1);
    const interruptedArtifact = JSON.parse(
      await readFile(join(recoveryRoot, DEEP_EQUITY_EVALUATION_FILE), "utf8"),
    ) as typeof forced;
    expect(interruptedArtifact.plan).toMatchObject({
      provenance: "operator-recovery-input",
      loadSource: "existing-artifact",
      expectedPairCount: 12,
    });
    expect(interruptedArtifact.aggregate.plannedPairCount).toBe(12);

    const postInterruption = await resumePairedEvaluation({
      root: recoveryRoot,
      live: false,
      judgeModel: "fixture-judge",
      providerForScenario: failIfProviderRequested,
    });
    expect(legacyProviderCalls).toBe(0);
    expect(postInterruption.plan).toMatchObject({
      provenance: "operator-recovery-input",
      loadSource: "existing-artifact",
      expectedPairCount: 12,
    });
    expect(postInterruption.aggregate).toMatchObject({
      plannedPairCount: 12,
      runCount: 9,
      rubric: { evaluatedPairCount: 9 },
    });
  }, 30_000);
});
