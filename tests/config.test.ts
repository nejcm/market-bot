import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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

  test("reads prompt directory", () => {
    expect(resolveConfig({ MARKET_BOT_PROMPT_DIR: "custom-prompts" }).promptDir).toBe(
      "custom-prompts",
    );
  });

  test("requires base URL for compatible providers", () => {
    expect(() => resolveConfig({ MARKET_BOT_PROVIDER: "openai-compatible" })).toThrow(
      "MARKET_BOT_BASE_URL",
    );
  });

  test("rejects base URL without compatible provider mode", () => {
    expect(() => resolveConfig({ MARKET_BOT_BASE_URL: "https://example.com/v1" })).toThrow(
      "MARKET_BOT_PROVIDER=openai-compatible",
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

  test("rejects insecure remote OpenAI-compatible base URL", () => {
    expect(() =>
      resolveConfig({
        MARKET_BOT_PROVIDER: "openai-compatible",
        MARKET_BOT_BASE_URL: "http://example.com/v1",
        MARKET_BOT_OPENAI_API_KEY: "local-key",
      }),
    ).toThrow("https unless it targets localhost");
  });

  test("rejects credentials in OpenAI-compatible base URL", () => {
    expect(() =>
      resolveConfig({
        MARKET_BOT_PROVIDER: "openai-compatible",
        MARKET_BOT_BASE_URL: "https://user:pass@example.com/v1",
        MARKET_BOT_OPENAI_API_KEY: "local-key",
      }),
    ).toThrow("must not include credentials");
  });

  test("does not forward OPENAI_API_KEY to OpenAI-compatible providers", () => {
    expect(
      resolveConfig({
        MARKET_BOT_PROVIDER: "openai-compatible",
        MARKET_BOT_BASE_URL: "http://localhost:11434/v1",
        OPENAI_API_KEY: "global-key",
      }).apiKey,
    ).toBeUndefined();
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

  test("uses alpha-search defaults", () => {
    expect(resolveConfig({}).alphaSearchOptions).toMatchObject({
      redditUserAgent: "market-bot alpha-search contact@example.invalid",
      redditSubreddits: [],
      redditLookbackDays: 7,
      redditRawRetentionHours: 48,
      topCandidateLimit: 15,
      redditSeenPath: join("data", "reddit-seen.json"),
    });
  });

  test("reads Reddit alpha-search settings", () => {
    expect(
      resolveConfig({
        MARKET_BOT_REDDIT_CLIENT_ID: "client-id",
        MARKET_BOT_REDDIT_CLIENT_SECRET: "client-secret",
        MARKET_BOT_REDDIT_USER_AGENT: "market-bot test@example.test",
        MARKET_BOT_REDDIT_SUBREDDITS: "r/stocks,wallstreetbets, SecurityAnalysis ",
        MARKET_BOT_REDDIT_LOOKBACK_DAYS: "5",
        MARKET_BOT_REDDIT_RAW_RETENTION_HOURS: "24",
        MARKET_BOT_ALPHA_SEARCH_CANDIDATE_LIMIT: "10",
        MARKET_BOT_REDDIT_SEEN_PATH: "custom/reddit-seen.json",
      }).alphaSearchOptions,
    ).toEqual({
      redditClientId: "client-id",
      redditClientSecret: "client-secret",
      redditUserAgent: "market-bot test@example.test",
      redditSubreddits: ["stocks", "wallstreetbets", "SecurityAnalysis"],
      redditLookbackDays: 5,
      redditRawRetentionHours: 24,
      topCandidateLimit: 10,
      redditSeenPath: "custom/reddit-seen.json",
    });
  });

  test("rejects invalid Reddit subreddit names", () => {
    expect(() => resolveConfig({ MARKET_BOT_REDDIT_SUBREDDITS: "stocks,bad-name" })).toThrow(
      "Invalid subreddit name",
    );
  });

  test("uses evidence request loop defaults", () => {
    expect(resolveConfig({}).evidenceRequestOptions).toEqual({
      maxRounds: 2,
      maxToolCalls: 2,
      sourceBudget: 8,
    });
  });

  test("reads evidence request loop settings including zero disable", () => {
    expect(
      resolveConfig({
        MARKET_BOT_EVIDENCE_REQUEST_MAX_ROUNDS: "0",
        MARKET_BOT_EVIDENCE_REQUEST_MAX_TOOL_CALLS: "3",
        MARKET_BOT_EVIDENCE_REQUEST_SOURCE_BUDGET: "13",
      }).evidenceRequestOptions,
    ).toEqual({
      maxRounds: 0,
      maxToolCalls: 3,
      sourceBudget: 13,
    });
  });

  test("rejects invalid evidence request loop settings", () => {
    expect(() => resolveConfig({ MARKET_BOT_EVIDENCE_REQUEST_SOURCE_BUDGET: "-1" })).toThrow(
      "Expected non-negative integer",
    );
  });

  test("derives persistent news seen index from data directory", () => {
    const { sourceOptions } = resolveConfig({ MARKET_BOT_DATA_DIR: "custom/runs" });

    expect(sourceOptions.newsSeenPath).toBe(join("custom", "news-seen.json"));
    expect(sourceOptions.newsSeenRetentionDays).toBe(30);
  });

  test("keeps persistent news seen index inside non-run data directories", () => {
    expect(resolveConfig({ MARKET_BOT_DATA_DIR: "custom-data" }).sourceOptions.newsSeenPath).toBe(
      join("custom-data", "news-seen.json"),
    );
  });

  test("reads persistent news seen settings", () => {
    const { sourceOptions } = resolveConfig({
      MARKET_BOT_NEWS_SEEN_PATH: "custom/news-seen.json",
      MARKET_BOT_NEWS_SEEN_RETENTION_DAYS: "14",
    });

    expect(sourceOptions.newsSeenPath).toBe("custom/news-seen.json");
    expect(sourceOptions.newsSeenRetentionDays).toBe(14);
  });

  test("reads news provider tokens", () => {
    expect(
      resolveConfig({
        MARKET_BOT_MARKETAUX_API_TOKEN: "marketaux-token",
        MARKET_BOT_FINNHUB_API_TOKEN: "finnhub-token",
      }).sourceOptions,
    ).toMatchObject({
      marketauxApiToken: "marketaux-token",
      finnhubApiToken: "finnhub-token",
    });
  });

  test("reads extended evidence provider settings", () => {
    expect(
      resolveConfig({
        MARKET_BOT_FRED_API_KEY: "fred-key",
        MARKET_BOT_TRADIER_API_TOKEN: "tradier-token",
        MARKET_BOT_GLASSNODE_API_KEY: "glassnode-key",
        MARKET_BOT_SEC_USER_AGENT: "market-bot test@example.test",
      }).sourceOptions,
    ).toMatchObject({
      fredApiKey: "fred-key",
      tradierApiToken: "tradier-token",
      glassnodeApiKey: "glassnode-key",
      secUserAgent: "market-bot test@example.test",
    });
  });

  test("reads Massive source provider key", () => {
    expect(
      resolveConfig({ MARKET_BOT_MASSIVE_API_KEY: "massive-key" }).sourceOptions,
    ).toMatchObject({
      massiveApiKey: "massive-key",
    });
  });

  test("accepts legacy Polygon key for Massive source provider", () => {
    expect(resolveConfig({ MARKET_BOT_POLYGON_API_KEY: "legacy-key" }).sourceOptions).toMatchObject(
      {
        massiveApiKey: "legacy-key",
      },
    );
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

  test("accepts anthropic provider and reads Anthropic API key alias", () => {
    expect(
      resolveConfig({
        MARKET_BOT_PROVIDER: "anthropic",
        MARKET_BOT_ANTHROPIC_API_KEY: "anthropic-key",
      }),
    ).toMatchObject({
      provider: "anthropic",
      apiKey: "anthropic-key",
      quickModel: "claude-sonnet-4-6",
      synthesisModel: "claude-opus-4-8",
    });
  });

  test("reads global Anthropic API key fallback", () => {
    expect(
      resolveConfig({
        MARKET_BOT_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "global-anthropic-key",
      }).apiKey,
    ).toBe("global-anthropic-key");
  });

  test("reads reasoning effort", () => {
    expect(resolveConfig({ MARKET_BOT_REASONING_EFFORT: "high" }).modelParams).toEqual({
      reasoningEffort: "high",
    });
  });

  test("rejects invalid reasoning effort", () => {
    expect(() => resolveConfig({ MARKET_BOT_REASONING_EFFORT: "max" })).toThrow(
      "Unsupported reasoning effort",
    );
  });

  test("reads model timeout", () => {
    expect(resolveConfig({ MARKET_BOT_MODEL_TIMEOUT_MS: "60000" }).modelTimeoutMs).toBe(60_000);
  });

  test("rejects unknown provider", () => {
    expect(() => resolveConfig({ MARKET_BOT_PROVIDER: "unknown" })).toThrow("Unsupported provider");
  });
});
