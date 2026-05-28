import { describe, expect, test } from "bun:test";
import { resolveConfig } from "../src/config";

describe("resolveConfig", () => {
  test("uses OpenAI defaults", () => {
    expect(resolveConfig({})).toMatchObject({
      provider: "openai",
      quickModel: "gpt-5.4-mini",
      synthesisModel: "gpt-5.5",
      dataDir: "data/runs",
      modelTimeoutMs: 120_000,
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

  test("accepts codex provider without apiKey", () => {
    const config = resolveConfig({ MARKET_BOT_PROVIDER: "codex" });
    expect(config.provider).toBe("codex");
    expect(config.apiKey).toBeUndefined();
  });

  test("reads codex-specific model overrides", () => {
    const config = resolveConfig({
      MARKET_BOT_PROVIDER: "codex",
      MARKET_BOT_CODEX_QUICK_MODEL: "gpt-5.4",
      MARKET_BOT_CODEX_SYNTHESIS_MODEL: "gpt-5.5",
    });
    expect(config.codexQuickModel).toBe("gpt-5.4");
    expect(config.codexSynthesisModel).toBe("gpt-5.5");
  });

  test("codex model overrides are undefined when not set", () => {
    const config = resolveConfig({ MARKET_BOT_PROVIDER: "codex" });
    expect(config.codexQuickModel).toBeUndefined();
    expect(config.codexSynthesisModel).toBeUndefined();
  });

  test("reads model timeout", () => {
    expect(resolveConfig({ MARKET_BOT_MODEL_TIMEOUT_MS: "60000" }).modelTimeoutMs).toBe(60_000);
  });

  test("rejects unknown provider", () => {
    expect(() => resolveConfig({ MARKET_BOT_PROVIDER: "unknown" })).toThrow("Unsupported provider");
  });
});
