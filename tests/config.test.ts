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
    expect(() => resolveConfig({ MARKET_BOT_PROVIDER: "openai-compatible" })).toThrow("MARKET_BOT_BASE_URL");
  });

  test("reads source limits", () => {
    expect(resolveConfig({ MARKET_BOT_CRYPTO_MOVER_LIMIT: "12" }).sourceOptions.cryptoMoverLimit).toBe(12);
  });
});
