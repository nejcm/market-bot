import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { sourceGapStatusCode } from "../domain/source-gaps";
import type {
  AssetClass,
  Depth,
  InstrumentIdentity,
  JobType,
  Source,
  SourceGap,
  SourceGapCapability,
  SourceGapCause,
  SourceGapEvidenceQualityImpact,
} from "../domain/types";

const SOURCE_GAPS_FILE = "source-gaps.json";
const REPORT_FILE = "report.json";
const ANALYTICS_FILE = "analytics.json";
const SCORE_FILE = "score.json";
const SAMPLE_MESSAGE_LIMIT = 3;
const US_EQUITY_EXCHANGES = new Set([
  "AMEX",
  "BATS",
  "CBOE",
  "NASDAQ",
  "NASDAQCM",
  "NASDAQGM",
  "NASDAQGS",
  "NYSE",
  "NYSEAMERICAN",
  "NYSEARCA",
]);
const INTERNATIONAL_SUFFIXES = new Set(["L", "T", "TO", "PA"]);

type IssueClass = "missingCredential" | "fetchFailed" | "yahooAuth" | "other";
type ValidationStatus = "pass" | "warn" | "fail";
type ValidationIssueClassification = "blocking" | "expected" | "informational";
type CoverageKey =
  | "daily-equity"
  | "weekly-equity"
  | "daily-crypto"
  | "weekly-crypto"
  | "ticker-equity"
  | "ticker-crypto"
  | "deep-equity-ticker"
  | "international-equity-ticker";

interface SourceHealth {
  readonly kind: Source["kind"];
  readonly assetClass?: AssetClass;
  readonly symbol?: string;
  readonly provider?: string;
  readonly providerAliases: readonly string[];
  readonly identity?: InstrumentIdentity;
}

export interface ValidationCoverageItem {
  readonly key: CoverageKey;
  readonly label: string;
  readonly met: boolean;
  readonly runIds: readonly string[];
}

export interface ValidationRouteClassification {
  readonly route: string;
  readonly provider: string;
  readonly classification: ValidationIssueClassification;
  readonly reason: string;
  readonly runIds: readonly string[];
  readonly sampleMessages: readonly string[];
}

interface RunHealth {
  readonly runId: string;
  readonly generatedAt?: string;
  readonly jobType?: JobType;
  readonly assetClass?: AssetClass;
  readonly symbol?: string;
  readonly depth?: Depth;
  readonly sourceGaps: readonly SourceGap[];
  readonly sources: readonly SourceHealth[];
  readonly predictionHorizons: readonly number[];
  readonly analytics?: Record<string, unknown>;
  readonly scoreCount: number;
  readonly resolvedScoreCount: number;
}

export interface ProviderRouteHealth {
  readonly route: string;
  readonly provider: string;
  readonly total: number;
  readonly missingCredential: number;
  readonly fetchFailed: number;
  readonly yahooAuth: number;
  readonly other: number;
  readonly statuses: Readonly<Record<string, number>>;
  readonly causes: Readonly<Record<string, number>>;
  readonly runIds: readonly string[];
  readonly sampleMessages: readonly string[];
}

export interface ProviderHealthSummary {
  readonly version: 2;
  readonly generatedAt: string;
  readonly runCount: number;
  readonly firstRunAt?: string;
  readonly lastRunAt?: string;
  readonly runsByJobType: Readonly<Record<string, number>>;
  readonly runsByAssetClass: Readonly<Record<string, number>>;
  readonly realRunValidation: {
    readonly marketUpdateRuns: number;
    readonly tickerRuns: number;
    readonly deepTickerRuns: number;
    readonly extendedEvidenceRuns: number;
    readonly marketContextRuns: number;
    readonly sourceGapRuns: number;
    readonly persistentNewsSuppressed: number;
    readonly repeatFallbackKept: number;
    readonly scoredRuns: number;
    readonly resolvedPredictions: number;
    readonly calibrationPresent: boolean;
  };
  readonly gapOverview: {
    readonly total: number;
    readonly missingCredential: number;
    readonly fetchFailed: number;
    readonly yahooAuth: number;
    readonly other: number;
  };
  readonly validation: {
    readonly status: ValidationStatus;
    readonly requiredCoverage: readonly ValidationCoverageItem[];
    readonly blockingIssueCount: number;
    readonly warningIssueCount: number;
    readonly routeClassifications: readonly ValidationRouteClassification[];
  };
  readonly routes: readonly ProviderRouteHealth[];
}

export interface ProviderHealthWriteResult {
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly summary: ProviderHealthSummary;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function recordAt(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const next = value?.[key];
  return isRecord(next) ? next : {};
}

function numberAt(value: Record<string, unknown> | undefined, path: readonly string[]): number {
  const [first, ...rest] = path;
  if (first === undefined) {
    return 0;
  }
  if (rest.length === 0) {
    return numberValue(value?.[first]);
  }
  return numberAt(recordAt(value, first), rest);
}

function isJobType(value: unknown): value is JobType {
  return value === "daily" || value === "weekly" || value === "ticker";
}

function isAssetClass(value: unknown): value is AssetClass {
  return value === "equity" || value === "crypto";
}

function isSourceKind(value: unknown): value is Source["kind"] {
  return (
    value === "market-data" ||
    value === "news" ||
    value === "model" ||
    value === "extended-evidence" ||
    value === "market-context"
  );
}

function isDepth(value: unknown): value is Depth {
  return value === "brief" || value === "deep";
}

function isSourceGapCause(value: unknown): value is SourceGapCause {
  return (
    value === "missing-credential" ||
    value === "fetch-failed" ||
    value === "circuit-open" ||
    value === "stale-fallback" ||
    value === "unsupported-coverage" ||
    value === "repeat-fallback" ||
    value === "malformed-response" ||
    value === "validation-failed" ||
    value === "provider-data-missing"
  );
}

function isSourceGapCapability(value: unknown): value is SourceGapCapability {
  return (
    value === "market-data" ||
    value === "news" ||
    value === "extended-evidence" ||
    value === "market-context" ||
    value === "evidence-request" ||
    value === "cache"
  );
}

function isSourceGapEvidenceQualityImpact(value: unknown): value is SourceGapEvidenceQualityImpact {
  return value === "core-cap" || value === "extended-evidence-cap" || value === "no-cap";
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

async function listRunDirs(dataDir: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(dataDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dataDir, entry.name));
  } catch {
    return [];
  }
}

function parseSourceGap(value: unknown): SourceGap | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const source = stringValue(value.source);
  const message = stringValue(value.message);
  if (source === undefined || message === undefined) {
    return undefined;
  }

  const provider = stringValue(value.provider);
  const capability = isSourceGapCapability(value.capability) ? value.capability : undefined;
  const cause = isSourceGapCause(value.cause) ? value.cause : undefined;
  const evidenceQualityImpact = isSourceGapEvidenceQualityImpact(value.evidenceQualityImpact)
    ? value.evidenceQualityImpact
    : undefined;

  return {
    source,
    message,
    ...(provider !== undefined ? { provider } : {}),
    ...(capability !== undefined ? { capability } : {}),
    ...(cause !== undefined ? { cause } : {}),
    ...(evidenceQualityImpact !== undefined ? { evidenceQualityImpact } : {}),
  };
}

function parseSourceGaps(value: unknown): readonly SourceGap[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    const gap = parseSourceGap(item);
    return gap === undefined ? [] : [gap];
  });
}

function parseIdentity(value: unknown): InstrumentIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const exchange = stringValue(value.exchange);
  const quoteCurrency = stringValue(value.quoteCurrency);
  if (exchange === undefined && quoteCurrency === undefined) {
    return undefined;
  }

  return {
    ...(exchange !== undefined ? { exchange } : {}),
    ...(quoteCurrency !== undefined ? { quoteCurrency } : {}),
  };
}

function parseProviderAliases(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const provider = stringValue(item.provider);
    return provider === undefined ? [] : [provider];
  });
}

function parseSources(value: unknown): readonly SourceHealth[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item) || !isSourceKind(item.kind)) {
      return [];
    }

    const assetClass = isAssetClass(item.assetClass) ? item.assetClass : undefined;
    const symbol = stringValue(item.symbol);
    const provider = stringValue(item.provider);
    const identity = parseIdentity(item.identity);

    return [
      {
        kind: item.kind,
        ...(assetClass !== undefined ? { assetClass } : {}),
        ...(symbol !== undefined ? { symbol } : {}),
        ...(provider !== undefined ? { provider } : {}),
        providerAliases: parseProviderAliases(item.providerAliases),
        ...(identity !== undefined ? { identity } : {}),
      },
    ];
  });
}

function parsePredictionHorizons(value: unknown): readonly number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!isRecord(item)) {
      return [];
    }
    const horizon = numberValue(item.horizonTradingDays);
    return horizon > 0 ? [horizon] : [];
  });
}

function parseScoreCounts(value: unknown): {
  readonly scoreCount: number;
  readonly resolvedScoreCount: number;
} {
  if (!isRecord(value) || !Array.isArray(value.scores)) {
    return { scoreCount: 0, resolvedScoreCount: 0 };
  }

  const resolvedScoreCount = value.scores.filter(
    (score) => isRecord(score) && score.resolved === true,
  ).length;
  return { scoreCount: value.scores.length, resolvedScoreCount };
}

function depthFrom(
  report: Record<string, unknown>,
  analytics: Record<string, unknown> | undefined,
): Depth | undefined {
  if (isDepth(report.depth)) {
    return report.depth;
  }
  if (isDepth(analytics?.depth)) {
    return analytics.depth;
  }
  return undefined;
}

async function loadRunHealth(runDir: string): Promise<RunHealth> {
  const reportRaw = await readJson(join(runDir, REPORT_FILE));
  const report = isRecord(reportRaw) ? reportRaw : {};
  const analyticsRaw = await readJson(join(runDir, ANALYTICS_FILE));
  const analytics = isRecord(analyticsRaw) ? analyticsRaw : undefined;
  const score = parseScoreCounts(await readJson(join(runDir, SCORE_FILE)));
  const sourceGaps = parseSourceGaps(await readJson(join(runDir, "normalized", SOURCE_GAPS_FILE)));
  const generatedAt = stringValue(report.generatedAt);
  const symbol = stringValue(report.symbol);
  const depth = depthFrom(report, analytics);

  return {
    runId: stringValue(report.runId) ?? basename(runDir),
    ...(generatedAt !== undefined ? { generatedAt } : {}),
    ...(isJobType(report.jobType) ? { jobType: report.jobType } : {}),
    ...(isAssetClass(report.assetClass) ? { assetClass: report.assetClass } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(depth !== undefined ? { depth } : {}),
    sourceGaps,
    sources: parseSources(report.sources),
    predictionHorizons: parsePredictionHorizons(report.predictions),
    ...(analytics !== undefined ? { analytics } : {}),
    scoreCount: score.scoreCount,
    resolvedScoreCount: score.resolvedScoreCount,
  };
}

function increment(counts: Record<string, number>, key: string | undefined): void {
  counts[key ?? "unknown"] = (counts[key ?? "unknown"] ?? 0) + 1;
}

function deriveProvider(gap: SourceGap): string {
  if (gap.provider !== undefined) {
    return gap.provider;
  }

  const [provider] = gap.source.split("-");
  return provider ?? "unknown";
}

function isYahooAuthGap(gap: SourceGap): boolean {
  const provider = deriveProvider(gap);
  const message = gap.message.toLowerCase();
  if (provider !== "yahoo") {
    return false;
  }

  return (
    sourceGapStatusCode(gap.message) === "401" ||
    sourceGapStatusCode(gap.message) === "403" ||
    message.includes("cookie") ||
    message.includes("crumb") ||
    message.includes("authorization") ||
    message.includes("unauthorized")
  );
}

function issueClass(gap: SourceGap): IssueClass {
  const message = gap.message.toLowerCase();
  if (isYahooAuthGap(gap)) {
    return "yahooAuth";
  }
  if (
    gap.cause === "missing-credential" ||
    message.includes("missing ") ||
    message.includes("not set")
  ) {
    return "missingCredential";
  }
  if (
    gap.cause === "fetch-failed" ||
    gap.cause === "circuit-open" ||
    sourceGapStatusCode(gap.message)
  ) {
    return "fetchFailed";
  }
  return "other";
}

function emptyRoute(route: string, provider: string): ProviderRouteHealth {
  return {
    route,
    provider,
    total: 0,
    missingCredential: 0,
    fetchFailed: 0,
    yahooAuth: 0,
    other: 0,
    statuses: {},
    causes: {},
    runIds: [],
    sampleMessages: [],
  };
}

function routeHealth(runs: readonly RunHealth[]): readonly ProviderRouteHealth[] {
  const routes = new Map<string, ProviderRouteHealth>();

  for (const run of runs) {
    for (const gap of run.sourceGaps) {
      const provider = deriveProvider(gap);
      const current = routes.get(gap.source) ?? emptyRoute(gap.source, provider);
      const klass = issueClass(gap);
      const statuses = { ...current.statuses };
      const causes = { ...current.causes };
      const status = sourceGapStatusCode(gap.message);

      if (status !== undefined) {
        increment(statuses, status);
      }
      if (gap.cause !== undefined) {
        increment(causes, gap.cause);
      }

      routes.set(gap.source, {
        ...current,
        total: current.total + 1,
        missingCredential: current.missingCredential + (klass === "missingCredential" ? 1 : 0),
        fetchFailed: current.fetchFailed + (klass === "fetchFailed" ? 1 : 0),
        yahooAuth: current.yahooAuth + (klass === "yahooAuth" ? 1 : 0),
        other: current.other + (klass === "other" ? 1 : 0),
        statuses,
        causes,
        runIds: current.runIds.includes(run.runId)
          ? current.runIds
          : [...current.runIds, run.runId],
        sampleMessages: current.sampleMessages.includes(gap.message)
          ? current.sampleMessages
          : [...current.sampleMessages, gap.message].slice(0, SAMPLE_MESSAGE_LIMIT),
      });
    }
  }

  return [...routes.values()].toSorted(
    (a, b) => b.total - a.total || a.route.localeCompare(b.route),
  );
}

function countBy<T>(
  items: readonly T[],
  keyFor: (item: T) => string | undefined,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    increment(counts, keyFor(item));
  }
  return counts;
}

function generatedDates(runs: readonly RunHealth[]): readonly string[] {
  return runs
    .map((run) => run.generatedAt)
    .filter((value): value is string => value !== undefined)
    .toSorted();
}

async function hasCalibration(dataDir: string): Promise<boolean> {
  return (
    (await readJson(join(dataRootFromRunsDir(dataDir), "calibration", "summary.json"))) !==
    undefined
  );
}

function dataRootFromRunsDir(dataDir: string): string {
  return dirname(dataDir);
}

function validationSummary(
  runs: readonly RunHealth[],
  calibrationPresent: boolean,
): ProviderHealthSummary["realRunValidation"] {
  return {
    marketUpdateRuns: runs.filter((run) => run.jobType === "daily" || run.jobType === "weekly")
      .length,
    tickerRuns: runs.filter((run) => run.jobType === "ticker").length,
    deepTickerRuns: runs.filter((run) => run.jobType === "ticker" && run.depth === "deep").length,
    extendedEvidenceRuns: runs.filter(
      (run) =>
        numberAt(run.analytics, ["evidenceQuality", "extendedEvidence", "itemCount"]) +
          numberAt(run.analytics, ["evidenceQuality", "extendedEvidence", "gapCount"]) >
        0,
    ).length,
    marketContextRuns: runs.filter(
      (run) =>
        numberAt(run.analytics, ["evidenceQuality", "marketContext", "itemCount"]) +
          numberAt(run.analytics, ["evidenceQuality", "marketContext", "gapCount"]) >
        0,
    ).length,
    sourceGapRuns: runs.filter((run) => run.sourceGaps.length > 0).length,
    persistentNewsSuppressed: runs.reduce(
      (total, run) =>
        total + numberAt(run.analytics, ["newsDedupe", "persistentSuppressedNewsSourceCount"]),
      0,
    ),
    repeatFallbackKept: runs.reduce(
      (total, run) => total + numberAt(run.analytics, ["newsDedupe", "repeatFallbackKeptCount"]),
      0,
    ),
    scoredRuns: runs.filter((run) => run.scoreCount > 0).length,
    resolvedPredictions: runs.reduce((total, run) => total + run.resolvedScoreCount, 0),
    calibrationPresent,
  };
}

function gapOverview(routes: readonly ProviderRouteHealth[]): ProviderHealthSummary["gapOverview"] {
  return routes.reduce(
    (total, route) => ({
      total: total.total + route.total,
      missingCredential: total.missingCredential + route.missingCredential,
      fetchFailed: total.fetchFailed + route.fetchFailed,
      yahooAuth: total.yahooAuth + route.yahooAuth,
      other: total.other + route.other,
    }),
    { total: 0, missingCredential: 0, fetchFailed: 0, yahooAuth: 0, other: 0 },
  );
}

function exchangeKey(exchange: string): string {
  return exchange.toUpperCase().replaceAll(/[^A-Z]/gu, "");
}

function hasInternationalSuffix(symbol: string | undefined): boolean {
  const suffix = symbol?.match(/\.([A-Z]{1,3})$/u)?.[1];
  return suffix !== undefined && INTERNATIONAL_SUFFIXES.has(suffix);
}

function isInternationalIdentity(identity: InstrumentIdentity | undefined): boolean {
  if (identity?.quoteCurrency !== undefined && identity.quoteCurrency.toUpperCase() !== "USD") {
    return true;
  }
  if (identity?.exchange === undefined) {
    return false;
  }
  return !US_EQUITY_EXCHANGES.has(exchangeKey(identity.exchange));
}

function isInternationalEquityTicker(run: RunHealth): boolean {
  if (run.jobType !== "ticker" || run.assetClass !== "equity") {
    return false;
  }
  if (hasInternationalSuffix(run.symbol)) {
    return true;
  }
  return run.sources.some(
    (source) =>
      (source.assetClass === "equity" || source.assetClass === undefined) &&
      (source.symbol === run.symbol || source.symbol === undefined) &&
      isInternationalIdentity(source.identity),
  );
}

function coverageItem(
  key: CoverageKey,
  label: string,
  runs: readonly RunHealth[],
  matches: (run: RunHealth) => boolean,
): ValidationCoverageItem {
  const runIds = runs.filter((run) => matches(run)).map((run) => run.runId);
  return {
    key,
    label,
    met: runIds.length > 0,
    runIds,
  };
}

function requiredCoverage(runs: readonly RunHealth[]): readonly ValidationCoverageItem[] {
  return [
    coverageItem(
      "daily-equity",
      "Daily equity",
      runs,
      (run) => run.jobType === "daily" && run.assetClass === "equity",
    ),
    coverageItem(
      "weekly-equity",
      "Weekly equity",
      runs,
      (run) => run.jobType === "weekly" && run.assetClass === "equity",
    ),
    coverageItem(
      "daily-crypto",
      "Daily crypto",
      runs,
      (run) => run.jobType === "daily" && run.assetClass === "crypto",
    ),
    coverageItem(
      "weekly-crypto",
      "Weekly crypto",
      runs,
      (run) => run.jobType === "weekly" && run.assetClass === "crypto",
    ),
    coverageItem(
      "ticker-equity",
      "Ticker equity",
      runs,
      (run) => run.jobType === "ticker" && run.assetClass === "equity",
    ),
    coverageItem(
      "ticker-crypto",
      "Ticker crypto",
      runs,
      (run) => run.jobType === "ticker" && run.assetClass === "crypto",
    ),
    coverageItem(
      "deep-equity-ticker",
      "Deep equity ticker",
      runs,
      (run) => run.jobType === "ticker" && run.assetClass === "equity" && run.depth === "deep",
    ),
    coverageItem(
      "international-equity-ticker",
      "International equity ticker smoke",
      runs,
      isInternationalEquityTicker,
    ),
  ];
}

function usableNewsSourceCount(run: RunHealth): number {
  return Math.max(
    numberAt(run.analytics, ["newsDedupe", "selectedNewsSourceCount"]),
    run.sources.filter((source) => source.kind === "news").length,
  );
}

function routeHasCause(route: ProviderRouteHealth, cause: SourceGapCause): boolean {
  return (route.causes[cause] ?? 0) > 0;
}

function routeRunIds(
  route: ProviderRouteHealth,
  runsById: ReadonlyMap<string, RunHealth>,
): readonly string[] {
  return route.runIds.filter((runId) => runsById.has(runId));
}

function classifyRoute(
  route: ProviderRouteHealth,
  runsById: ReadonlyMap<string, RunHealth>,
): ValidationRouteClassification {
  const routeName = route.route.toLowerCase();
  const provider = route.provider.toLowerCase();
  const routeRuns = routeRunIds(route, runsById).map((runId) => runsById.get(runId));
  const hasInternationalRun = routeRuns.some(
    (run): run is RunHealth => run !== undefined && isInternationalEquityTicker(run),
  );
  const base = {
    route: route.route,
    provider: route.provider,
    runIds: route.runIds,
    sampleMessages: route.sampleMessages,
  };

  if (provider === "fred" || routeName.startsWith("fred-")) {
    return {
      ...base,
      classification: "blocking",
      reason: "FRED macro coverage is baseline-required.",
    };
  }
  if (provider === "yahoo" && (route.yahooAuth > 0 || routeHasCause(route, "fetch-failed"))) {
    return {
      ...base,
      classification: "blocking",
      reason: "Yahoo is the primary equity market-data source.",
    };
  }
  if (provider === "coingecko" && (route.fetchFailed > 0 || routeHasCause(route, "fetch-failed"))) {
    return {
      ...base,
      classification: "blocking",
      reason: "CoinGecko is the primary crypto market-data source.",
    };
  }
  if (provider === "marketaux" || provider === "finnhub") {
    return {
      ...base,
      classification: "expected",
      reason: "Individual news provider gaps are nonblocking when usable news exists.",
    };
  }
  if (provider === "massive" || routeName.startsWith("massive-")) {
    return { ...base, classification: "expected", reason: "Massive remains supplemental-only." };
  }
  if (provider === "tradier" || routeName.startsWith("tradier-")) {
    return {
      ...base,
      classification: "expected",
      reason: "Tradier options coverage is optional and can be account- or region-limited.",
    };
  }
  if (provider === "glassnode" || routeName.startsWith("glassnode-")) {
    return {
      ...base,
      classification: "expected",
      reason: "Glassnode remains optional paid crypto enrichment.",
    };
  }
  if (provider === "sec" || routeName.startsWith("sec-")) {
    if (
      hasInternationalRun &&
      (routeHasCause(route, "unsupported-coverage") ||
        routeHasCause(route, "provider-data-missing"))
    ) {
      return {
        ...base,
        classification: "expected",
        reason: "SEC coverage is US-centric and expected to miss international equities.",
      };
    }
    return {
      ...base,
      classification: "expected",
      reason: "SEC extended evidence is nonblocking provider coverage.",
    };
  }
  if (routeName === "news-seen" || routeHasCause(route, "repeat-fallback")) {
    return {
      ...base,
      classification: "informational",
      reason: "Persistent news dedupe fallback is disclosed but nonblocking.",
    };
  }
  if (route.missingCredential > 0) {
    return {
      ...base,
      classification: "expected",
      reason: "Missing optional provider credentials are disclosed as coverage gaps.",
    };
  }
  return {
    ...base,
    classification: "blocking",
    reason: "Unclassified provider gap requires review.",
  };
}

function syntheticClassification(
  route: string,
  classification: ValidationIssueClassification,
  reason: string,
  runIds: readonly string[],
): ValidationRouteClassification {
  return {
    route,
    provider: "validation",
    classification,
    reason,
    runIds,
    sampleMessages: [],
  };
}

function hasDuePrediction(run: RunHealth, now: Date): boolean {
  if (run.generatedAt === undefined || run.predictionHorizons.length === 0) {
    return false;
  }
  const generatedAt = Date.parse(run.generatedAt);
  if (!Number.isFinite(generatedAt)) {
    return false;
  }
  const elapsedDays = Math.floor((now.getTime() - generatedAt) / 86_400_000);
  return run.predictionHorizons.some((horizon) => elapsedDays >= horizon + 2);
}

function buildValidation(
  runs: readonly RunHealth[],
  routes: readonly ProviderRouteHealth[],
  calibrationPresent: boolean,
  now: Date,
): ProviderHealthSummary["validation"] {
  const coverage = requiredCoverage(runs);
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  const classifications: ValidationRouteClassification[] = routes.map((route) =>
    classifyRoute(route, runsById),
  );

  for (const item of coverage) {
    if (!item.met) {
      classifications.push(
        syntheticClassification(
          `coverage:${item.key}`,
          "blocking",
          `Missing required validation run: ${item.label}.`,
          [],
        ),
      );
      continue;
    }

    const laneRuns = item.runIds.flatMap((runId) => {
      const run = runsById.get(runId);
      return run === undefined ? [] : [run];
    });
    if (laneRuns.every((run) => usableNewsSourceCount(run) === 0)) {
      classifications.push(
        syntheticClassification(
          `news:${item.key}`,
          "blocking",
          `No usable news was collected for validation lane: ${item.label}.`,
          item.runIds,
        ),
      );
    }
  }

  const dueRunsWithoutScores = runs.filter(
    (run) => hasDuePrediction(run, now) && run.scoreCount === 0,
  );
  if (dueRunsWithoutScores.length > 0) {
    classifications.push(
      syntheticClassification(
        "scoring:due",
        "blocking",
        "A due scoring pass is missing for matured predictions.",
        dueRunsWithoutScores.map((run) => run.runId),
      ),
    );
  }

  if (!calibrationPresent && runs.some((run) => run.predictionHorizons.length > 0)) {
    classifications.push(
      syntheticClassification(
        "calibration",
        "expected",
        "Calibration is absent before enough prediction horizons mature.",
        runs.filter((run) => run.predictionHorizons.length > 0).map((run) => run.runId),
      ),
    );
  }

  const blockingIssueCount = classifications.filter(
    (classification) => classification.classification === "blocking",
  ).length;
  const warningIssueCount = classifications.filter(
    (classification) => classification.classification !== "blocking",
  ).length;
  let status: ValidationStatus = "pass";
  if (blockingIssueCount > 0) {
    status = "fail";
  } else if (warningIssueCount > 0) {
    status = "warn";
  }

  return {
    status,
    requiredCoverage: coverage,
    blockingIssueCount,
    warningIssueCount,
    routeClassifications: classifications.toSorted(
      (a, b) => a.classification.localeCompare(b.classification) || a.route.localeCompare(b.route),
    ),
  };
}

export async function buildProviderHealthSummary(
  dataDir: string,
  now: Date = new Date(),
): Promise<ProviderHealthSummary> {
  const runDirs = await listRunDirs(dataDir);
  const runs = await Promise.all(runDirs.map((runDir) => loadRunHealth(runDir)));
  const dates = generatedDates(runs);
  const routes = routeHealth(runs);
  const calibrationPresent = await hasCalibration(dataDir);

  return {
    version: 2,
    generatedAt: now.toISOString(),
    runCount: runs.length,
    ...(dates[0] !== undefined ? { firstRunAt: dates[0] } : {}),
    ...(dates.at(-1) !== undefined ? { lastRunAt: dates.at(-1) as string } : {}),
    runsByJobType: countBy(runs, (run) => run.jobType),
    runsByAssetClass: countBy(runs, (run) => run.assetClass),
    realRunValidation: validationSummary(runs, calibrationPresent),
    gapOverview: gapOverview(routes),
    validation: buildValidation(runs, routes, calibrationPresent, now),
    routes,
  };
}

function formatCounts(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return "-";
  }
  return entries.map(([key, value]) => `${key}:${String(value)}`).join(", ");
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.map((cell) => cell.replaceAll("\n", " ")).join(" | ")} |`;
}

export function renderProviderHealthMarkdown(summary: ProviderHealthSummary): string {
  const lines = [
    "# Provider Health",
    "",
    `Generated: ${summary.generatedAt}`,
    `Runs: ${String(summary.runCount)}`,
    "",
    "## Validation",
    "",
    tableRow(["Metric", "Value"]),
    tableRow(["---", "---"]),
    tableRow(["Status", summary.validation.status]),
    tableRow(["Blocking issues", String(summary.validation.blockingIssueCount)]),
    tableRow(["Warning issues", String(summary.validation.warningIssueCount)]),
    "",
    "### Required coverage",
    "",
    tableRow(["Coverage", "Met", "Runs"]),
    tableRow(["---", "---", "---"]),
    ...summary.validation.requiredCoverage.map((item) =>
      tableRow([item.label, item.met ? "yes" : "no", item.runIds.join(", ") || "-"]),
    ),
    "",
    "### Route classifications",
    "",
    tableRow(["Route", "Provider", "Class", "Reason", "Runs", "Sample"]),
    tableRow(["---", "---", "---", "---", "---", "---"]),
    ...summary.validation.routeClassifications.map((classification) =>
      tableRow([
        classification.route,
        classification.provider,
        classification.classification,
        classification.reason,
        classification.runIds.join(", ") || "-",
        classification.sampleMessages[0] ?? "-",
      ]),
    ),
    "",
    "## Real-run validation",
    "",
    tableRow(["Metric", "Value"]),
    tableRow(["---", "---"]),
    tableRow(["Market update runs", String(summary.realRunValidation.marketUpdateRuns)]),
    tableRow(["Ticker runs", String(summary.realRunValidation.tickerRuns)]),
    tableRow(["Deep ticker runs", String(summary.realRunValidation.deepTickerRuns)]),
    tableRow([
      "Extended Evidence exercised",
      String(summary.realRunValidation.extendedEvidenceRuns),
    ]),
    tableRow(["Market Context exercised", String(summary.realRunValidation.marketContextRuns)]),
    tableRow(["Runs with source gaps", String(summary.realRunValidation.sourceGapRuns)]),
    tableRow([
      "Persistent news suppressed",
      String(summary.realRunValidation.persistentNewsSuppressed),
    ]),
    tableRow(["Repeat fallback kept", String(summary.realRunValidation.repeatFallbackKept)]),
    tableRow(["Scored runs", String(summary.realRunValidation.scoredRuns)]),
    tableRow(["Resolved predictions", String(summary.realRunValidation.resolvedPredictions)]),
    tableRow(["Calibration present", summary.realRunValidation.calibrationPresent ? "yes" : "no"]),
    "",
    "## Gap overview",
    "",
    tableRow(["Total", "Missing credentials", "Fetch failed", "Yahoo auth", "Other"]),
    tableRow(["---", "---", "---", "---", "---"]),
    tableRow([
      String(summary.gapOverview.total),
      String(summary.gapOverview.missingCredential),
      String(summary.gapOverview.fetchFailed),
      String(summary.gapOverview.yahooAuth),
      String(summary.gapOverview.other),
    ]),
    "",
    "## Routes",
    "",
    tableRow(["Route", "Provider", "Total", "Status", "Cause", "Sample"]),
    tableRow(["---", "---", "---", "---", "---", "---"]),
    ...summary.routes.map((route) =>
      tableRow([
        route.route,
        route.provider,
        String(route.total),
        formatCounts(route.statuses),
        formatCounts(route.causes),
        route.sampleMessages[0] ?? "-",
      ]),
    ),
    "",
  ];

  return `${lines.join("\n")}\n`;
}

export async function writeProviderHealthSummary(
  dataDir: string,
  now: Date = new Date(),
): Promise<ProviderHealthWriteResult> {
  const summary = await buildProviderHealthSummary(dataDir, now);
  const outputDir = join(dataRootFromRunsDir(dataDir), "provider-health");
  const jsonPath = join(outputDir, "summary.json");
  const markdownPath = join(outputDir, "summary.md");

  await mkdir(outputDir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(summary, undefined, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderProviderHealthMarkdown(summary), "utf8");

  return { jsonPath, markdownPath, summary };
}
