export type ProviderName = "openai" | "openai-compatible";

export interface SourceOptions {
  readonly equityMoverLimit: number;
  readonly cryptoMoverLimit: number;
  readonly newsLimit: number;
  readonly sourceTimeoutMs: number;
  readonly cacheDir?: string;
  readonly cacheDisabled?: boolean;
  readonly cacheFallbackDays?: number;
}

export interface AppConfig {
  readonly provider: ProviderName;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly quickModel: string;
  readonly synthesisModel: string;
  readonly dataDir: string;
  readonly sourceOptions: SourceOptions;
}

const DEFAULT_QUICK_MODEL = "gpt-4.1-mini";
const DEFAULT_SYNTHESIS_MODEL = "gpt-4.1";
const DEFAULT_DATA_DIR = "data/runs";

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

function readProvider(value: string | undefined): ProviderName {
  if (value === undefined || value === "" || value === "openai") {
    return "openai";
  }

  if (value === "openai-compatible") {
    return value;
  }

  throw new Error(`Unsupported provider: ${value}`);
}

export function resolveConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const provider = readProvider(env.MARKET_BOT_PROVIDER);
  const apiKey = env.MARKET_BOT_OPENAI_API_KEY ?? env.OPENAI_API_KEY;
  const baseUrl = env.MARKET_BOT_BASE_URL;

  if (provider === "openai-compatible" && (baseUrl === undefined || baseUrl.trim() === "")) {
    throw new Error("MARKET_BOT_BASE_URL is required for openai-compatible provider");
  }

  return {
    provider,
    ...(baseUrl !== undefined && baseUrl.trim() !== "" ? { baseUrl } : {}),
    ...(apiKey !== undefined && apiKey.trim() !== "" ? { apiKey } : {}),
    quickModel: env.MARKET_BOT_QUICK_MODEL ?? DEFAULT_QUICK_MODEL,
    synthesisModel: env.MARKET_BOT_SYNTHESIS_MODEL ?? DEFAULT_SYNTHESIS_MODEL,
    dataDir: env.MARKET_BOT_DATA_DIR ?? DEFAULT_DATA_DIR,
    sourceOptions: {
      equityMoverLimit: readPositiveInteger(env.MARKET_BOT_EQUITY_MOVER_LIMIT, 5),
      cryptoMoverLimit: readPositiveInteger(env.MARKET_BOT_CRYPTO_MOVER_LIMIT, 5),
      newsLimit: readPositiveInteger(env.MARKET_BOT_NEWS_LIMIT, 8),
      sourceTimeoutMs: readPositiveInteger(env.MARKET_BOT_SOURCE_TIMEOUT_MS, 15_000),
      cacheDir: env.MARKET_BOT_CACHE_DIR ?? "data/cache",
      cacheDisabled: readBoolean(env.MARKET_BOT_CACHE_DISABLE),
      cacheFallbackDays: readPositiveInteger(env.MARKET_BOT_CACHE_FALLBACK_DAYS, 7),
    },
  };
}
