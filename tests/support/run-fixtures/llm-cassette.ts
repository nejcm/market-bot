import { isRecord } from "../../../src/guards";
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

function requestStage(request: ModelRequest): string {
  const user = request.messages.findLast((message) => message.role === "user")?.content;
  if (user === undefined) {
    return "unknown";
  }
  try {
    const parsed = JSON.parse(user) as { readonly stage?: unknown };
    return typeof parsed.stage === "string" ? parsed.stage : "unknown";
  } catch {
    return "unknown";
  }
}

export function llmCassetteKey(request: ModelRequest): string {
  return `${requestStage(request)}|${request.model}`;
}

function emptyResponseFor(stage: string): string {
  if (stage === "evidence-request" || stage === "web-gather") {
    return JSON.stringify({ requests: [] });
  }
  if (stage === "forecast-disagreement") {
    return JSON.stringify({ predictions: [] });
  }
  return "{}";
}

export function makeReplayProvider(cassette: LlmCassette): ModelProvider {
  const indexes = new Map<string, number>();
  return {
    name: "fixture-replay",
    generate: async (request) => {
      const key = llmCassetteKey(request);
      const index = indexes.get(key) ?? 0;
      indexes.set(key, index + 1);
      const entries = cassette.entries[key] ?? [];
      const entry = entries[index] ?? entries.at(-1);
      if (entry !== undefined) {
        if (index >= entries.length) {
          process.stderr.write(`LLM cassette overflow for ${key}; replaying last entry\n`);
        }
        return entry;
      }
      const stage = key.split("|")[0] ?? "unknown";
      process.stderr.write(`LLM cassette empty fallback for ${key}\n`);
      return {
        content: emptyResponseFor(stage),
        tokenEstimate: 0,
        costEstimateUsd: 0,
      };
    },
  };
}

export const LIVE_STAGE = "final-synthesis";

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
        throw new TypeError(`${LIVE_STAGE} prompt has no priorStages array to freeze`);
      }
      const priorStages: unknown[] = prompt.priorStages.map((stage: unknown) =>
        isRecord(stage) && "durationMs" in stage ? { ...stage, durationMs: 0 } : stage,
      );
      return { ...message, content: JSON.stringify({ ...prompt, priorStages }, undefined, 2) };
    }),
  };
}

// Upstream stages replay by stage alone because live model names differ from the recorded ones.
// Stages may swallow a replay error, so any miss also blocks every later live call.
export function makeFinalSynthesisLiveProvider(
  cassette: LlmCassette,
  live: ModelProvider,
): ModelProvider {
  const indexes = new Map<string, number>();
  let upstreamFailure: string | undefined;
  const fail = (message: string): never => {
    upstreamFailure ??= message;
    throw new Error(message);
  };
  return {
    name: `${live.name}+fixture-replay`,
    generate: async (request) => {
      const stage = requestStage(request);
      if (stage === LIVE_STAGE) {
        if (upstreamFailure !== undefined) {
          throw new Error(
            `Refusing live ${LIVE_STAGE} after upstream replay failure: ${upstreamFailure}`,
          );
        }
        return live.generate(withoutStageDurations(request));
      }
      const keys = Object.keys(cassette.entries).filter((key) => key.startsWith(`${stage}|`));
      const [key] = keys;
      if (key === undefined || keys.length > 1) {
        return fail(`LLM cassette has ${String(keys.length)} recorded models for stage ${stage}`);
      }
      const index = indexes.get(stage) ?? 0;
      indexes.set(stage, index + 1);
      return (
        cassette.entries[key]?.[index] ??
        fail(`LLM cassette miss for ${key} call ${String(index + 1)}`)
      );
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
