import { isRecord } from "../../../src/guards";
import type { StageLabel } from "../../../src/research/prompt-loader";
import type { ModelProvider, ModelRequest } from "../../../src/model/types";

export interface LlmCassetteEntry {
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd?: number;
}

export interface LlmCassette {
  readonly entries: Readonly<Record<string, readonly LlmCassetteEntry[]>>;
}

export interface LlmRecorder {
  readonly cassette: () => LlmCassette;
  readonly provider: ModelProvider;
}

export function requestStage(request: ModelRequest): string {
  const user = request.messages.findLast((message) => message.role === "user")?.content;
  if (user === undefined) {
    return "unknown";
  }
  try {
    const parsed = JSON.parse(user) as { readonly stage?: unknown };
    return typeof parsed.stage === "string" && parsed.stage.trim().length > 0
      ? parsed.stage
      : "unknown";
  } catch {
    return "unknown";
  }
}

export function llmCassetteKey(request: ModelRequest): string {
  return `${requestStage(request)}|${request.model}`;
}

const LIVE_STAGE = "final-synthesis";

export const LIVE_STAGES = [
  "specialist-analysis",
  "instrument-evidence-analysis",
  "market-behavior-analysis",
  "regime-context-analysis",
  "mover-theme-analysis",
  "critique",
  LIVE_STAGE,
  "web-gather",
  "web-subject-profile",
  "evidence-request",
  "financial-table-mapping",
  "forecast-disagreement",
  "spotlight-selection",
] as const satisfies readonly StageLabel[];

export type LiveStage = (typeof LIVE_STAGES)[number];

export function validateLiveStage(value: string): LiveStage {
  const stage = LIVE_STAGES.find((candidate) => candidate === value);
  if (stage === undefined) {
    throw new Error(
      `Select exactly one supported live stage: ${LIVE_STAGES.join(", ")}; got ${value}`,
    );
  }
  return stage;
}

// Wall-clock stage durations ride in priorStages; zeroing them keeps live prompts identical across samples.
function withoutStageDurations(request: ModelRequest): ModelRequest {
  return {
    ...request,
    messages: request.messages.map((message) => {
      if (message.role !== "user") {
        return message;
      }
      const prompt = JSON.parse(message.content) as Record<string, unknown>;
      if (!Array.isArray(prompt.priorStages)) {
        if (requestStage(request) === LIVE_STAGE) {
          throw new TypeError(`${LIVE_STAGE} prompt has no priorStages array to freeze`);
        }
        return message;
      }
      const priorStages: unknown[] = prompt.priorStages.map((stage: unknown) =>
        isRecord(stage) && "durationMs" in stage ? { ...stage, durationMs: 0 } : stage,
      );
      return { ...message, content: JSON.stringify({ ...prompt, priorStages }) };
    }),
  };
}

export class ModelReplayError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.key = key;
    this.name = "ModelReplayError";
  }
}

export interface ReplayProvider extends ModelProvider {
  readonly diagnostics: () => {
    readonly consumedResponses: Readonly<Record<string, number>>;
    readonly unusedResponses: Readonly<Record<string, number>>;
  };
}

export function makeReplayProvider(
  cassette: LlmCassette,
  live?: ModelProvider,
  liveStage: LiveStage = LIVE_STAGE,
): ReplayProvider {
  validateLiveStage(liveStage);
  const indexes = new Map<string, number>();
  let replayFailure: string | undefined = undefined;
  const fail = (key: string, message: string): never => {
    replayFailure ??= message;
    throw new ModelReplayError(key, message);
  };
  return {
    ...live,
    name: live === undefined ? "fixture-replay" : `${live.name}+fixture-replay`,
    diagnostics: () => ({
      consumedResponses: Object.fromEntries(indexes),
      unusedResponses: Object.fromEntries(
        Object.entries(cassette.entries)
          .map(([key, entries]) => [key, entries.length - (indexes.get(key) ?? 0)] as const)
          .filter(([, count]) => count > 0),
      ),
    }),
    generate: async (request) => {
      const stage = requestStage(request);
      const exactKey = llmCassetteKey(request);
      if (stage === "unknown") {
        return fail(
          exactKey,
          `LLM cassette unsupported request without stage identity: ${exactKey}`,
        );
      }
      if (live !== undefined && stage === liveStage) {
        if (replayFailure !== undefined) {
          throw new Error(
            `Refusing live ${liveStage} after upstream replay failure: ${replayFailure}`,
          );
        }
        return live.generate(withoutStageDurations(request));
      }
      const keys = Object.hasOwn(cassette.entries, exactKey)
        ? [exactKey]
        : Object.keys(cassette.entries).filter((key) => key.startsWith(`${stage}|`));
      const [key] = keys;
      if (key === undefined || keys.length !== 1) {
        return fail(
          exactKey,
          `LLM cassette has ${String(keys.length)} recorded models for stage ${stage}: ${exactKey}`,
        );
      }
      const index = indexes.get(key) ?? 0;
      const entry = cassette.entries[key]?.[index];
      if (entry === undefined) {
        return fail(exactKey, `LLM cassette miss for ${key} call ${String(index + 1)}`);
      }
      indexes.set(key, index + 1);
      return entry;
    },
  };
}

export function createRecordingProvider(baseProvider: ModelProvider): LlmRecorder {
  const entries: Record<string, LlmCassetteEntry[]> = {};
  return {
    cassette: () => ({ entries }),
    provider: {
      name: baseProvider.name,
      generate: async (request) => {
        const response = await baseProvider.generate(request);
        const key = llmCassetteKey(request);
        entries[key] = [
          ...(entries[key] ?? []),
          {
            content: response.content,
            tokenEstimate: response.tokenEstimate,
            ...(response.costEstimateUsd !== undefined
              ? { costEstimateUsd: response.costEstimateUsd }
              : {}),
          },
        ];
        return response;
      },
    },
  };
}
