import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveConfig, resolveResearchConsoleConfig } from "../src/config";

describe("resolveConfig", () => {
  test("uses OpenAI defaults", () => {
    expect(resolveConfig({})).toMatchObject({
      provider: "openai",
      quickModel: "gpt-5.4-mini",
      synthesisModel: "gpt-5.5",
      dataDir: "data/runs",
      modelTimeoutMs: 300_000,
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
    });
  });

  test("reads alpha-search discovery settings", () => {
    expect(
      resolveConfig({
        MARKET_BOT_APEWISDOM_FILTER: "wallstreetbets",
        MARKET_BOT_APEWISDOM_BRIEF_PAGE_LIMIT: "3",
        MARKET_BOT_APEWISDOM_DEEP_PAGE_LIMIT: "8",
        MARKET_BOT_ALPHA_SEARCH_VALIDATION_LIMIT: "20",
        MARKET_BOT_ALPHA_SEARCH_LEAD_LIMIT: "12",
        MARKET_BOT_ALPHA_SEARCH_CANDIDATE_LIMIT: "10",
        MARKET_BOT_ALPHA_SEARCH_SEC_DISCOVERY_LIMIT: "6",
        MARKET_BOT_ALPHA_SEARCH_SEC_FORM_TYPES: "8-K, S-1",
        MARKET_BOT_ALPHA_SEARCH_MIN_PRICE: "0.75",
        MARKET_BOT_ALPHA_SEARCH_MIN_VOLUME: "200000",
        MARKET_BOT_ALPHA_SEARCH_MIN_MARKET_CAP: "100000000",
        MARKET_BOT_ALPHA_SEARCH_MAX_MARKET_CAP: "5000000000",
      }).alphaSearchOptions,
    ).toEqual({
      apeWisdomFilter: "wallstreetbets",
      apeWisdomBriefPageLimit: 3,
      apeWisdomDeepPageLimit: 8,
      validationCandidateLimit: 20,
      leadLimit: 12,
      topCandidateLimit: 10,
      secDiscoveryLimit: 6,
      secFormTypes: ["8-K", "S-1"],
      minPrice: 0.75,
      minVolume: 200_000,
      minMarketCap: 100_000_000,
      maxMarketCap: 5_000_000_000,
    });
  });

  test("rejects invalid alpha-search eligibility settings", () => {
    expect(() => resolveConfig({ MARKET_BOT_ALPHA_SEARCH_MIN_PRICE: "0" })).toThrow(
      "Expected positive number",
    );
    expect(() => resolveConfig({ MARKET_BOT_ALPHA_SEARCH_SEC_DISCOVERY_LIMIT: "0" })).toThrow(
      "Expected positive integer",
    );
    expect(() => resolveConfig({ MARKET_BOT_ALPHA_SEARCH_SEC_FORM_TYPES: "8-K,../x" })).toThrow(
      "Invalid alpha-search SEC form types",
    );
    expect(() =>
      resolveConfig({
        MARKET_BOT_ALPHA_SEARCH_MIN_MARKET_CAP: "1000000000",
        MARKET_BOT_ALPHA_SEARCH_MAX_MARKET_CAP: "500000000",
      }),
    ).toThrow("MARKET_BOT_ALPHA_SEARCH_MAX_MARKET_CAP must be greater than or equal to minimum");
  });

  test("rejects invalid ApeWisdom filters", () => {
    expect(() => resolveConfig({ MARKET_BOT_APEWISDOM_FILTER: "all/stocks" })).toThrow(
      "Invalid ApeWisdom filter",
    );
  });

  test("skips alpha-search env validation when alpha-search config is not included", () => {
    expect(
      resolveConfig(
        {
          MARKET_BOT_APEWISDOM_FILTER: "all/stocks",
          MARKET_BOT_ALPHA_SEARCH_CANDIDATE_LIMIT: "not-a-number",
        },
        { validateAlphaSearchOptions: false },
      ).alphaSearchOptions,
    ).toMatchObject({
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
    });
  });

  test("uses evidence request loop defaults", () => {
    expect(resolveConfig({}).evidenceRequestOptions).toEqual({
      maxRounds: 2,
      maxToolCalls: 2,
      sourceBudget: 8,
    });
    expect(resolveConfig({}).researchGatherOptions).toEqual({
      maxRounds: 4,
      maxToolCalls: 8,
      sourceBudget: 24,
    });
    expect(resolveConfig({}).webGatherOptions).toEqual({
      maxRounds: 2,
      maxToolCalls: 4,
      sourceBudget: 8,
    });
    expect(resolveConfig({}).webGatherDisabled).toBe(false);
    expect(resolveConfig({}).webProfileReuseDays).toBe(30);
  });

  test("uses history and market spotlight defaults", () => {
    expect(resolveConfig({}).marketSpotlightOptions).toEqual({
      briefLimit: 2,
      deepLimit: 4,
      candidateLimit: 40,
    });
    expect(resolveConfig({}).historyOptions).toEqual({
      tickerRecentLimit: 3,
      marketRecentLimit: 5,
      recentDays: 90,
      anchorMonths: [3, 6, 12],
      missCorrectionLimit: 2,
    });
  });

  test("reads history and market spotlight settings", () => {
    expect(
      resolveConfig({
        MARKET_BOT_MARKET_SPOTLIGHT_BRIEF_LIMIT: "1",
        MARKET_BOT_MARKET_SPOTLIGHT_DEEP_LIMIT: "3",
        MARKET_BOT_MARKET_SPOTLIGHT_CANDIDATE_LIMIT: "25",
        MARKET_BOT_HISTORY_TICKER_RECENT_LIMIT: "2",
        MARKET_BOT_HISTORY_MARKET_RECENT_LIMIT: "4",
        MARKET_BOT_HISTORY_RECENT_DAYS: "45",
        MARKET_BOT_HISTORY_ANCHOR_MONTHS: "1, 3,3, 9",
        MARKET_BOT_HISTORY_MISS_CORRECTION_LIMIT: "1",
      }),
    ).toMatchObject({
      marketSpotlightOptions: {
        briefLimit: 1,
        deepLimit: 3,
        candidateLimit: 25,
      },
      historyOptions: {
        tickerRecentLimit: 2,
        marketRecentLimit: 4,
        recentDays: 45,
        anchorMonths: [1, 3, 9],
        missCorrectionLimit: 1,
      },
    });
  });

  test("rejects invalid history and market spotlight settings", () => {
    expect(() => resolveConfig({ MARKET_BOT_MARKET_SPOTLIGHT_BRIEF_LIMIT: "-1" })).toThrow(
      "Expected non-negative integer",
    );
    expect(() => resolveConfig({ MARKET_BOT_HISTORY_RECENT_DAYS: "0" })).toThrow(
      "Expected positive integer",
    );
    expect(() => resolveConfig({ MARKET_BOT_HISTORY_ANCHOR_MONTHS: "3,0" })).toThrow(
      "Expected comma-separated positive integers",
    );
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
    expect(
      resolveConfig({
        MARKET_BOT_RESEARCH_GATHER_MAX_ROUNDS: "0",
        MARKET_BOT_RESEARCH_GATHER_MAX_TOOL_CALLS: "5",
        MARKET_BOT_RESEARCH_GATHER_SOURCE_BUDGET: "21",
      }).researchGatherOptions,
    ).toEqual({
      maxRounds: 0,
      maxToolCalls: 5,
      sourceBudget: 21,
    });
    expect(
      resolveConfig({
        MARKET_BOT_WEB_GATHER_MAX_ROUNDS: "0",
        MARKET_BOT_WEB_GATHER_MAX_TOOL_CALLS: "3",
        MARKET_BOT_WEB_GATHER_SOURCE_BUDGET: "13",
        MARKET_BOT_WEB_GATHER_DISABLE: "true",
        MARKET_BOT_WEB_PROFILE_REUSE_DAYS: "45",
      }),
    ).toMatchObject({
      webGatherOptions: {
        maxRounds: 0,
        maxToolCalls: 3,
        sourceBudget: 13,
      },
      webGatherDisabled: true,
      webProfileReuseDays: 45,
    });
  });

  test("rejects invalid evidence request loop settings", () => {
    expect(() => resolveConfig({ MARKET_BOT_EVIDENCE_REQUEST_SOURCE_BUDGET: "-1" })).toThrow(
      "Expected non-negative integer",
    );
    expect(() => resolveConfig({ MARKET_BOT_RESEARCH_GATHER_MAX_TOOL_CALLS: "-1" })).toThrow(
      "Expected non-negative integer",
    );
    expect(() => resolveConfig({ MARKET_BOT_WEB_GATHER_SOURCE_BUDGET: "-1" })).toThrow(
      "Expected non-negative integer",
    );
    expect(() => resolveConfig({ MARKET_BOT_WEB_PROFILE_REUSE_DAYS: "0" })).toThrow(
      "Expected positive integer",
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
        MARKET_BOT_EXA_API_KEY: "exa-key",
        MARKET_BOT_SEC_USER_AGENT: "market-bot test@example.test",
      }).sourceOptions,
    ).toMatchObject({
      fredApiKey: "fred-key",
      tradierApiToken: "tradier-token",
      glassnodeApiKey: "glassnode-key",
      exaApiKey: "exa-key",
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

  test("reads forecast disagreement challenger models", () => {
    expect(
      resolveConfig({
        MARKET_BOT_FORECAST_DISAGREEMENT_MODELS: "gpt-5.4, gpt-5.4, gpt-5.5-mini",
      }).forecastDisagreementOptions,
    ).toEqual({ challengerModels: ["gpt-5.4", "gpt-5.5-mini"] });
  });

  test("rejects empty forecast disagreement model entries", () => {
    expect(() =>
      resolveConfig({ MARKET_BOT_FORECAST_DISAGREEMENT_MODELS: "gpt-5.4,,gpt-5.5" }),
    ).toThrow("Expected comma-separated forecast-disagreement model IDs");
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

describe("resolveResearchConsoleConfig", () => {
  test("uses localhost defaults", () => {
    const config = resolveResearchConsoleConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4173);
    expect(config.dataDir).toBe("data/runs");
    expect(config.chat.disabled).toBe(false);
    expect(config.chat.maxOutputTokens).toBe(1500);
    expect(config.chat.historyTurnCap).toBe(20);
  });

  test("reads console port and data directory", () => {
    const config = resolveResearchConsoleConfig({
      MARKET_BOT_CONSOLE_PORT: "5123",
      MARKET_BOT_DATA_DIR: "custom/runs",
    });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(5123);
    expect(config.dataDir).toBe("custom/runs");
  });

  test("reads chat config from env", () => {
    const config = resolveResearchConsoleConfig({
      MARKET_BOT_CONSOLE_CHAT_DISABLE: "1",
      MARKET_BOT_CONSOLE_CHAT_MODEL: "gpt-test",
      MARKET_BOT_CONSOLE_CHAT_MAX_OUTPUT_TOKENS: "2000",
      MARKET_BOT_CONSOLE_CHAT_HISTORY_TURNS: "10",
    });
    expect(config.chat.disabled).toBe(true);
    expect(config.chat.model).toBe("gpt-test");
    expect(config.chat.maxOutputTokens).toBe(2000);
    expect(config.chat.historyTurnCap).toBe(10);
  });

  test("chat webSearch defaults to true when env var is not set", () => {
    const config = resolveResearchConsoleConfig({});
    expect(config.chat.webSearch).toBe(true);
  });

  test("chat webSearch can be disabled with MARKET_BOT_CONSOLE_CHAT_WEB_SEARCH=false", () => {
    const config = resolveResearchConsoleConfig({ MARKET_BOT_CONSOLE_CHAT_WEB_SEARCH: "false" });
    expect(config.chat.webSearch).toBe(false);
  });

  test("chat webSearch can be disabled with MARKET_BOT_CONSOLE_CHAT_WEB_SEARCH=0", () => {
    const config = resolveResearchConsoleConfig({ MARKET_BOT_CONSOLE_CHAT_WEB_SEARCH: "0" });
    expect(config.chat.webSearch).toBe(false);
  });

  test("chat webSearch stays true when explicitly set to true", () => {
    const config = resolveResearchConsoleConfig({ MARKET_BOT_CONSOLE_CHAT_WEB_SEARCH: "true" });
    expect(config.chat.webSearch).toBe(true);
  });

  test("rejects invalid console port", () => {
    expect(() => resolveResearchConsoleConfig({ MARKET_BOT_CONSOLE_PORT: "0" })).toThrow(
      "Expected positive integer",
    );
  });
});
