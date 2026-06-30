import { describe, expect, test } from "bun:test";
import { createOpenAIProvider } from "../src/model/openai";

const alphaSearchOptions = {
  apeWisdomFilter: "all-stocks",
  apeWisdomBriefPageLimit: 5,
  apeWisdomDeepPageLimit: 10,
  validationCandidateLimit: 25,
  leadLimit: 15,
  topCandidateLimit: 15,
  secDiscoveryLimit: 25,
  secFormTypes: ["S-1", "F-1", "8-K", "6-K"],
  minPrice: 0.5,
  minVolume: 100_000,
  minMarketCap: 50_000_000,
  maxMarketCap: 10_000_000_000,
};

const webGatherOptions = {
  maxRounds: 0,
  maxToolCalls: 0,
  sourceBudget: 0,
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
        webGatherOptions,
        webGatherDisabled: false,
        webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
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
        webGatherOptions,
        webGatherDisabled: false,
        webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
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

  test("uses Responses web search when requested", async () => {
    const requests: Request[] = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(new Request(input, init));
      return Response.json({
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Search-grounded answer" }],
          },
        ],
        usage: { total_tokens: 21 },
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
        webGatherOptions,
        webGatherDisabled: false,
        webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
        alphaSearchOptions,
      },
      fetchImpl,
    );

    const response = await provider.generate({
      model: "synthesis",
      webSearch: true,
      messages: [
        { role: "system", content: "Cite sources." },
        { role: "user", content: "Find current context." },
      ],
      params: { max_completion_tokens: 512, reasoningEffort: "medium" },
    });

    expect(response).toEqual({
      content: "Search-grounded answer",
      tokenEstimate: 21,
      costEstimateUsd: 0,
    });
    expect(String(requests[0]?.url)).toBe("https://api.openai.com/v1/responses");
    await expect(requests[0]?.json()).resolves.toMatchObject({
      model: "synthesis",
      input: [
        { role: "system", content: "Cite sources." },
        { role: "user", content: "Find current context." },
      ],
      tools: [{ type: "web_search" }],
      max_output_tokens: 512,
      reasoning: { effort: "medium" },
    });
  });

  test("rejects JSON response format with Responses web search", async () => {
    const provider = createOpenAIProvider({
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
      webGatherOptions,
      webGatherDisabled: false,
      webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
      alphaSearchOptions,
    });

    await expect(
      provider.generate({
        model: "synthesis",
        webSearch: true,
        responseFormat: "json",
        messages: [{ role: "user", content: "Find current context." }],
      }),
    ).rejects.toThrow("OpenAI web search does not support JSON response format");
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
        webGatherOptions,
        webGatherDisabled: false,
        webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
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
        webGatherOptions,
        webGatherDisabled: false,
        webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
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
