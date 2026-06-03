import { basename, dirname, join } from "node:path";
import type { ModelParams } from "./model/types";

export type ProviderName = "openai" | "openai-compatible" | "codex" | "anthropic";

export interface SourceOptions {
  readonly equityMoverLimit: number;
  readonly cryptoMoverLimit: number;
  readonly newsLimit: number;
  readonly sourceTimeoutMs: number;
  readonly marketauxApiToken?: string;
  readonly finnhubApiToken?: string;
  readonly fredApiKey?: string;
  readonly tradierApiToken?: string;
  readonly glassnodeApiKey?: string;
  readonly massiveApiKey?: string;
  readonly secUserAgent?: string;
  readonly cacheDir?: string;
  readonly cacheDisabled?: boolean;
  readonly cacheFallbackDays?: number;
  readonly newsSeenPath?: string;
  readonly newsSeenRetentionDays?: number;
}

export interface EvidenceRequestOptions {
  readonly maxRounds: number;
  readonly maxToolCalls: number;
  readonly sourceBudget: number;
}

export interface AlphaSearchOptions {
  readonly apeWisdomFilter: string;
  readonly apeWisdomBriefPageLimit: number;
  readonly apeWisdomDeepPageLimit: number;
  readonly validationCandidateLimit: number;
  readonly leadLimit: number;
  readonly topCandidateLimit: number;
  readonly minPrice: number;
  readonly minVolume: number;
  readonly minMarketCap: number;
  readonly maxMarketCap: number;
}

export interface AppConfig {
  readonly provider: ProviderName;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly quickModel: string;
  readonly synthesisModel: string;
  readonly codexQuickModel?: string;
  readonly codexSynthesisModel?: string;
  readonly modelParams?: ModelParams;
  readonly modelTimeoutMs: number;
  readonly dataDir: string;
  readonly promptDir: string;
  readonly sourceOptions: SourceOptions;
  readonly evidenceRequestOptions: EvidenceRequestOptions;
  readonly alphaSearchOptions: AlphaSearchOptions;
}

export interface ResolveConfigOptions {
  readonly validateAlphaSearchOptions?: boolean;
}

const DEFAULT_QUICK_MODEL = "gpt-5.4-mini";
const DEFAULT_SYNTHESIS_MODEL = "gpt-5.5";
const DEFAULT_ANTHROPIC_QUICK_MODEL = "claude-sonnet-4-6";
const DEFAULT_ANTHROPIC_SYNTHESIS_MODEL = "claude-opus-4-8";
const DEFAULT_MODEL_TIMEOUT_MS = 120_000;
const DEFAULT_DATA_DIR = "data/runs";
const DEFAULT_PROMPT_DIR = join(import.meta.dir, "../prompts");
const DEFAULT_SEC_USER_AGENT = "market-bot research contact@example.invalid";
const DEFAULT_NEWS_SEEN_RETENTION_DAYS = 30;
const DEFAULT_ALPHA_SEARCH_CANDIDATE_LIMIT = 15;
const DEFAULT_APEWISDOM_FILTER = "all-stocks";
const DEFAULT_APEWISDOM_BRIEF_PAGE_LIMIT = 5;
const DEFAULT_APEWISDOM_DEEP_PAGE_LIMIT = 10;
const DEFAULT_ALPHA_SEARCH_VALIDATION_LIMIT = 25;
const DEFAULT_ALPHA_SEARCH_LEAD_LIMIT = 15;
const DEFAULT_ALPHA_SEARCH_MIN_PRICE = 0.5;
const DEFAULT_ALPHA_SEARCH_MIN_VOLUME = 100_000;
const DEFAULT_ALPHA_SEARCH_MIN_MARKET_CAP = 50_000_000;
const DEFAULT_ALPHA_SEARCH_MAX_MARKET_CAP = 10_000_000_000;
const APEWISDOM_FILTER_RE = /^[A-Za-z0-9-]+$/u;

function readBoolean(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected positive integer, received ${value}`);
  }

  return parsed;
}

function readPositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive number, received ${value}`);
  }

  return parsed;
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected non-negative integer, received ${value}`);
  }

  return parsed;
}

function readProvider(value: string | undefined): ProviderName {
  if (value === undefined || value === "" || value === "openai") {
    return "openai";
  }

  if (value === "openai-compatible" || value === "codex" || value === "anthropic") {
    return value;
  }

  throw new Error(`Unsupported provider: ${value}`);
}

function readOptionalString(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function readApiKey(
  provider: ProviderName,
  env: Record<string, string | undefined>,
): string | undefined {
  if (provider === "openai") {
    return (
      readOptionalString(env.MARKET_BOT_OPENAI_API_KEY) ?? readOptionalString(env.OPENAI_API_KEY)
    );
  }

  if (provider === "openai-compatible") {
    return readOptionalString(env.MARKET_BOT_OPENAI_API_KEY);
  }

  if (provider === "anthropic") {
    return (
      readOptionalString(env.MARKET_BOT_ANTHROPIC_API_KEY) ??
      readOptionalString(env.ANTHROPIC_API_KEY)
    );
  }

  return undefined;
}

function readReasoningEffort(
  value: string | undefined,
): ModelParams["reasoningEffort"] | undefined {
  const effort = readOptionalString(value);
  if (effort === undefined) {
    return undefined;
  }

  if (effort === "low" || effort === "medium" || effort === "high") {
    return effort;
  }

  throw new Error(`Unsupported reasoning effort: ${effort}`);
}

function deriveNewsSeenPath(dataDir: string): string {
  const dataRoot = basename(dataDir) === "runs" ? dirname(dataDir) : dataDir;
  return join(dataRoot, "news-seen.json");
}

function readApeWisdomFilter(value: string | undefined): string {
  const filter = readOptionalString(value) ?? DEFAULT_APEWISDOM_FILTER;
  if (!APEWISDOM_FILTER_RE.test(filter)) {
    throw new Error(`Invalid ApeWisdom filter: ${filter}`);
  }
  return filter;
}

function defaultAlphaSearchOptions(): AlphaSearchOptions {
  return {
    apeWisdomFilter: DEFAULT_APEWISDOM_FILTER,
    apeWisdomBriefPageLimit: DEFAULT_APEWISDOM_BRIEF_PAGE_LIMIT,
    apeWisdomDeepPageLimit: DEFAULT_APEWISDOM_DEEP_PAGE_LIMIT,
    validationCandidateLimit: DEFAULT_ALPHA_SEARCH_VALIDATION_LIMIT,
    leadLimit: DEFAULT_ALPHA_SEARCH_LEAD_LIMIT,
    topCandidateLimit: DEFAULT_ALPHA_SEARCH_CANDIDATE_LIMIT,
    minPrice: DEFAULT_ALPHA_SEARCH_MIN_PRICE,
    minVolume: DEFAULT_ALPHA_SEARCH_MIN_VOLUME,
    minMarketCap: DEFAULT_ALPHA_SEARCH_MIN_MARKET_CAP,
    maxMarketCap: DEFAULT_ALPHA_SEARCH_MAX_MARKET_CAP,
  };
}

function resolveAlphaSearchOptions(env: Record<string, string | undefined>): AlphaSearchOptions {
  const minMarketCap = readPositiveNumber(
    env.MARKET_BOT_ALPHA_SEARCH_MIN_MARKET_CAP,
    DEFAULT_ALPHA_SEARCH_MIN_MARKET_CAP,
  );
  const maxMarketCap = readPositiveNumber(
    env.MARKET_BOT_ALPHA_SEARCH_MAX_MARKET_CAP,
    DEFAULT_ALPHA_SEARCH_MAX_MARKET_CAP,
  );
  if (maxMarketCap < minMarketCap) {
    throw new Error(
      "MARKET_BOT_ALPHA_SEARCH_MAX_MARKET_CAP must be greater than or equal to minimum",
    );
  }

  return {
    apeWisdomFilter: readApeWisdomFilter(env.MARKET_BOT_APEWISDOM_FILTER),
    apeWisdomBriefPageLimit: readPositiveInteger(
      env.MARKET_BOT_APEWISDOM_BRIEF_PAGE_LIMIT,
      DEFAULT_APEWISDOM_BRIEF_PAGE_LIMIT,
    ),
    apeWisdomDeepPageLimit: readPositiveInteger(
      env.MARKET_BOT_APEWISDOM_DEEP_PAGE_LIMIT,
      DEFAULT_APEWISDOM_DEEP_PAGE_LIMIT,
    ),
    validationCandidateLimit: readPositiveInteger(
      env.MARKET_BOT_ALPHA_SEARCH_VALIDATION_LIMIT,
      DEFAULT_ALPHA_SEARCH_VALIDATION_LIMIT,
    ),
    leadLimit: readPositiveInteger(
      env.MARKET_BOT_ALPHA_SEARCH_LEAD_LIMIT,
      DEFAULT_ALPHA_SEARCH_LEAD_LIMIT,
    ),
    topCandidateLimit: readPositiveInteger(
      env.MARKET_BOT_ALPHA_SEARCH_CANDIDATE_LIMIT,
      DEFAULT_ALPHA_SEARCH_CANDIDATE_LIMIT,
    ),
    minPrice: readPositiveNumber(
      env.MARKET_BOT_ALPHA_SEARCH_MIN_PRICE,
      DEFAULT_ALPHA_SEARCH_MIN_PRICE,
    ),
    minVolume: readPositiveNumber(
      env.MARKET_BOT_ALPHA_SEARCH_MIN_VOLUME,
      DEFAULT_ALPHA_SEARCH_MIN_VOLUME,
    ),
    minMarketCap,
    maxMarketCap,
  };
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "");
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

function readBaseUrl(provider: ProviderName, value: string | undefined): string | undefined {
  const baseUrl = readOptionalString(value);
  if (provider !== "openai-compatible" && baseUrl !== undefined) {
    throw new Error("MARKET_BOT_BASE_URL requires MARKET_BOT_PROVIDER=openai-compatible");
  }

  if (provider !== "openai-compatible") {
    return undefined;
  }

  if (baseUrl === undefined) {
    throw new Error("MARKET_BOT_BASE_URL is required for openai-compatible provider");
  }

  const parsed = (() => {
    try {
      return new URL(baseUrl);
    } catch {
      throw new Error("MARKET_BOT_BASE_URL must be a valid URL");
    }
  })();

  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("MARKET_BOT_BASE_URL must not include credentials");
  }

  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
  ) {
    throw new Error("MARKET_BOT_BASE_URL must use https unless it targets localhost");
  }

  return parsed.toString().replace(/\/$/u, "");
}

export function resolveConfig(
  env: Record<string, string | undefined> = process.env,
  options: ResolveConfigOptions = {},
): AppConfig {
  const provider = readProvider(env.MARKET_BOT_PROVIDER);
  const apiKey = readApiKey(provider, env);
  const baseUrl = readBaseUrl(provider, env.MARKET_BOT_BASE_URL);
  const quickModelDefault =
    provider === "anthropic" ? DEFAULT_ANTHROPIC_QUICK_MODEL : DEFAULT_QUICK_MODEL;
  const synthesisModelDefault =
    provider === "anthropic" ? DEFAULT_ANTHROPIC_SYNTHESIS_MODEL : DEFAULT_SYNTHESIS_MODEL;
  const reasoningEffort = readReasoningEffort(env.MARKET_BOT_REASONING_EFFORT);

  const dataDir = env.MARKET_BOT_DATA_DIR ?? DEFAULT_DATA_DIR;
  const massiveApiKey =
    readOptionalString(env.MARKET_BOT_MASSIVE_API_KEY) ??
    readOptionalString(env.MARKET_BOT_POLYGON_API_KEY);

  return {
    provider,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(apiKey !== undefined ? { apiKey } : {}),
    quickModel: env.MARKET_BOT_QUICK_MODEL ?? quickModelDefault,
    synthesisModel: env.MARKET_BOT_SYNTHESIS_MODEL ?? synthesisModelDefault,
    ...(readOptionalString(env.MARKET_BOT_CODEX_QUICK_MODEL) !== undefined
      ? { codexQuickModel: readOptionalString(env.MARKET_BOT_CODEX_QUICK_MODEL) as string }
      : {}),
    ...(readOptionalString(env.MARKET_BOT_CODEX_SYNTHESIS_MODEL) !== undefined
      ? { codexSynthesisModel: readOptionalString(env.MARKET_BOT_CODEX_SYNTHESIS_MODEL) as string }
      : {}),
    ...(reasoningEffort !== undefined ? { modelParams: { reasoningEffort } } : {}),
    modelTimeoutMs: readPositiveInteger(env.MARKET_BOT_MODEL_TIMEOUT_MS, DEFAULT_MODEL_TIMEOUT_MS),
    dataDir,
    promptDir: readOptionalString(env.MARKET_BOT_PROMPT_DIR) ?? DEFAULT_PROMPT_DIR,
    sourceOptions: {
      equityMoverLimit: readPositiveInteger(env.MARKET_BOT_EQUITY_MOVER_LIMIT, 5),
      cryptoMoverLimit: readPositiveInteger(env.MARKET_BOT_CRYPTO_MOVER_LIMIT, 5),
      newsLimit: readPositiveInteger(env.MARKET_BOT_NEWS_LIMIT, 8),
      sourceTimeoutMs: readPositiveInteger(env.MARKET_BOT_SOURCE_TIMEOUT_MS, 15_000),
      ...(readOptionalString(env.MARKET_BOT_MARKETAUX_API_TOKEN) !== undefined
        ? { marketauxApiToken: readOptionalString(env.MARKET_BOT_MARKETAUX_API_TOKEN) as string }
        : {}),
      ...(readOptionalString(env.MARKET_BOT_FINNHUB_API_TOKEN) !== undefined
        ? { finnhubApiToken: readOptionalString(env.MARKET_BOT_FINNHUB_API_TOKEN) as string }
        : {}),
      ...(readOptionalString(env.MARKET_BOT_FRED_API_KEY) !== undefined
        ? { fredApiKey: readOptionalString(env.MARKET_BOT_FRED_API_KEY) as string }
        : {}),
      ...(readOptionalString(env.MARKET_BOT_TRADIER_API_TOKEN) !== undefined
        ? { tradierApiToken: readOptionalString(env.MARKET_BOT_TRADIER_API_TOKEN) as string }
        : {}),
      ...(readOptionalString(env.MARKET_BOT_GLASSNODE_API_KEY) !== undefined
        ? { glassnodeApiKey: readOptionalString(env.MARKET_BOT_GLASSNODE_API_KEY) as string }
        : {}),
      ...(massiveApiKey !== undefined ? { massiveApiKey } : {}),
      secUserAgent: readOptionalString(env.MARKET_BOT_SEC_USER_AGENT) ?? DEFAULT_SEC_USER_AGENT,
      cacheDir: env.MARKET_BOT_CACHE_DIR ?? "data/cache",
      cacheDisabled: readBoolean(env.MARKET_BOT_CACHE_DISABLE),
      cacheFallbackDays: readPositiveInteger(env.MARKET_BOT_CACHE_FALLBACK_DAYS, 7),
      newsSeenPath:
        readOptionalString(env.MARKET_BOT_NEWS_SEEN_PATH) ?? deriveNewsSeenPath(dataDir),
      newsSeenRetentionDays: readPositiveInteger(
        env.MARKET_BOT_NEWS_SEEN_RETENTION_DAYS,
        DEFAULT_NEWS_SEEN_RETENTION_DAYS,
      ),
    },
    evidenceRequestOptions: {
      maxRounds: readNonNegativeInteger(env.MARKET_BOT_EVIDENCE_REQUEST_MAX_ROUNDS, 2),
      maxToolCalls: readNonNegativeInteger(env.MARKET_BOT_EVIDENCE_REQUEST_MAX_TOOL_CALLS, 2),
      sourceBudget: readNonNegativeInteger(env.MARKET_BOT_EVIDENCE_REQUEST_SOURCE_BUDGET, 8),
    },
    alphaSearchOptions:
      options.validateAlphaSearchOptions === false
        ? defaultAlphaSearchOptions()
        : resolveAlphaSearchOptions(env),
  };
}
