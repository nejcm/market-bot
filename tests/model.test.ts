import { describe, expect, test } from "bun:test";
import { createOpenAIProvider } from "../src/model/openai";

const alphaSearchOptions = {
  apeWisdomFilter: "all-stocks",
  apeWisdomBriefPageLimit: 5,
  apeWisdomDeepPageLimit: 10,
  validationCandidateLimit: 25,
  leadLimit: 15,
  redditUserAgent: "market-bot test@example.test",
  redditSubreddits: [],
  redditLookbackDays: 7,
  redditRawRetentionHours: 48,
  topCandidateLimit: 15,
  redditSeenPath: "data/reddit-seen.json",
};

describe("createOpenAIProvider", () => {
  test("posts chat completion requests and reads content", async () => {
    const requests: Request[] = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(new Request(input, init));
      return Response.json({
        choices: [{ message: { content: '{"summary":"ok"}' } }],
        usage: { total_tokens: 12 },
      });
    };

    const provider = createOpenAIProvider(
      {
        provider: "openai",
        apiKey: "test-key",
        quickModel: "quick",
        synthesisModel: "synthesis",
        modelTimeoutMs: 120_000,
        dataDir: "data/runs",
        promptDir: "prompts",
        sourceOptions: {
          equityMoverLimit: 5,
          cryptoMoverLimit: 5,
          newsLimit: 8,
          sourceTimeoutMs: 1000,
        },
        evidenceRequestOptions: {
          maxRounds: 0,
          maxToolCalls: 0,
          sourceBudget: 0,
        },
        alphaSearchOptions,
      },
      fetchImpl,
    );

    const response = await provider.generate({
      model: "synthesis",
      responseFormat: "json",
      messages: [{ role: "user", content: "Return JSON" }],
    });

    expect(response).toEqual({
      content: '{"summary":"ok"}',
      tokenEstimate: 12,
      costEstimateUsd: 0,
    });
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer test-key");
    await expect(requests[0]?.json()).resolves.toMatchObject({
      model: "synthesis",
      response_format: { type: "json_object" },
    });
  });

  test("uses configured OpenAI-compatible base URL", async () => {
    const urls: string[] = [];
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      urls.push(String(input));
      return Response.json({
        choices: [{ message: { content: '{"summary":"ok"}' } }],
      });
    };
    const provider = createOpenAIProvider(
      {
        provider: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
        apiKey: "local-key",
        quickModel: "quick",
        synthesisModel: "synthesis",
        modelTimeoutMs: 120_000,
        dataDir: "data/runs",
        promptDir: "prompts",
        sourceOptions: {
          equityMoverLimit: 5,
          cryptoMoverLimit: 5,
          newsLimit: 8,
          sourceTimeoutMs: 1000,
        },
        evidenceRequestOptions: {
          maxRounds: 0,
          maxToolCalls: 0,
          sourceBudget: 0,
        },
        alphaSearchOptions,
      },
      fetchImpl,
    );

    await provider.generate({
      model: "quick",
      responseFormat: "json",
      messages: [{ role: "user", content: "Return JSON" }],
    });

    expect(urls).toEqual(["http://localhost:11434/v1/chat/completions"]);
  });

  test("spreads ModelParams into request body when set", async () => {
    const requests: Request[] = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(new Request(input, init));
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    };
    const provider = createOpenAIProvider(
      {
        provider: "openai",
        apiKey: "test-key",
        quickModel: "quick",
        synthesisModel: "synthesis",
        modelTimeoutMs: 120_000,
        dataDir: "data/runs",
        promptDir: "prompts",
        sourceOptions: {
          equityMoverLimit: 5,
          cryptoMoverLimit: 5,
          newsLimit: 8,
          sourceTimeoutMs: 1000,
        },
        evidenceRequestOptions: {
          maxRounds: 0,
          maxToolCalls: 0,
          sourceBudget: 0,
        },
        alphaSearchOptions,
      },
      fetchImpl,
    );

    await provider.generate({
      model: "quick",
      messages: [{ role: "user", content: "hi" }],
      params: {
        temperature: 0.7,
        top_p: 0.9,
        max_completion_tokens: 512,
        seed: 42,
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        stop: ["STOP"],
        reasoningEffort: "high",
        verbosity: "medium",
      },
    });

    await expect(requests[0]?.json()).resolves.toMatchObject({
      temperature: 0.7,
      top_p: 0.9,
      max_completion_tokens: 512,
      seed: 42,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      stop: ["STOP"],
      reasoning_effort: "high",
      verbosity: "medium",
    });
  });

  test("omits ModelParams fields from body when params are not set", async () => {
    const requests: Request[] = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(new Request(input, init));
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    };
    const provider = createOpenAIProvider(
      {
        provider: "openai",
        apiKey: "test-key",
        quickModel: "quick",
        synthesisModel: "synthesis",
        modelTimeoutMs: 120_000,
        dataDir: "data/runs",
        promptDir: "prompts",
        sourceOptions: {
          equityMoverLimit: 5,
          cryptoMoverLimit: 5,
          newsLimit: 8,
          sourceTimeoutMs: 1000,
        },
        evidenceRequestOptions: {
          maxRounds: 0,
          maxToolCalls: 0,
          sourceBudget: 0,
        },
        alphaSearchOptions,
      },
      fetchImpl,
    );

    await provider.generate({
      model: "quick",
      messages: [{ role: "user", content: "hi" }],
    });

    const body = (await requests[0]?.json()) as Record<string, unknown>;
    expect(Object.keys(body).toSorted()).toEqual(["messages", "model"]);
  });
});
