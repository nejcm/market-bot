import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { readRecordedBody } from "./body-file";
import type { CodeVersion } from "../domain/run-trace";
import { isRecord } from "../guards";
import type { SynthesizeReportUntilValidInput } from "../research/final-synthesis";
import type { StageSettings } from "../research/prompts/stage-envelope";
import type { LlmCassette } from "./llm-cassette";
import { SOURCE_KINDS } from "../domain/sources";
import { isMarketRegimeLabel, type ResearchReport } from "../domain/report";
import { readEquityAnalysisCompleteness } from "../domain/equity-analysis-completeness";
import {
  readSourcePlan,
  readEvidenceLanes,
  readSourceLedger,
  readWebSubjectProfileArtifact,
} from "../run-artifact-evidence-reader";
import {
  isBusinessFrameworkSectionName,
  isBusinessLifecyclePhase,
  isBusinessFrameworkPosture,
} from "../sources/extended-evidence/business-framework";

type PhaseInput = Omit<
  SynthesizeReportUntilValidInput,
  "knownSourceIds" | "allowedSubjects" | "runFinalSynthesis"
> & {
  readonly knownSourceIds: readonly string[];
  readonly allowedSubjects?: readonly string[];
  readonly settings: StageSettings;
};

export interface SynthesisReplayInput {
  readonly version: 1;
  readonly phase: "final-synthesis";
  readonly invocation: "initial-with-repairs";
  readonly codeVersion: CodeVersion;
  readonly input: PhaseInput;
  readonly responses: LlmCassette;
  readonly promptProvenance: readonly { readonly model: string; readonly requestSha256: string }[];
  readonly baseline?: ReturnType<typeof synthesisReplayFacts>;
}

export function synthesisReplayFacts(report: ResearchReport): {
  readonly predictions: number;
  readonly findings: number;
  readonly sources: number;
  readonly dataGaps: number;
  readonly claims: readonly string[];
} {
  return {
    predictions: report.predictions.length,
    findings: report.keyFindings.length,
    sources: report.sources.length,
    dataGaps: report.dataGaps.length,
    claims: report.predictions.map((row) => row.measurableAs),
  };
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sources(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        isRecord(row) &&
        typeof row.id === "string" &&
        row.id.length > 0 &&
        typeof row.title === "string" &&
        typeof row.kind === "string" &&
        SOURCE_KINDS.some((kind) => kind === row.kind) &&
        typeof row.fetchedAt === "string" &&
        Number.isFinite(Date.parse(row.fetchedAt)),
    )
  );
}

function assessment(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.version === 1 &&
    [1, 2, 3].includes(Number(value.rubricVersion)) &&
    ["high", "medium", "low"].includes(String(value.label)) &&
    strings(value.limitingReasons) &&
    strings(value.advisoryReasons) &&
    Array.isArray(value.checks) &&
    value.checks.every(
      (row) =>
        isRecord(row) &&
        typeof row.capability === "string" &&
        ["core", "material", "supplemental"].includes(String(row.evidenceClass)) &&
        ["pass", "fail"].includes(String(row.coverage)) &&
        ["pass", "fail", "not-applicable"].includes(String(row.freshness)) &&
        ["pass", "fail", "not-applicable"].includes(String(row.corroboration)) &&
        typeof row.passed === "boolean" &&
        strings(row.reasons),
    )
  );
}

function contextInputs(context: Record<string, unknown>): boolean {
  const profile = context.depthProfile;
  const params = context.runParams;
  if (
    !isRecord(profile) ||
    !isRecord(params) ||
    !isRecord(context.marketRegime) ||
    !isMarketRegimeLabel(context.marketRegime.label) ||
    !assessment(context.evidenceQualityAssessment)
  ) {
    return false;
  }
  for (const record of [profile, params]) {
    if (
      !["concise brief", "fuller analyst-style"].includes(String(record.analystStyle)) ||
      ![
        "minimumKeyFindings",
        "minimumScenarios",
        "targetPredictions",
        "defaultPredictionHorizon",
      ].every((key) => finite(record[key])) ||
      !strings(record.predictionSubjects) ||
      !strings(record.focus) ||
      !isRecord(record.targetKindMix) ||
      !strings(record.targetKindMix.favored)
    ) {
      return false;
    }
  }
  if (typeof params.quickModel !== "string" || typeof params.synthesisModel !== "string") {
    return false;
  }
  const planning = context.sourcePlanning;
  if (
    planning !== undefined &&
    (!isRecord(planning) ||
      readSourcePlan(planning.sourcePlan) === undefined ||
      readEvidenceLanes(planning.evidenceLanes) === undefined ||
      readSourceLedger(planning.sourceLedger) === undefined)
  ) {
    return false;
  }
  const history = context.historicalContext;
  if (
    history !== undefined &&
    (!isRecord(history) ||
      !sources(history.sources) ||
      !Array.isArray(history.runs) ||
      !strings(history.gaps) ||
      !Array.isArray(history.artifactDeltas) ||
      !isRecord(history.audit) ||
      !history.runs.every(
        (row) =>
          isRecord(row) &&
          typeof row.summary === "string" &&
          ["keyFindings", "risks", "catalysts", "predictions"].every((key) =>
            Array.isArray(row[key]),
          ) &&
          strings(row.dataGaps),
      ))
  ) {
    return false;
  }
  return true;
}

function collectedInputs(value: Record<string, unknown>): boolean {
  if (
    !["newsSources", "extendedSources", "marketContextSources"].every((key) => sources(value[key]))
  ) {
    return false;
  }
  if (
    !["marketSnapshots", "supplementalMarketSnapshots"].every(
      (key) =>
        Array.isArray(value[key]) &&
        value[key].every(
          (row: unknown) =>
            isRecord(row) &&
            typeof row.symbol === "string" &&
            typeof row.sourceId === "string" &&
            typeof row.price === "number" &&
            Number.isFinite(row.price) &&
            ["equity", "crypto"].includes(String(row.assetClass)),
        ),
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(value.sourceGaps) ||
    !value.sourceGaps.every(
      (row) => isRecord(row) && typeof row.source === "string" && typeof row.message === "string",
    )
  ) {
    return false;
  }
  if (
    value.extendedEvidence !== undefined &&
    (!isRecord(value.extendedEvidence) ||
      !Array.isArray(value.extendedEvidence.items) ||
      !value.extendedEvidence.items.every(
        (row) => isRecord(row) && typeof row.summary === "string" && strings(row.sourceIds),
      ) ||
      !Array.isArray(value.extendedEvidence.gaps))
  ) {
    return false;
  }
  const framework = value.businessFramework;
  if (
    framework !== undefined &&
    (!isRecord(framework) ||
      ![1, 2, 3].includes(Number(framework.version)) ||
      typeof framework.phase !== "string" ||
      !isBusinessLifecyclePhase(framework.phase) ||
      !strings(framework.sourceIds) ||
      !Array.isArray(framework.gaps) ||
      !Array.isArray(framework.sections) ||
      !framework.sections.every(
        (row) =>
          isRecord(row) &&
          typeof row.name === "string" &&
          isBusinessFrameworkSectionName(row.name) &&
          typeof row.posture === "string" &&
          isBusinessFrameworkPosture(row.posture) &&
          typeof row.summary === "string" &&
          strings(row.metricSectionIds) &&
          strings(row.sourceIds) &&
          Array.isArray(row.gaps),
      ))
  ) {
    return false;
  }
  if (
    value.metricSections !== undefined &&
    (!Array.isArray(value.metricSections) ||
      !value.metricSections.every(
        (row) =>
          isRecord(row) &&
          typeof row.id === "string" &&
          typeof row.title === "string" &&
          Array.isArray(row.metrics) &&
          row.metrics.every(
            (metric) =>
              isRecord(metric) &&
              typeof metric.id === "string" &&
              typeof metric.label === "string" &&
              typeof metric.unit === "string" &&
              typeof metric.basis === "string" &&
              ["value", "missing", "not-meaningful", "not-applicable"].includes(
                String(metric.status),
              ) &&
              strings(metric.sourceIds) &&
              Array.isArray(metric.inputs) &&
              metric.inputs.every(
                (input) =>
                  isRecord(input) &&
                  typeof input.label === "string" &&
                  typeof input.unit === "string" &&
                  strings(input.sourceIds),
              ),
          ),
      ))
  ) {
    return false;
  }
  if (
    value.webSubjectProfile !== undefined &&
    readWebSubjectProfileArtifact(value.webSubjectProfile) === undefined
  ) {
    return false;
  }
  if (
    value.earningsSetup !== undefined &&
    (!isRecord(value.earningsSetup) ||
      !isRecord(value.earningsSetup.event) ||
      typeof value.earningsSetup.event.symbol !== "string" ||
      typeof value.earningsSetup.event.date !== "string" ||
      !strings(value.earningsSetup.event.sourceIds) ||
      !strings(value.earningsSetup.gaps))
  ) {
    return false;
  }
  return true;
}

function rejectCredentials(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach((row) => rejectCredentials(row));
  } else if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (
        /^(?:apiKey|apiToken|authorization|cookie|processEnv|signal|baseUrl)$/iu.test(key) ||
        /(?:ApiKey|ApiToken)$/u.test(key)
      ) {
        throw new Error(`Unsafe replay input field: ${key}`);
      }
      rejectCredentials(child);
    }
  }
}

export function readSynthesisReplayInput(value: unknown): SynthesisReplayInput {
  rejectCredentials(value);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.phase !== "final-synthesis" ||
    value.invocation !== "initial-with-repairs" ||
    !isRecord(value.codeVersion) ||
    typeof value.codeVersion.version !== "string" ||
    !isRecord(value.input) ||
    !isRecord(value.responses) ||
    !isRecord(value.responses.entries) ||
    !Array.isArray(value.promptProvenance) ||
    !value.promptProvenance.every(
      (row) =>
        isRecord(row) &&
        typeof row.model === "string" &&
        typeof row.requestSha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(row.requestSha256),
    )
  ) {
    throw new Error("Invalid final-synthesis replay envelope/version");
  }
  if (
    value.baseline !== undefined &&
    (!isRecord(value.baseline) ||
      !strings(value.baseline.claims) ||
      !["predictions", "findings", "sources", "dataGaps"].every(
        (key) => isRecord(value.baseline) && finite(value.baseline[key]),
      ))
  ) {
    throw new Error("Invalid synthesis baseline facts");
  }
  const { input } = value;
  const { command } = input;
  const { context } = input;
  const collected = input.collectedSources;
  if (
    typeof input.runId !== "string" ||
    input.runId.length === 0 ||
    typeof input.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(input.generatedAt)) ||
    !isRecord(command) ||
    !["equity", "crypto", "research", "market-overview"].includes(String(command.jobType)) ||
    !["equity", "crypto"].includes(String(command.assetClass)) ||
    !["brief", "deep"].includes(String(command.depth)) ||
    ((command.jobType === "equity" || command.jobType === "crypto") &&
      typeof command.symbol !== "string") ||
    !isRecord(input.settings) ||
    Object.keys(input.settings).some((key) => key !== "sourceOptions") ||
    !isRecord(input.settings.sourceOptions) ||
    Object.keys(input.settings.sourceOptions).some(
      (key) => !["equityMoverLimit", "cryptoMoverLimit"].includes(key),
    ) ||
    !finite(input.settings.sourceOptions.equityMoverLimit) ||
    !finite(input.settings.sourceOptions.cryptoMoverLimit) ||
    !isRecord(context) ||
    !isRecord(context.depthProfile) ||
    !isRecord(context.runParams) ||
    !isRecord(context.marketRegime) ||
    !isRecord(context.evidenceQualityAssessment) ||
    !strings(context.depthProfile.predictionSubjects) ||
    !strings(context.depthProfile.focus) ||
    !isRecord(context.depthProfile.targetKindMix) ||
    !strings(context.depthProfile.targetKindMix.favored) ||
    !finite(context.depthProfile.targetPredictions) ||
    !finite(context.depthProfile.defaultPredictionHorizon) ||
    typeof context.runParams.synthesisModel !== "string" ||
    !isRecord(collected) ||
    !Array.isArray(collected.rawSnapshots) ||
    !Array.isArray(collected.marketSnapshots) ||
    !Array.isArray(collected.supplementalMarketSnapshots) ||
    !Array.isArray(collected.newsSources) ||
    !Array.isArray(collected.extendedSources) ||
    !Array.isArray(collected.marketContextSources) ||
    !Array.isArray(collected.sourceGaps) ||
    !Array.isArray(input.sources) ||
    !strings(input.knownSourceIds) ||
    (input.allowedSubjects !== undefined && !strings(input.allowedSubjects)) ||
    !Array.isArray(input.priorStages) ||
    !input.priorStages.every(
      (row) =>
        isRecord(row) &&
        typeof row.stage === "string" &&
        typeof row.content === "string" &&
        finite(row.tokenEstimate),
    ) ||
    !Number.isInteger(input.maxPredictionReprompts) ||
    !finite(input.maxPredictionReprompts) ||
    input.maxPredictionReprompts > 2
  ) {
    throw new Error("Invalid final-synthesis replay input");
  }
  const ids = new Set(input.knownSourceIds);
  if (
    !contextInputs(context) ||
    !collectedInputs(collected) ||
    !sources(input.sources) ||
    (input.equityAnalysisCompleteness !== undefined &&
      readEquityAnalysisCompleteness(input.equityAnalysisCompleteness) === undefined)
  ) {
    throw new Error("Invalid structured final-synthesis dependency");
  }
  if (
    ids.size !== input.knownSourceIds.length ||
    input.sources.length !== ids.size ||
    !input.sources.every(
      (source) =>
        isRecord(source) &&
        typeof source.id === "string" &&
        source.id.length > 0 &&
        ids.has(source.id) &&
        typeof source.title === "string" &&
        typeof source.kind === "string",
    )
  ) {
    throw new Error("Invalid replay source ids");
  }
  for (const [key, sequence] of Object.entries(value.responses.entries)) {
    if (
      !key.startsWith("final-synthesis|") ||
      !Array.isArray(sequence) ||
      !sequence.every(
        (row) =>
          isRecord(row) &&
          typeof row.content === "string" &&
          finite(row.tokenEstimate) &&
          (row.error === undefined || typeof row.error === "string"),
      )
    ) {
      throw new Error("Invalid final-synthesis response recording");
    }
  }
  return value as unknown as SynthesisReplayInput;
}

interface BodyRef {
  readonly bodyFile: string;
  readonly sha256: string;
}

function isBodyRef(value: unknown): value is BodyRef {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.bodyFile === "string" &&
    typeof value.sha256 === "string"
  );
}

async function resolveBodies(
  dir: string,
  text: string,
  cache: Map<string, Promise<unknown>>,
): Promise<unknown> {
  const refs: BodyRef[] = [];
  const parsed: unknown = JSON.parse(text, (_key, value: unknown) => {
    if (isBodyRef(value)) {
      refs.push(value);
    }
    return value;
  });
  if (refs.length === 0) {
    return parsed;
  }
  const loaded = new Map(
    await Promise.all(
      refs.map(async (ref) => {
        if (!cache.has(ref.bodyFile)) {
          cache.set(
            ref.bodyFile,
            readRecordedBody(dir, ref.bodyFile, ref.sha256).then((body) =>
              resolveBodies(dir, body, cache),
            ),
          );
        }
        return [ref.bodyFile, await cache.get(ref.bodyFile)] as const;
      }),
    ),
  );
  return JSON.parse(text, (_key, value: unknown) =>
    isBodyRef(value) ? loaded.get(value.bodyFile) : value,
  );
}

export async function loadSynthesisReplayInput(file: string): Promise<SynthesisReplayInput> {
  return readSynthesisReplayInput(
    await resolveBodies(dirname(file), await readFile(file, "utf8"), new Map()),
  );
}

export function externalizeSynthesisBodies(
  saved: SynthesisReplayInput,
  store: (body: string) => BodyRef,
): SynthesisReplayInput {
  const externalize = (value: unknown): unknown => {
    let mapped = value;
    if (Array.isArray(value)) {
      mapped = value.map((row) => externalize(row));
    } else if (isRecord(value)) {
      mapped = Object.fromEntries(
        Object.entries(value).map(([key, row]) => [key, externalize(row)]),
      );
    } else if (typeof value !== "string") {
      return value;
    }
    const body = JSON.stringify(mapped);
    return body.length > 32_768 ? store(body) : mapped;
  };
  const collected = saved.input.collectedSources;
  return {
    ...saved,
    input: {
      ...saved.input,
      collectedSources: {
        ...collected,
        rawSnapshots: externalize(collected.rawSnapshots) as typeof collected.rawSnapshots,
        ...(collected.secTargetPacket === undefined
          ? {}
          : {
              secTargetPacket: externalize(
                collected.secTargetPacket,
              ) as typeof collected.secTargetPacket,
            }),
      },
    },
  };
}

export function makeSynthesisReplayInput(
  input: unknown,
  cassette: LlmCassette,
  codeVersion: CodeVersion,
  promptProvenance: SynthesisReplayInput["promptProvenance"],
  baseline?: SynthesisReplayInput["baseline"],
): SynthesisReplayInput {
  return readSynthesisReplayInput({
    version: 1,
    phase: "final-synthesis",
    invocation: "initial-with-repairs",
    codeVersion,
    promptProvenance,
    ...(baseline === undefined ? {} : { baseline }),
    input,
    responses: {
      entries: Object.fromEntries(
        Object.entries(cassette.entries).filter(([key]) => key.startsWith("final-synthesis|")),
      ),
    },
  });
}
