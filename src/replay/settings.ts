import type { AppConfig, SourceOptions } from "../config";
import { isRecord } from "../guards";

export const CAPTURE_PROVIDERS = [
  "marketauxApiToken",
  "finnhubApiToken",
  "fredApiKey",
  "tradierApiToken",
  "glassnodeApiKey",
  "massiveApiKey",
  "exaApiKey",
  "firecrawlApiKey",
] as const;

type CapturedConfigKey =
  | "provider"
  | "quickModel"
  | "synthesisModel"
  | "quickReasoningEffort"
  | "synthesisReasoningEffort"
  | "codexQuickReasoningEffort"
  | "codexSynthesisReasoningEffort"
  | "modelTimeoutMs"
  | "evidenceRequestOptions"
  | "webGatherOptions"
  | "webGatherDisabled"
  | "webProfileReuseDaysBySubjectKind"
  | "alphaSearchOptions"
  | "marketSpotlightOptions"
  | "forecastDisagreementOptions"
  | "historyOptions";

export type CaptureSettings = Pick<AppConfig, CapturedConfigKey> & {
  readonly sourceOptions: Pick<
    SourceOptions,
    | "equityMoverLimit"
    | "cryptoMoverLimit"
    | "newsLimit"
    | "sourceTimeoutMs"
    | "secUserAgent"
    | "cacheDisabled"
    | "cacheFallbackDays"
    | "newsSeenRetentionDays"
    | "peerUniverseTtlDays"
  >;
  readonly configuredProviders: readonly (typeof CAPTURE_PROVIDERS)[number][];
};

export function captureSettings(config: AppConfig): CaptureSettings {
  const source = config.sourceOptions;
  return {
    provider: config.provider,
    quickModel: config.quickModel,
    synthesisModel: config.synthesisModel,
    ...(config.quickReasoningEffort === undefined
      ? {}
      : { quickReasoningEffort: config.quickReasoningEffort }),
    ...(config.synthesisReasoningEffort === undefined
      ? {}
      : { synthesisReasoningEffort: config.synthesisReasoningEffort }),
    ...(config.codexQuickReasoningEffort === undefined
      ? {}
      : { codexQuickReasoningEffort: config.codexQuickReasoningEffort }),
    ...(config.codexSynthesisReasoningEffort === undefined
      ? {}
      : { codexSynthesisReasoningEffort: config.codexSynthesisReasoningEffort }),
    modelTimeoutMs: config.modelTimeoutMs,
    sourceOptions: {
      equityMoverLimit: source.equityMoverLimit,
      cryptoMoverLimit: source.cryptoMoverLimit,
      newsLimit: source.newsLimit,
      sourceTimeoutMs: source.sourceTimeoutMs,
      ...(source.secUserAgent === undefined ? {} : { secUserAgent: source.secUserAgent }),
      cacheDisabled: source.cacheDisabled === true || source.cacheDir === undefined,
      ...(source.cacheFallbackDays === undefined
        ? {}
        : { cacheFallbackDays: source.cacheFallbackDays }),
      ...(source.newsSeenRetentionDays === undefined
        ? {}
        : { newsSeenRetentionDays: source.newsSeenRetentionDays }),
      ...(source.peerUniverseTtlDays === undefined
        ? {}
        : { peerUniverseTtlDays: source.peerUniverseTtlDays }),
    },
    configuredProviders: CAPTURE_PROVIDERS.filter((key) => source[key] !== undefined),
    evidenceRequestOptions: config.evidenceRequestOptions,
    webGatherOptions: config.webGatherOptions,
    webGatherDisabled: config.webGatherDisabled,
    webProfileReuseDaysBySubjectKind: config.webProfileReuseDaysBySubjectKind,
    alphaSearchOptions: config.alphaSearchOptions,
    ...(config.marketSpotlightOptions === undefined
      ? {}
      : { marketSpotlightOptions: config.marketSpotlightOptions }),
    ...(config.forecastDisagreementOptions === undefined
      ? {}
      : { forecastDisagreementOptions: config.forecastDisagreementOptions }),
    ...(config.historyOptions === undefined ? {} : { historyOptions: config.historyOptions }),
  };
}

export function assertCaptureSettings(value: unknown): asserts value is CaptureSettings {
  const keys = new Set([
    "provider",
    "quickModel",
    "synthesisModel",
    "quickReasoningEffort",
    "synthesisReasoningEffort",
    "codexQuickReasoningEffort",
    "codexSynthesisReasoningEffort",
    "modelTimeoutMs",
    "sourceOptions",
    "configuredProviders",
    "evidenceRequestOptions",
    "webGatherOptions",
    "webGatherDisabled",
    "webProfileReuseDaysBySubjectKind",
    "alphaSearchOptions",
    "marketSpotlightOptions",
    "forecastDisagreementOptions",
    "historyOptions",
  ]);
  const sourceKeys = new Set([
    "equityMoverLimit",
    "cryptoMoverLimit",
    "newsLimit",
    "sourceTimeoutMs",
    "secUserAgent",
    "cacheDisabled",
    "cacheFallbackDays",
    "newsSeenRetentionDays",
    "peerUniverseTtlDays",
  ]);
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !keys.has(key)) ||
    !isRecord(value.sourceOptions) ||
    Object.keys(value.sourceOptions).some((key) => !sourceKeys.has(key)) ||
    !["equityMoverLimit", "cryptoMoverLimit", "newsLimit", "sourceTimeoutMs"].every((key) => {
      const field = isRecord(value.sourceOptions) ? value.sourceOptions[key] : undefined;
      return typeof field === "number" && Number.isFinite(field) && field >= 0;
    }) ||
    !["openai", "openai-compatible", "codex", "anthropic"].includes(String(value.provider)) ||
    typeof value.quickModel !== "string" ||
    typeof value.synthesisModel !== "string" ||
    !Array.isArray(value.configuredProviders) ||
    !value.configuredProviders.every((key) =>
      CAPTURE_PROVIDERS.some((candidate) => candidate === key),
    ) ||
    !isRecord(value.evidenceRequestOptions) ||
    !isRecord(value.webGatherOptions) ||
    !isRecord(value.alphaSearchOptions) ||
    !isRecord(value.webProfileReuseDaysBySubjectKind) ||
    typeof value.webGatherDisabled !== "boolean"
  ) {
    throw new Error("Invalid captured settings");
  }
}
