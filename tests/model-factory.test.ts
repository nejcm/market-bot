import { describe, expect, test } from "bun:test";
import type { AppConfig } from "../src/config";
import { createProvider } from "../src/model/factory";

function minimalConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    provider: "openai",
    apiKey: "test-key",
    quickModel: "gpt-test",
    synthesisModel: "gpt-test",
    modelTimeoutMs: 5000,
    dataDir: "data/runs",
    promptDir: "prompts",
    sourceOptions: {
      equityMoverLimit: 5,
      cryptoMoverLimit: 5,
      newsLimit: 8,
      sourceTimeoutMs: 15_000,
    },
    evidenceRequestOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
    webGatherOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
    webGatherDisabled: false,
    webProfileReuseDays: 30,
    alphaSearchOptions: {
      apeWisdomFilter: "all-stocks",
      apeWisdomBriefPageLimit: 5,
      apeWisdomDeepPageLimit: 10,
      validationCandidateLimit: 25,
      leadLimit: 15,
      topCandidateLimit: 15,
      secDiscoveryLimit: 25,
      secFormTypes: ["S-1"],
      minPrice: 0.5,
      minVolume: 100_000,
      minMarketCap: 50_000_000,
      maxMarketCap: 10_000_000_000,
    },
    ...overrides,
  };
}

describe("createProvider", () => {
  test("returns an openai provider by default", () => {
    const provider = createProvider(minimalConfig());
    expect(provider.name).toBe("openai");
    expect(typeof provider.generate).toBe("function");
  });

  test("returns an anthropic provider for anthropic config", () => {
    const provider = createProvider(minimalConfig({ provider: "anthropic" }));
    expect(provider.name).toBe("anthropic");
  });

  test("returns an openai provider for openai-compatible config", () => {
    const provider = createProvider(
      minimalConfig({
        provider: "openai-compatible",
        baseUrl: "https://custom.api.example.com/v1",
      }),
    );
    expect(provider.name).toBe("openai-compatible");
  });

  test("returns a codex provider for codex config", () => {
    const provider = createProvider(minimalConfig({ provider: "codex" }));
    expect(provider.name).toBe("codex");
  });
});
