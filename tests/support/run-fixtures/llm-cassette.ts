import type { ModelProvider, ModelRequest } from "../../../src/model/types";

export interface LlmCassetteEntry {
  readonly content: string;
  readonly tokenEstimate: number;
  readonly costEstimateUsd: number;
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
  if (stage === "playbook-selection") {
    return JSON.stringify({ selections: [] });
  }
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
            costEstimateUsd: response.costEstimateUsd,
          },
        ];
        return response;
      },
    },
  };
}
