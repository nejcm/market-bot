import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config";

describe("resolveConfig", () => {
  test("uses OpenAI defaults", () => {
    expect(resolveConfig({})).toMatchObject({
      provider: "openai",
      quickModel: "gpt-4.1-mini",
      synthesisModel: "gpt-4.1",
      dataDir: "data/runs",
    });
  });

  test("requires base URL for compatible providers", () => {
    expect(() => resolveConfig({ MARKET_BOT_PROVIDER: "openai-compatible" })).toThrow(
      "MARKET_BOT_BASE_URL",
    );
  });

  test("resolves OpenAI-compatible provider settings", () => {
    expect(
      resolveConfig({
        MARKET_BOT_PROVIDER: "openai-compatible",
        MARKET_BOT_BASE_URL: "http://localhost:11434/v1",
        MARKET_BOT_OPENAI_API_KEY: "local-key",
        MARKET_BOT_QUICK_MODEL: "local-quick",
        MARKET_BOT_SYNTHESIS_MODEL: "local-synthesis",
      }),
    ).toMatchObject({
      provider: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "local-key",
      quickModel: "local-quick",
      synthesisModel: "local-synthesis",
    });
  });

  test("reads source limits", () => {
    expect(
      resolveConfig({ MARKET_BOT_CRYPTO_MOVER_LIMIT: "12" }).sourceOptions.cryptoMoverLimit,
    ).toBe(12);
  });

  test("reads source timeout", () => {
    expect(
      resolveConfig({ MARKET_BOT_SOURCE_TIMEOUT_MS: "5000" }).sourceOptions.sourceTimeoutMs,
    ).toBe(5000);
  });
});
