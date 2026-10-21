import { readFile, writeFile } from "node:fs/promises";
import type { JudgeCalibration } from "./judge-telemetry";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "../guards";
import type { ModelProvider, ModelRequest, ModelResponse } from "../model/types";
import { buildModelStageRequest } from "../research/model-stage-prompt";
import {
  plannedResearchStages,
  runAnalysisPhase,
  type AnalysisStage,
} from "../research/analysis-phase";
import {
  MAX_REPORT_VALIDATION_REPROMPTS,
  synthesizeReportUntilValid,
} from "../research/final-synthesis";
import { finalizeSynthesis } from "../research/finalize-synthesis";
import { renderMarkdownReport } from "../report/markdown";
import {
  loadPlaybookRegistry,
  loadPlaybooksByStage,
  playbookScopeWithSubjectKey,
  selectPlaybooks,
} from "../research/playbooks";
import { makeReplayProvider, ModelReplayError } from "./llm-cassette";
import {
  loadSynthesisReplayInput,
  synthesisReplayFacts,
  type SynthesisReplayInput,
} from "./synthesis-input";
import { freshEvalDir, writeEvalJson } from "./eval-output";
import {
  cancelMatchedItems,
  digestJudgeItems,
  judgeReport,
  reportJudgeItems,
  scoreReportDefects,
  type OmissionCase,
} from "./eval-cases";
import { estimateJudgeTokens, JUDGE_MAJORITY_VOTES, type JudgeMeter } from "./eval-judge";
import { ABLATION_ARMS } from "./eval-decision";
import { finalSynthesisEvidencePayload } from "../research/prompts/final-synthesis";
import { collectedCodeAssembledExtraKeys } from "../research/extended-evidence-projections";

type AblationArm = keyof typeof ABLATION_ARMS;

async function loadAblatedInput(
  input: string,
  arm: AblationArm | undefined,
): Promise<SynthesisReplayInput> {
  const saved = await loadSynthesisReplayInput(input);
  if (arm === undefined) {
    return saved;
  }
  const { stage, removed, regenerated } = ABLATION_ARMS[arm];
  // Market Overview panels consume specialist output too; the arms only encode the equity graph.
  if (saved.input.command.jobType !== "equity") {
    throw new Error(`Cannot ablate ${arm}: only equity inputs are supported`);
  }
  if (!saved.input.priorStages.some((row) => row.stage === stage)) {
    throw new Error(`Cannot ablate ${arm}: the saved input has no ${stage} stage`);
  }
  if (regenerated.length > 0) {
    return saved;
  }
  const dropped: readonly string[] = removed;
  const priorStages = saved.input.priorStages.filter((row) => !dropped.includes(row.stage));
  return { ...saved, input: { ...saved.input, priorStages } };
}

function captureOmissionCases(
  saved: SynthesisReplayInput,
  cases: readonly OmissionCase[] | undefined,
): readonly OmissionCase[] {
  return (cases ?? []).filter((row) => row.capture === saved.input.runId);
}

// The evidence projection the final-synthesis prompt carries; judge and figure checks see nothing else.
export function judgeEvidence(saved: SynthesisReplayInput): Record<string, unknown> {
  const { input } = saved;
  return finalSynthesisEvidencePayload({
    command: input.command,
    collectedSources: input.collectedSources,
    config: input.settings,
    context: input.context,
  });
}

// Frozen upstream, live consumers; offline (no provider) a consumer's frozen output stands in for its regeneration.
async function regenerateAnalysis(
  saved: SynthesisReplayInput,
  arm: {
    readonly stage: AnalysisStage;
    readonly removed: readonly AnalysisStage[];
    readonly regenerated: readonly AnalysisStage[];
  },
  options: {
    readonly context: SynthesisReplayInput["input"]["context"];
    readonly promptDir: string;
    readonly model: string;
    readonly provider: ModelProvider | undefined;
    readonly onAnalysisCall: AnalysisCall | undefined;
  },
): Promise<SynthesisReplayInput["input"]["priorStages"]> {
  const { input } = saved;
  const { regenerated }: { readonly regenerated: readonly string[] } = arm;
  const { analysisOutputs, critiqueOutput } = await runAnalysisPhase({
    command: input.command,
    collectedSources: input.collectedSources,
    context: options.context,
    quickModel: options.model,
    ...(arm.removed.length === 0
      ? {}
      : { skipStage: arm.stage as Exclude<AnalysisStage, "critique"> }),
    runStage: async (stage, model, stageInput) => {
      const frozen = input.priorStages.find((row) => row.stage === stage);
      if (!regenerated.includes(stage)) {
        if (frozen === undefined) {
          throw new Error(`Saved input has no frozen ${stage} stage`);
        }
        return frozen;
      }
      const { request } = await buildModelStageRequest(stage, model, options.promptDir, {
        command: input.command,
        collectedSources: stageInput.collectedSources,
        context: stageInput.context,
        config: input.settings,
        priorStages: stageInput.priorStages ?? [],
        predictionRepromptErrors: [],
        reportValidationErrors: [],
        allowedSourceIds: [],
      });
      const response =
        options.provider === undefined
          ? { content: frozen?.content ?? "{}", tokenEstimate: frozen?.tokenEstimate ?? 0 }
          : await options.provider.generate(request);
      options.onAnalysisCall?.({ request, response });
      return { stage, content: response.content, tokenEstimate: response.tokenEstimate };
    },
  });
  return [...analysisOutputs, critiqueOutput];
}

type SynthesisReplayResult = ReturnType<typeof finalizeSynthesis> & {
  readonly synthesis: Awaited<ReturnType<typeof synthesizeReportUntilValid>>;
  readonly calls: number;
  readonly markdown: string;
};

type AnalysisCall = (call: {
  readonly request: ModelRequest;
  readonly response: Pick<ModelResponse, "tokenEstimate">;
}) => void;

export async function executeSynthesisInput(
  saved: SynthesisReplayInput,
  options: {
    readonly promptDir?: string;
    readonly provider?: ModelProvider;
    readonly onRequest?: (request: ModelRequest) => void;
    readonly onResponse?: (response: ModelResponse) => void;
    readonly ablation?: AblationArm | undefined;
    readonly models?: { readonly quick: string; readonly synthesis: string };
    readonly onAnalysisCall?: AnalysisCall;
  } = {},
): Promise<SynthesisReplayResult> {
  const { input } = saved;
  const arm = options.ablation === undefined ? undefined : ABLATION_ARMS[options.ablation];
  const isolated = arm !== undefined && arm.regenerated.length > 0;
  const promptDir = options.promptDir ?? resolve(import.meta.dir, "../../prompts");
  const registry = await loadPlaybookRegistry(promptDir);
  const audit = selectPlaybooks(
    playbookScopeWithSubjectKey(input.command, input.collectedSources.resolvedSubject?.subjectKey),
    isolated ? plannedResearchStages(input.command) : ["final-synthesis"],
    registry,
  );
  const context = {
    ...input.context,
    domainPlaybooks: await loadPlaybooksByStage(promptDir, registry, audit.selected),
  };
  const models = options.models ?? {
    quick: context.runParams.quickModel,
    synthesis: context.runParams.synthesisModel,
  };
  const provider = options.provider ?? makeReplayProvider(saved.responses);
  const analysisStages = isolated
    ? await regenerateAnalysis(saved, arm, {
        context,
        promptDir,
        model: models.quick,
        provider: options.provider,
        onAnalysisCall: options.onAnalysisCall,
      })
    : input.priorStages;
  let calls = 0;
  const { allowedSubjects: _allowedSubjects, ...phaseInput } = input;
  const synthesis = await synthesizeReportUntilValid({
    ...phaseInput,
    priorStages: analysisStages,
    context,
    knownSourceIds: new Set(input.knownSourceIds),
    ...(input.allowedSubjects === undefined
      ? {}
      : { allowedSubjects: new Set(input.allowedSubjects) }),
    runFinalSynthesis: async (priorStages, reprompt) => {
      const { request, steering } = await buildModelStageRequest(
        "final-synthesis",
        models.synthesis,
        promptDir,
        {
          command: input.command,
          collectedSources: input.collectedSources,
          context,
          config: input.settings,
          priorStages,
          predictionRepromptErrors: reprompt?.predictionErrors ?? [],
          reportValidationErrors: reprompt?.reportValidationErrors ?? [],
          allowedSourceIds: reprompt?.allowedSourceIds ?? [],
        },
      );
      options.onRequest?.(request);
      calls += 1;
      const response = await provider.generate(request);
      options.onResponse?.(response);
      return {
        stage: "final-synthesis",
        ...response,
        ...(steering === undefined ? {} : { steering }),
      };
    },
  });
  const collected = { ...input.collectedSources, sourceGaps: synthesis.sourceGaps };
  const finalized = finalizeSynthesis(synthesis, collected, context.evidenceQualityAssessment!);
  const snapshot = collected.marketSnapshots.find(
    (row) => "symbol" in input.command && row.symbol === input.command.symbol,
  );
  return {
    ...finalized,
    synthesis,
    calls,
    markdown: renderMarkdownReport(finalized.report, snapshot, collected),
  };
}

const inputTokens = (request: ModelRequest) =>
  Math.ceil(request.messages.reduce((sum, row) => sum + row.content.length, 0) / 4);

function armRecord(ablation: AblationArm | undefined) {
  if (ablation === undefined) {
    return undefined;
  }
  const { stage: _stage, ...arm } = ABLATION_ARMS[ablation];
  return { name: ablation, ...arm };
}

export async function replaySynthesisFile(options: {
  readonly input: string;
  readonly label: string;
  readonly root?: string;
  readonly provider?: ModelProvider;
  readonly promptDir?: string;
  readonly ablation?: AblationArm | undefined;
  readonly models?: { readonly quick: string; readonly synthesis: string };
  readonly omissionCases?: readonly OmissionCase[];
  readonly judge?: { readonly provider: ModelProvider; readonly model: string };
}): Promise<{
  readonly status: "completed" | "failed";
  readonly dir: string;
  readonly durationMs: number;
}> {
  const saved = await loadAblatedInput(options.input, options.ablation);
  const omissionCases = captureOmissionCases(saved, options.omissionCases);
  const dir = await freshEvalDir(options.label, options.root);
  const started = performance.now();
  const requests: ModelRequest[] = [];
  let status: "completed" | "failed" = "completed";
  let failureMessage: string | undefined = undefined;
  let calls = 0;
  let tokens = 0;
  let analysisCalls = 0;
  let analysisTokens = 0;
  const modelMisses: string[] = [];
  let facts: ReturnType<typeof synthesisReplayFacts> | undefined = undefined;
  let defects: ReturnType<typeof scoreReportDefects> | undefined = undefined;
  let judged: Awaited<ReturnType<typeof judgeReport>> | undefined = undefined;
  const judgeMeter: JudgeMeter = { calls: 0, tokens: 0 };
  try {
    const result = await executeSynthesisInput(saved, {
      ...options,
      onRequest: (request) => {
        requests.push(request);
      },
      onResponse: (response) => {
        calls += 1;
        tokens += response.tokenEstimate;
      },
      onAnalysisCall: ({ request, response }) => {
        requests.push(request);
        analysisCalls += 1;
        analysisTokens += response.tokenEstimate;
      },
    });
    ({ calls } = result);
    facts = synthesisReplayFacts(result.report);
    const evidence = judgeEvidence(saved);
    defects = scoreReportDefects({
      report: result.report,
      knownSourceIds: saved.input.knownSourceIds,
      historicalContext: saved.input.context.historicalContext,
      evidence,
      omissionCases,
    });
    await writeEvalJson(dir, "report.json", result.report);
    await writeFile(join(dir, "report.md"), result.markdown);
    await writeEvalJson(dir, "synthesis.json", result.synthesis);
    await writeEvalJson(dir, "validation.json", {
      warnings: result.postSynthesisWarnings,
      integrity: result.integrityAudit,
    });
    if (options.judge !== undefined) {
      judged = await judgeReport(
        options.judge.provider,
        options.judge.model,
        reportJudgeItems(result.report, omissionCases, evidence),
        judgeMeter,
      );
    }
  } catch (error) {
    status = "failed";
    failureMessage = error instanceof Error ? error.message : String(error);
    if (error instanceof ModelReplayError) {
      modelMisses.push(error.key);
    }
  }
  const durationMs = performance.now() - started;
  const live = options.provider !== undefined;
  const generationCalls = live ? requests.length : analysisCalls + calls;
  const generationTokens = analysisTokens + tokens;
  await writeEvalJson(dir, "requests.json", requests);
  await writeEvalJson(dir, "eval-sample.json", {
    status,
    scope: "final-synthesis-only",
    partial: true,
    input: resolve(options.input),
    arm: armRecord(options.ablation),
    defects,
    judged,
    judgeMode: options.judge === undefined ? "skipped" : "k=3",
    durationMs,
    error: failureMessage,
    modelCalls: {
      replayed: live ? 0 : generationCalls,
      live: (live ? generationCalls : 0) + judgeMeter.calls,
      analysis: analysisCalls,
      synthesis: calls,
      judge: judgeMeter.calls,
    },
    completedCalls: analysisCalls + calls,
    attemptedCalls: requests.length,
    tokens: {
      replayed: live ? 0 : generationTokens,
      live: (live ? generationTokens : 0) + judgeMeter.tokens,
      analysis: analysisTokens,
      synthesis: tokens,
      judge: judgeMeter.tokens,
    },
    modelReplayMisses: modelMisses,
    baseline: saved.baseline,
    facts,
    comparison:
      saved.baseline === undefined || facts === undefined
        ? undefined
        : {
            predictionDelta: facts.predictions - saved.baseline.predictions,
            findingDelta: facts.findings - saved.baseline.findings,
            sourceDelta: facts.sources - saved.baseline.sources,
            dataGapDelta: facts.dataGaps - saved.baseline.dataGaps,
            addedClaims: facts.claims.filter((claim) => !saved.baseline!.claims.includes(claim)),
            removedClaims: saved.baseline.claims.filter((claim) => !facts!.claims.includes(claim)),
          },
    metrics: {
      baselineResponses: Object.values(saved.responses.entries).reduce(
        (sum, rows) => sum + rows.length,
        0,
      ),
      calls,
    },
  });
  return { status, dir, durationMs };
}

type SampleResult = Awaited<ReturnType<typeof replaySynthesisFile>>;

async function addPairedJudgement(
  sample: SampleResult,
  judged: object | undefined,
  meter: JudgeMeter,
  error: string | undefined,
): Promise<SampleResult> {
  const record = JSON.parse(await readFile(join(sample.dir, "eval-sample.json"), "utf8"));
  const status = error === undefined ? sample.status : "failed";
  await writeEvalJson(sample.dir, "eval-sample.json", {
    ...record,
    status,
    judged,
    judgeMode: "k=3",
    error: error ?? record.error,
    modelCalls: {
      ...record.modelCalls,
      live: record.modelCalls.live + meter.calls,
      judge: meter.calls,
    },
    tokens: { ...record.tokens, live: record.tokens.live + meter.tokens, judge: meter.tokens },
  });
  return { ...sample, status };
}

// One pre-paired sample index: control and ablation generate first, then judge with matched requests canceled.
export async function replayPairedSample(options: {
  readonly input: string;
  readonly index: number;
  readonly root: string;
  readonly ablation: AblationArm;
  readonly provider: ModelProvider;
  readonly models?: { readonly quick: string; readonly synthesis: string };
  readonly omissionCases?: readonly OmissionCase[];
  readonly judge: { readonly provider: ModelProvider; readonly model: string };
}): Promise<{ readonly control: SampleResult; readonly ablation: SampleResult }> {
  const { judge, index, ablation: ablationArm, ...shared } = options;
  const definition = ABLATION_ARMS[ablationArm];
  if (!("control" in definition)) {
    throw new Error(`${ablationArm} is a control arm, not an ablation`);
  }
  const control = await replaySynthesisFile({
    ...shared,
    label: `control-${String(index)}`,
    ...(definition.control === "baseline" ? {} : { ablation: definition.control }),
  });
  const ablation = await replaySynthesisFile({
    ...shared,
    label: `ablation-${String(index)}`,
    ablation: ablationArm,
  });
  if (control.status === "failed" || ablation.status === "failed") {
    return { control, ablation };
  }
  const saved = await loadSynthesisReplayInput(options.input);
  const evidence = judgeEvidence(saved);
  const omissionCases = captureOmissionCases(saved, options.omissionCases);
  const items = async (sample: SampleResult) =>
    reportJudgeItems(
      JSON.parse(await readFile(join(sample.dir, "report.json"), "utf8")),
      omissionCases,
      evidence,
    );
  const controlItems = await items(control);
  const ablationItems = await items(ablation);
  const paired = cancelMatchedItems(controlItems, ablationItems);
  const meters = { control: { calls: 0, tokens: 0 }, ablation: { calls: 0, tokens: 0 } };
  const judged: Partial<Record<"control" | "ablation", object>> = {};
  let judgeError: string | undefined = undefined;
  try {
    const controlResult = await judgeReport(
      judge.provider,
      judge.model,
      paired.control,
      meters.control,
    );
    const ablationResult = await judgeReport(
      judge.provider,
      judge.model,
      paired.ablation,
      meters.ablation,
    );
    const { sharedConveyance } = paired;
    judged.control = {
      ...controlResult,
      items: controlItems.length,
      canceled: paired.canceled.map((pair) => pair.control),
      sharedConveyance,
    };
    judged.ablation = {
      ...ablationResult,
      items: ablationItems.length,
      unconveyed: [
        ...ablationResult.unconveyed,
        ...controlResult.unconveyed.filter((key) => sharedConveyance.includes(key)),
      ],
      canceled: paired.canceled.map((pair) => pair.ablation),
      sharedConveyance,
    };
  } catch (error) {
    judgeError = error instanceof Error ? error.message : String(error);
  }
  return {
    control: await addPairedJudgement(control, judged.control, meters.control, judgeError),
    ablation: await addPairedJudgement(ablation, judged.ablation, meters.ablation, judgeError),
  };
}

// Tokens a provider bills per call beyond prompt and visible output (codex: CLI instructions and reasoning), measured on the recorded synthesis calls.
function measuredCallOverhead(
  calls: readonly { readonly request: ModelRequest; readonly response: ModelResponse }[],
): number {
  return Math.max(
    0,
    ...calls.map(
      ({ request, response }) =>
        response.tokenEstimate - inputTokens(request) - Math.ceil(response.content.length / 4),
    ),
  );
}

// The --input planning line; without the judge the totals are generation only.
export function formatSynthesisEstimate(
  estimate: Awaited<ReturnType<typeof estimateSynthesisFile>>,
  samples: number,
  judge: boolean,
  overheadNote: string,
): string {
  const arm =
    estimate.arm === undefined
      ? ""
      : ` arm ${estimate.arm.name} (removed: ${estimate.arm.removed.join(", ")}; regenerated live: ${estimate.arm.regenerated.join(", ") || "none"})`;
  const judged = judge
    ? `k=3 report judge: ${String(estimate.judgeItems)} item(s)/sample (${overheadNote}), ~${String(estimate.judgePerRun * samples)} tokens. Total expected ~${String(estimate.totalExpectedPerRun * samples)}, worst case ~${String(estimate.totalWorstPerRun * samples)}.`
    : `Report judge skipped (--no-judge): figure metrics only, no judged verdicts. Total expected ~${String(estimate.expectedPerRun * samples)}, worst case ~${String(estimate.perRun * samples)}.`;
  return `Final synthesis input${arm}: ${String(estimate.observedCalls)} recorded synthesis call(s). Generation expected ~${String(estimate.expectedPerRun * samples)} tokens at the recorded call count and token use; worst case (all ${String(estimate.boundedCalls)} bounded synthesis calls/sample, 25% headroom) ~${String(estimate.perRun * samples)}. ${judged} Not a provider-enforced cost cap.\n`;
}

export async function estimateSynthesisFile(
  input: string,
  ablation?: AblationArm,
  omissionCases?: readonly OmissionCase[],
): Promise<{
  readonly arm: ReturnType<typeof armRecord>;
  readonly observedCalls: number;
  readonly boundedCalls: number;
  readonly maxInputTokens: number;
  readonly callOverhead: number;
  readonly captureIdentity: { readonly provider: string; readonly model: string } | undefined;
  readonly perRun: number;
  readonly expectedPerRun: number;
  readonly judgeItems: number;
  readonly judgePerRun: number;
  readonly judgeEarlyStopPerRun: number;
  readonly judgeAlwaysCanceled: {
    readonly items: number;
    readonly perRun: number;
    readonly earlyStopPerRun: number;
  };
  readonly totalExpectedPerRun: number;
  readonly totalEarlyStopPerRun: number;
  readonly totalWorstPerRun: number;
}> {
  const saved = await loadAblatedInput(input, ablation);
  const requests: ModelRequest[] = [];
  const calls: { request: ModelRequest; response: ModelResponse }[] = [];
  let analysisExpected = 0;
  let analysisWorst = 0;
  const { report } = await executeSynthesisInput(saved, {
    ablation,
    onRequest: (request) => {
      requests.push(request);
    },
    onResponse: (response) => {
      calls.push({ request: requests.at(-1)!, response });
    },
    onAnalysisCall: ({ request, response }) => {
      analysisExpected += response.tokenEstimate;
      analysisWorst += Math.ceil((inputTokens(request) + 50_000) * 1.25);
    },
  });
  const maxInputTokens = Math.max(...requests.map((request) => inputTokens(request)));
  const boundedCalls = 1 + saved.input.maxPredictionReprompts + 2 + MAX_REPORT_VALIDATION_REPROMPTS;
  const callOverhead = measuredCallOverhead(calls);
  const settings: unknown = await readFile(join(dirname(input), "meta.json"), "utf8")
    .then((text) => JSON.parse(text).settings)
    .catch(() => undefined);
  const judgeItems = reportJudgeItems(
    report,
    captureOmissionCases(saved, omissionCases),
    judgeEvidence(saved),
  );
  const judgeTokens = (rows: typeof judgeItems, votes?: number) =>
    estimateJudgeTokens(
      rows.map((row) => row.item),
      votes,
      callOverhead,
    );
  const alwaysCanceled = digestJudgeItems(
    judgeItems,
    collectedCodeAssembledExtraKeys(saved.input.collectedSources),
  );
  const judgePerRun = judgeTokens(judgeItems);
  // Lower bound: every judgment stops after its first votes agree.
  const judgeEarlyStopPerRun = judgeTokens(judgeItems, JUDGE_MAJORITY_VOTES);
  const perRun = Math.ceil(boundedCalls * (maxInputTokens + 50_000) * 1.25) + analysisWorst;
  const expectedPerRun =
    Object.values(saved.responses.entries)
      .flat()
      .reduce((sum, response) => sum + response.tokenEstimate, 0) + analysisExpected;
  return {
    arm: armRecord(ablation),
    judgeItems: judgeItems.length,
    judgePerRun,
    judgeEarlyStopPerRun,
    judgeAlwaysCanceled: {
      items: alwaysCanceled.length,
      perRun: judgeTokens(alwaysCanceled),
      earlyStopPerRun: judgeTokens(alwaysCanceled, JUDGE_MAJORITY_VOTES),
    },
    observedCalls: requests.length,
    boundedCalls,
    maxInputTokens,
    callOverhead,
    captureIdentity:
      isRecord(settings) &&
      typeof settings.provider === "string" &&
      typeof settings.synthesisModel === "string"
        ? { provider: settings.provider, model: settings.synthesisModel }
        : undefined,
    perRun,
    expectedPerRun,
    totalExpectedPerRun: expectedPerRun + judgePerRun,
    totalEarlyStopPerRun: expectedPerRun + judgeEarlyStopPerRun,
    totalWorstPerRun: perRun + judgePerRun,
  };
}

type SynthesisEstimate = Awaited<ReturnType<typeof estimateSynthesisFile>>;

// Both arms' per-sample estimates times samples. A judge calibration prices judged items by measured votes and tokens, deducting cancellation measured on the same capture and arm, else only the provable digest units; without one the heuristic range applies. Worst case stays the heuristic bound.
export function approvalSubsetEstimate(
  ablation: SynthesisEstimate,
  control: SynthesisEstimate,
  samples: number,
  calibration?: JudgeCalibration,
): { readonly earlyStop: number; readonly expected: number; readonly worst: number } {
  const canceled = ablation.judgeAlwaysCanceled;
  const worst = (ablation.totalWorstPerRun + control.totalWorstPerRun - canceled.perRun) * samples;
  if (calibration !== undefined) {
    const { cancelShare } = calibration;
    const judged =
      cancelShare.ablation === undefined || cancelShare.control === undefined
        ? ablation.judgeItems + control.judgeItems - canceled.items
        : ablation.judgeItems * (1 - cancelShare.ablation) +
          control.judgeItems * (1 - cancelShare.control);
    const calibrated = Math.ceil(
      (ablation.expectedPerRun +
        control.expectedPerRun +
        judged * calibration.votesPerJudgedItem * calibration.tokensPerCall) *
        samples,
    );
    return { earlyStop: calibrated, expected: calibrated, worst: Math.max(worst, calibrated) };
  }
  return {
    earlyStop:
      (ablation.totalEarlyStopPerRun + control.totalEarlyStopPerRun - canceled.earlyStopPerRun) *
      samples,
    expected:
      (ablation.totalExpectedPerRun + control.totalExpectedPerRun - canceled.perRun) * samples,
    worst,
  };
}
