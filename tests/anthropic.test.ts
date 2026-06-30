import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { createAnthropicProvider } from "../src/model/anthropic";

const baseConfig: AppConfig = {
  provider: "anthropic",
  apiKey: "test-anthropic-key",
  quickModel: "claude-sonnet-4-6",
  synthesisModel: "claude-opus-4-8",
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
  webGatherOptions: {
    maxRounds: 0,
    maxToolCalls: 0,
    sourceBudget: 0,
  },
  webGatherDisabled: false,
  webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
  alphaSearchOptions: {
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
  },
};

const okWithoutUsageFetch = async (): Promise<Response> =>
  Response.json({ content: [{ type: "text", text: "ok" }] });

const invalidRequestFetch = async (): Promise<Response> =>
  Response.json(
    {
      type: "error",
      error: { type: "invalid_request_error", message: "Bad request body." },
      request_id: "req_test",
    },
    { status: 400 },
  );

const responseWithoutTextFetch = async (): Promise<Response> =>
  Response.json({ content: [{ type: "thinking", thinking: "hidden" }] });

describe("createAnthropicProvider", () => {
  test("posts Messages API requests and reads text content with usage", async () => {
    const requests: Request[] = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(new Request(input, init));
      return Response.json({
        content: [{ type: "text", text: '{"summary":"ok"}' }],
        usage: { input_tokens: 3, output_tokens: 4 },
      });
    };

    const provider = createAnthropicProvider(baseConfig, fetchImpl);
    const response = await provider.generate({
      model: "claude-opus-4-8",
      responseFormat: "json",
      messages: [
        { role: "system", content: "Use audited sources." },
        { role: "user", content: "Return JSON" },
      ],
    });

    expect(response).toEqual({
      content: '{"summary":"ok"}',
      tokenEstimate: 7,
      costEstimateUsd: 0,
    });
    expect(String(requests[0]?.url)).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0]?.headers.get("x-api-key")).toBe("test-anthropic-key");
    expect(requests[0]?.headers.get("anthropic-version")).toBe("2023-06-01");

    const body = (await requests[0]?.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "claude-opus-4-8",
      max_tokens: 16_384,
      messages: [{ role: "user", content: "Return JSON" }],
    });
    expect(body.system).toContain("Use audited sources.");
    expect(body.system).toContain("Respond with a valid JSON object only");
  });

  test("omits output_config when reasoning effort is unset", async () => {
    const requests: Request[] = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(new Request(input, init));
      return Response.json({ content: [{ type: "text", text: "ok" }] });
    };

    const provider = createAnthropicProvider(baseConfig, fetchImpl);
    await provider.generate({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    });

    const body = (await requests[0]?.json()) as Record<string, unknown>;
    expect(body.output_config).toBeUndefined();
  });

  test("maps reasoning effort and max completion tokens", async () => {
    const requests: Request[] = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(new Request(input, init));
      return Response.json({ content: [{ type: "text", text: "ok" }] });
    };

    const provider = createAnthropicProvider(baseConfig, fetchImpl);
    await provider.generate({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      params: { reasoningEffort: "high", max_completion_tokens: 512 },
    });

    await expect(requests[0]?.json()).resolves.toMatchObject({
      max_tokens: 512,
      output_config: { effort: "high" },
    });
  });

  test("enables server web search when requested", async () => {
    const requests: Request[] = [];
    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(new Request(input, init));
      return Response.json({ content: [{ type: "text", text: "Search-grounded answer" }] });
    };

    const provider = createAnthropicProvider(baseConfig, fetchImpl);
    const response = await provider.generate({
      model: "claude-sonnet-4-6",
      webSearch: true,
      messages: [{ role: "user", content: "Find current context." }],
    });

    expect(response.content).toBe("Search-grounded answer");
    await expect(requests[0]?.json()).resolves.toMatchObject({
      tools: [{ type: "web_search_20260318", name: "web_search" }],
    });
  });

  test("rounds fallback token estimate when usage is absent", async () => {
    const provider = createAnthropicProvider(baseConfig, okWithoutUsageFetch);
    const response = await provider.generate({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "12345" }],
    });

    expect(response.tokenEstimate).toBe(2);
  });

  test("includes structured error details for failed requests", async () => {
    const provider = createAnthropicProvider(baseConfig, invalidRequestFetch);

    await expect(
      provider.generate({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow(
      "Anthropic request failed with status 400: Bad request body.; type=invalid_request_error; request_id=req_test",
    );
  });

  test("rejects responses without text content", async () => {
    const provider = createAnthropicProvider(baseConfig, responseWithoutTextFetch);

    await expect(
      provider.generate({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("Anthropic response did not include content");
  });

  test("requires an Anthropic API key", () => {
    const { apiKey: _apiKey, ...configWithoutKey } = baseConfig;

    expect(() => createAnthropicProvider(configWithoutKey)).toThrow(
      "ANTHROPIC_API_KEY or MARKET_BOT_ANTHROPIC_API_KEY",
    );
  });
});
