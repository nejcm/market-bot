import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ModelProvider, ModelRequest, ModelResponse } from "../model/types";
import { buildModelStageRequest } from "../research/model-stage-prompt";
import { synthesizeReportUntilValid } from "../research/final-synthesis";
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
  readSynthesisReplayInput,
  synthesisReplayFacts,
  type SynthesisReplayInput,
} from "./synthesis-input";
import { freshEvalDir, writeEvalJson } from "./eval-output";

type SynthesisReplayResult = ReturnType<typeof finalizeSynthesis> & {
  readonly synthesis: Awaited<ReturnType<typeof synthesizeReportUntilValid>>;
  readonly calls: number;
  readonly markdown: string;
};

export async function executeSynthesisInput(
  saved: SynthesisReplayInput,
  options: {
    readonly promptDir?: string;
    readonly provider?: ModelProvider;
    readonly onRequest?: (request: ModelRequest) => void;
    readonly onResponse?: (response: ModelResponse) => void;
  } = {},
): Promise<SynthesisReplayResult> {
  const { input } = saved;
  const promptDir = options.promptDir ?? resolve(import.meta.dir, "../../prompts");
  const registry = await loadPlaybookRegistry(promptDir);
  const audit = selectPlaybooks(
    playbookScopeWithSubjectKey(input.command, input.collectedSources.resolvedSubject?.subjectKey),
    ["final-synthesis"],
    registry,
  );
  const context = {
    ...input.context,
    domainPlaybooks: await loadPlaybooksByStage(promptDir, registry, audit.selected),
  };
  const provider = options.provider ?? makeReplayProvider(saved.responses);
  let calls = 0;
  const { allowedSubjects: _allowedSubjects, ...phaseInput } = input;
  const synthesis = await synthesizeReportUntilValid({
    ...phaseInput,
    context,
    knownSourceIds: new Set(input.knownSourceIds),
    ...(input.allowedSubjects === undefined
      ? {}
      : { allowedSubjects: new Set(input.allowedSubjects) }),
    runFinalSynthesis: async (priorStages, reprompt) => {
      const { request, steering } = await buildModelStageRequest(
        "final-synthesis",
        context.runParams.synthesisModel,
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

export async function replaySynthesisFile(options: {
  readonly input: string;
  readonly label: string;
  readonly root?: string;
  readonly provider?: ModelProvider;
  readonly promptDir?: string;
}): Promise<{
  readonly status: "completed" | "failed";
  readonly dir: string;
  readonly durationMs: number;
}> {
  const saved = readSynthesisReplayInput(JSON.parse(await readFile(options.input, "utf8")));
  const dir = await freshEvalDir(options.label, options.root);
  const started = performance.now();
  const requests: ModelRequest[] = [];
  let status: "completed" | "failed" = "completed";
  let failureMessage: string | undefined = undefined;
  let calls = 0;
  let tokens = 0;
  const modelMisses: string[] = [];
  let facts: ReturnType<typeof synthesisReplayFacts> | undefined = undefined;
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
    });
    ({ calls } = result);
    facts = synthesisReplayFacts(result.report);
    await writeEvalJson(dir, "report.json", result.report);
    await writeFile(join(dir, "report.md"), result.markdown);
    await writeEvalJson(dir, "synthesis.json", result.synthesis);
    await writeEvalJson(dir, "validation.json", {
      warnings: result.postSynthesisWarnings,
      integrity: result.integrityAudit,
    });
  } catch (error) {
    status = "failed";
    failureMessage = error instanceof Error ? error.message : String(error);
    if (error instanceof ModelReplayError) {
      modelMisses.push(error.key);
    }
  }
  const durationMs = performance.now() - started;
  await writeEvalJson(dir, "requests.json", requests);
  await writeEvalJson(dir, "eval-sample.json", {
    status,
    scope: "final-synthesis-only",
    partial: true,
    input: resolve(options.input),
    durationMs,
    error: failureMessage,
    modelCalls: {
      replayed: options.provider === undefined ? calls : 0,
      live: options.provider === undefined ? 0 : requests.length,
    },
    completedCalls: calls,
    attemptedCalls: requests.length,
    tokens: {
      replayed: options.provider === undefined ? tokens : 0,
      live: options.provider === undefined ? 0 : tokens,
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

export async function estimateSynthesisFile(input: string): Promise<{
  readonly observedCalls: number;
  readonly boundedCalls: number;
  readonly maxInputTokens: number;
  readonly perRun: number;
  readonly expectedPerRun: number;
}> {
  const saved = readSynthesisReplayInput(JSON.parse(await readFile(input, "utf8")));
  const requests: ModelRequest[] = [];
  await executeSynthesisInput(saved, {
    onRequest: (request) => {
      requests.push(request);
    },
  });
  const maxInputTokens = Math.max(
    ...requests.map((request) =>
      Math.ceil(request.messages.reduce((sum, row) => sum + row.content.length, 0) / 4),
    ),
  );
  const boundedCalls = 1 + saved.input.maxPredictionReprompts + 4;
  return {
    observedCalls: requests.length,
    boundedCalls,
    maxInputTokens,
    perRun: Math.ceil(boundedCalls * (maxInputTokens + 50_000) * 1.25),
    expectedPerRun: Object.values(saved.responses.entries)
      .flat()
      .reduce((sum, response) => sum + response.tokenEstimate, 0),
  };
}
