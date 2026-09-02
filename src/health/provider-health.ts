import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { dataRootFromRunsDir } from "../data-paths";
import {
  isSourceGapCapability,
  isSourceGapCause,
  isSourceGapEvidenceQualityImpact,
  isSourceGapTriage,
  sourceGapStatusCode,
} from "../domain/source-gaps";
import {
  SOURCE_KINDS,
  isInstrumentJobType,
  isMarketUpdateJobType,
  type AssetClass,
  type Depth,
  type InstrumentIdentity,
  type JobType,
  type Source,
  type SourceGap,
} from "../domain/types";
import {
  loadRunSubsystemOutcomesFromIndex,
  readRunArtifactIndexStatus,
  scanRunSubsystemOutcomesFromDisk,
  type RunArtifactIndexStatus,
} from "../run-artifact-index";
import { RUN_ARTIFACT_FILES, type ArtifactFileStatus } from "../run-artifact-layout";
import { isDeepEquityReport } from "../deep-equity/artifact-schema";
import {
  loadDeepEquityEvidenceBundle,
  readSourceGapAttempts,
  type LoadedDeepEquityEvidenceBundle,
} from "../run-artifacts";
import { readAnalytics } from "../run-artifact-analytics-reader";
import {
  rollupSubsystemOutcomes,
  type SubsystemOutcomeRollup,
} from "../research/subsystem-outcomes";
import { isRecord, numberAt, readNumber } from "../guards";
import { deriveWebSearchEndpointAvailability } from "../sources/provider-endpoint-availability";
import type { RunSubsystemOutcome, RunSubsystemOutcomeLedger } from "../run-artifact-projection";
import {
  buildValidation,
  type ProviderValidationSummary,
  type ValidationIssueClassification,
} from "./validation";

const SOURCE_GAPS_FILE = RUN_ARTIFACT_FILES.sourceGaps;
const REPORT_FILE = RUN_ARTIFACT_FILES.report;
const SCORE_FILE = RUN_ARTIFACT_FILES.score;
const FAILURE_FILE = RUN_ARTIFACT_FILES.failure;
const SAMPLE_MESSAGE_LIMIT = 3;

type IssueClass = "missingCredential" | "fetchFailed" | "yahooAuth" | "other";

interface SourceHealth {
  readonly kind: Source["kind"];
  readonly assetClass?: AssetClass;
  readonly symbol?: string;
  readonly provider?: string;
  readonly identity?: InstrumentIdentity;
}

export interface RunHealth {
  readonly runId: string;
  readonly failed: boolean;
  readonly generatedAt?: string;
  readonly jobType?: JobType;
  readonly assetClass?: AssetClass;
  readonly symbol?: string;
  readonly depth?: Depth;
  readonly horizonTradingDays?: number;
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
  /** Runs whose `analytics.json` reported this endpoint `degraded`. Never sourced from Source
   *  Gaps: a covered web-search fallback deliberately emits none. */
  readonly degraded: number;
  /** Subset of `degraded` where a fallback provider actually served that run. Coverage is read
   *  from the run's own `firecrawlSearch` row, never inferred from the fact of degradation: a
   *  degraded `firecrawlSearch` row means the mitigation itself failed, so it never counts here. */
  readonly degradedCovered: number;
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
  readonly version: 3;
  readonly generatedAt: string;
  readonly runCount: number;
  readonly firstRunAt?: string;
  readonly lastRunAt?: string;
  readonly runsByJobType: Readonly<Record<string, number>>;
  readonly runsByAssetClass: Readonly<Record<string, number>>;
  readonly realRunValidation: {
    readonly marketUpdateRuns: number;
    readonly instrumentRuns: number;
    readonly deepInstrumentRuns: number;
    readonly extendedEvidenceRuns: number;
    readonly marketContextRuns: number;
    readonly sourceGapRuns: number;
    readonly persistentNewsSuppressed: number;
    readonly repeatFallbackKept: number;
    readonly relevantRepeatKept: number;
    readonly scoredRuns: number;
    readonly resolvedPredictions: number;
    readonly calibrationPresent: boolean;
  };
  readonly subsystemOutcomes: SubsystemOutcomeRollup & {
    readonly failedRunCount: number;
    readonly ledgerStatus: Readonly<Record<ArtifactFileStatus, number>>;
  };
  readonly gapOverview: {
    readonly total: number;
    readonly missingCredential: number;
    readonly fetchFailed: number;
    readonly yahooAuth: number;
    readonly other: number;
  };
  readonly runArtifactIndex: RunArtifactIndexStatus;
  readonly validation: ProviderValidationSummary;
  readonly routes: readonly ProviderRouteHealth[];
}

export interface ProviderHealthWriteResult {
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly summary: ProviderHealthSummary;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isJobType(value: unknown): value is JobType {
  return (
    value === "market-overview" ||
    value === "daily" ||
    value === "weekly" ||
    value === "equity" ||
    value === "crypto" ||
    value === "alpha-search" ||
    value === "research"
  );
}

function isAssetClass(value: unknown): value is AssetClass {
  return value === "equity" || value === "crypto";
}

const SOURCE_KIND_SET: ReadonlySet<Source["kind"]> = new Set(SOURCE_KINDS);

function isSourceKind(value: unknown): value is Source["kind"] {
  return typeof value === "string" && SOURCE_KIND_SET.has(value as Source["kind"]);
}

function isDepth(value: unknown): value is Depth {
  return value === "brief" || value === "deep";
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

export function parseSourceGap(value: unknown): SourceGap | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const source = stringValue(value.source);
  const message = stringValue(value.message);
  if (source === undefined || message === undefined) {
    return undefined;
  }

  const provider = stringValue(value.provider);
  const symbol = stringValue(value.symbol);
  const capability = isSourceGapCapability(value.capability) ? value.capability : undefined;
  const cause = isSourceGapCause(value.cause) ? value.cause : undefined;
  const evidenceQualityImpact = isSourceGapEvidenceQualityImpact(value.evidenceQualityImpact)
    ? value.evidenceQualityImpact
    : undefined;
  const triage = isSourceGapTriage(value.triage) ? value.triage : undefined;
  const attempts = readSourceGapAttempts(value.attempts);

  return {
    source,
    message,
    ...(symbol !== undefined ? { symbol } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(capability !== undefined ? { capability } : {}),
    ...(cause !== undefined ? { cause } : {}),
    ...(evidenceQualityImpact !== undefined ? { evidenceQualityImpact } : {}),
    ...(triage !== undefined ? { triage } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
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
        ...(identity !== undefined ? { identity } : {}),
      },
    ];
  });
}

function parseSourceIds(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const id = isRecord(item) ? stringValue(item.id) : undefined;
        return id === undefined ? [] : [id];
      })
    : [];
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

function deepEquityBundleStatusGap(status: "absent" | "malformed"): SourceGap {
  return {
    source: "deep-equity-evidence-bundle",
    provider: "run-artifact",
    capability: "extended-evidence",
    cause: status === "absent" ? "provider-data-missing" : "validation-failed",
    evidenceQualityImpact: "core-cap",
    message:
      status === "absent"
        ? "deep-equity evidence bundle is absent; provider-health coverage is unknown"
        : "deep-equity evidence bundle is malformed or invalid; provider-health coverage is unknown",
  };
}

function deepEquitySourceGaps(
  bundle: LoadedDeepEquityEvidenceBundle | undefined,
): readonly SourceGap[] {
  if (bundle?.status === "ok") {
    const { sourceGaps } = bundle.value.governance;
    return sourceGaps;
  }
  return [deepEquityBundleStatusGap(bundle?.status ?? "absent")];
}

async function loadRunHealth(runDir: string): Promise<RunHealth> {
  const failed = await access(join(runDir, FAILURE_FILE)).then(
    () => true,
    () => false,
  );
  const reportRaw = await readJson(join(runDir, failed ? FAILURE_FILE : REPORT_FILE));
  const report = isRecord(reportRaw) ? reportRaw : {};
  const analyticsFile = failed ? undefined : await readAnalytics(runDir);
  const analytics =
    analyticsFile?.status === "ok" && isRecord(analyticsFile.value)
      ? analyticsFile.value
      : undefined;
  const score = parseScoreCounts(await readJson(join(runDir, SCORE_FILE)));
  const reportSourceIds = parseSourceIds(report.sources);
  const deepEquity = !failed && isDeepEquityReport(report);
  const deepEquityBundle = deepEquity
    ? await loadDeepEquityEvidenceBundle(runDir, reportSourceIds)
    : undefined;
  const sourceGaps = deepEquity
    ? deepEquitySourceGaps(deepEquityBundle)
    : parseSourceGaps(await readJson(join(runDir, SOURCE_GAPS_FILE)));
  const generatedAt = stringValue(report.generatedAt);
  const symbol = stringValue(report.symbol);
  const depth = depthFrom(report, analytics);

  return {
    runId: stringValue(report.runId) ?? basename(runDir),
    failed,
    ...(generatedAt !== undefined ? { generatedAt } : {}),
    ...(isJobType(report.jobType) ? { jobType: report.jobType } : {}),
    ...(isAssetClass(report.assetClass) ? { assetClass: report.assetClass } : {}),
    ...(symbol !== undefined ? { symbol } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(numberValue(report.horizonTradingDays) > 0
      ? { horizonTradingDays: numberValue(report.horizonTradingDays) }
      : {}),
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
    degraded: 0,
    degradedCovered: 0,
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

// Provider Health builds its routes from Source Gaps, and a successful Firecrawl fallback closes
// Exa's gap by design, so a covered degradation reaches this page through `analytics.json` instead.
// Each endpoint contributes its own route key, which no `SourceGap.source` can collide with
// (Gap sources are provider ids such as `exa` or `web-gather`, never these camelCase endpoint
// Names), and each run contributes at most one increment per endpoint because the analytics row is
// One run-level status however many requests fell back. Gap-derived counters stay at zero here, so
// `gapOverview` and the gap classes are untouched.
const WEB_SEARCH_PROVIDER_SUBSYSTEM = "web-search-provider";
const WEB_SEARCH_ENDPOINT_PROVIDERS: Readonly<Record<string, string>> = {
  exaSearch: "exa",
  firecrawlSearch: "firecrawl",
};
const FIRECRAWL_SEARCH_ENDPOINT = "firecrawlSearch";

function endpointStatus(analytics: Record<string, unknown>, endpoint: string): string | undefined {
  const availability = analytics.providerEndpointAvailability;
  if (!isRecord(availability)) {
    return undefined;
  }
  const row = availability[endpoint];
  return isRecord(row) && typeof row.status === "string" ? row.status : undefined;
}

// A degradation is covered only when the fallback provider actually served this run. `degraded` on
// Its own says a fallback was entered, not that anything came back: Exa reads `degraded` the moment
// It is unusable, and Firecrawl reads `degraded` precisely when it served nothing. Only an
// `available` Firecrawl search row is evidence that the run still got its web search results.
function fallbackCoveredRun(analytics: Record<string, unknown>): boolean {
  return endpointStatus(analytics, FIRECRAWL_SEARCH_ENDPOINT) === "available";
}

function degradedEndpointReason(
  analytics: Record<string, unknown>,
  endpoint: string,
): string | undefined {
  if (endpointStatus(analytics, endpoint) !== "degraded") {
    return undefined;
  }
  const availability = analytics.providerEndpointAvailability;
  const row = isRecord(availability) ? availability[endpoint] : undefined;
  return isRecord(row) && typeof row.reason === "string" ? row.reason : "degraded";
}

// A Failed Run Artifact has no `analytics.json`, but the `web-search-provider` Subsystem Outcome is
// Written for failed and successful runs alike, and its detail carries the same per-request counts
// The analytics rows were derived from. Rebuilding the endpoint rows from that detail keeps a
// Degradation on a failed run visible here — the Source Gap is closed on the covered path and gone
// Altogether when `source-gaps.json` is absent or malformed, so nothing else would report it.
function endpointAvailabilityFromLedger(
  outcomes: readonly RunSubsystemOutcome[] | undefined,
  sourceGaps: readonly SourceGap[],
): Record<string, unknown> | undefined {
  const outcome = outcomes?.find((item) => item.subsystem === WEB_SEARCH_PROVIDER_SUBSYSTEM);
  const { detail } = outcome ?? {};
  if (detail === undefined) {
    return undefined;
  }
  const counts = {
    requestCount: readNumber(detail, "requestCount"),
    exaFallbackCount: readNumber(detail, "exaFallbackCount"),
    exaHardFailureCount: readNumber(detail, "exaHardFailureCount"),
    firecrawlAttemptCount: readNumber(detail, "firecrawlAttemptCount"),
    firecrawlServedCount: readNumber(detail, "firecrawlServedCount"),
  };
  if (Object.values(counts).some((count) => count === undefined)) {
    return undefined;
  }
  return {
    providerEndpointAvailability: deriveWebSearchEndpointAvailability([], sourceGaps, {
      requestCount: counts.requestCount ?? 0,
      exaFallbackCount: counts.exaFallbackCount ?? 0,
      exaHardFailureCount: counts.exaHardFailureCount ?? 0,
      firecrawlAttemptCount: counts.firecrawlAttemptCount ?? 0,
      firecrawlServedCount: counts.firecrawlServedCount ?? 0,
      firecrawlKeyMissing: detail.firecrawlKeyMissing === true,
    }),
  };
}

function webSearchDegradationRoutes(
  runs: readonly RunHealth[],
  outcomeLedgers: readonly RunSubsystemOutcomeLedger[],
): readonly ProviderRouteHealth[] {
  const routes = new Map<string, ProviderRouteHealth>();
  const outcomesByRunId = new Map(outcomeLedgers.map((ledger) => [ledger.runId, ledger.outcomes]));

  for (const run of runs) {
    // Analytics is authoritative when present; the ledger covers Failed Run Artifacts, which have
    // No analytics at all.
    const availability =
      run.analytics ??
      endpointAvailabilityFromLedger(outcomesByRunId.get(run.runId), run.sourceGaps);
    if (availability === undefined) {
      continue;
    }
    for (const [endpoint, provider] of Object.entries(WEB_SEARCH_ENDPOINT_PROVIDERS)) {
      const reason = degradedEndpointReason(availability, endpoint);
      if (reason === undefined) {
        continue;
      }
      const current = routes.get(endpoint) ?? emptyRoute(endpoint, provider);
      routes.set(endpoint, {
        ...current,
        total: current.total + 1,
        degraded: current.degraded + 1,
        degradedCovered: current.degradedCovered + (fallbackCoveredRun(availability) ? 1 : 0),
        runIds: current.runIds.includes(run.runId)
          ? current.runIds
          : [...current.runIds, run.runId],
        sampleMessages: current.sampleMessages.includes(reason)
          ? current.sampleMessages
          : [...current.sampleMessages, reason].slice(0, SAMPLE_MESSAGE_LIMIT),
      });
    }
  }

  return [...routes.values()];
}

function routeHealth(
  runs: readonly RunHealth[],
  outcomeLedgers: readonly RunSubsystemOutcomeLedger[],
): readonly ProviderRouteHealth[] {
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

  return [...routes.values(), ...webSearchDegradationRoutes(runs, outcomeLedgers)].toSorted(
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

async function hasCalibration(runsDir: string): Promise<boolean> {
  return (
    (await readJson(join(dataRootFromRunsDir(runsDir), "calibration", "summary.json"))) !==
    undefined
  );
}

function validationSummary(
  runs: readonly RunHealth[],
  calibrationPresent: boolean,
): ProviderHealthSummary["realRunValidation"] {
  return {
    marketUpdateRuns: runs.filter((run) => isMarketUpdateJobType(run.jobType)).length,
    instrumentRuns: runs.filter((run) => isInstrumentJobType(run.jobType)).length,
    deepInstrumentRuns: runs.filter(
      (run) => isInstrumentJobType(run.jobType) && run.depth === "deep",
    ).length,
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
    relevantRepeatKept: runs.reduce(
      (total, run) => total + numberAt(run.analytics, ["newsDedupe", "relevantRepeatKeptCount"]),
      0,
    ),
    scoredRuns: runs.filter((run) => run.scoreCount > 0).length,
    resolvedPredictions: runs.reduce((total, run) => total + run.resolvedScoreCount, 0),
    calibrationPresent,
  };
}

// `total` sums the four gap classes rather than `route.total`. Every Source Gap increments exactly
// One class, so this is identical to the old sum for gap-derived routes, and it keeps the
// Analytics-projected degradation routes — whose `total` counts affected runs, not gaps — out of the
// Gap headline.
function gapOverview(routes: readonly ProviderRouteHealth[]): ProviderHealthSummary["gapOverview"] {
  return routes.reduce(
    (total, route) => ({
      total:
        total.total + route.missingCredential + route.fetchFailed + route.yahooAuth + route.other,
      missingCredential: total.missingCredential + route.missingCredential,
      fetchFailed: total.fetchFailed + route.fetchFailed,
      yahooAuth: total.yahooAuth + route.yahooAuth,
      other: total.other + route.other,
    }),
    { total: 0, missingCredential: 0, fetchFailed: 0, yahooAuth: 0, other: 0 },
  );
}

function indexClassification(
  indexStatus: RunArtifactIndexStatus,
): ValidationIssueClassification | undefined {
  if (indexStatus.state === "unsupported-schema" || indexStatus.state === "unreadable") {
    return "blocking";
  }
  return undefined;
}

function validationWithIndexStatus(
  validation: ProviderValidationSummary,
  indexStatus: RunArtifactIndexStatus,
): ProviderValidationSummary {
  const classification = indexClassification(indexStatus);
  if (classification === undefined) {
    return validation;
  }

  const routeClassifications = [
    ...validation.routeClassifications,
    {
      route: "run-artifact-index",
      provider: "market-bot",
      classification,
      reason: indexStatus.message,
      runIds: [],
      sampleMessages: [indexStatus.rebuildCommand],
    },
  ].toSorted(
    (a, b) => a.classification.localeCompare(b.classification) || a.route.localeCompare(b.route),
  );
  const blockingIssueCount = routeClassifications.filter(
    (item) => item.classification === "blocking",
  ).length;
  const warningIssueCount = routeClassifications.filter(
    (item) => item.classification === "expected",
  ).length;
  const informationalIssueCount = routeClassifications.filter(
    (item) => item.classification === "informational",
  ).length;
  let status: ProviderValidationSummary["status"] = "pass";
  if (blockingIssueCount > 0) {
    status = "fail";
  } else if (warningIssueCount > 0) {
    status = "warn";
  }

  return {
    ...validation,
    status,
    blockingIssueCount,
    warningIssueCount,
    informationalIssueCount,
    routeClassifications,
  };
}

export async function buildProviderHealthSummary(
  runsDir: string,
  now: Date = new Date(),
): Promise<ProviderHealthSummary> {
  const runDirs = await listRunDirs(runsDir);
  // Snapshot the directory set once so run health and the outcome ledger cannot desync.
  const runDirNames = runDirs.map((runDir) => basename(runDir));
  const runs = await Promise.all(runDirs.map((runDir) => loadRunHealth(runDir)));
  const indexedOutcomeLedgers = await loadRunSubsystemOutcomesFromIndex(runsDir, runDirNames);
  const outcomeLedgers =
    indexedOutcomeLedgers ?? (await scanRunSubsystemOutcomesFromDisk(runsDir, runDirNames));
  const subsystemOutcomeRollup = rollupSubsystemOutcomes(
    outcomeLedgers.flatMap((ledger) => ledger.outcomes),
  );
  const successfulRuns = runs.filter((run) => !run.failed);
  const dates = generatedDates(runs);
  const routes = routeHealth(runs, outcomeLedgers);
  const calibrationPresent = await hasCalibration(runsDir);
  const runArtifactIndex = readRunArtifactIndexStatus(runsDir);
  const validation = validationWithIndexStatus(
    buildValidation(successfulRuns, routes, calibrationPresent, now),
    runArtifactIndex,
  );

  return {
    version: 3,
    generatedAt: now.toISOString(),
    runCount: runs.length,
    ...(dates[0] !== undefined ? { firstRunAt: dates[0] } : {}),
    ...(dates.at(-1) !== undefined ? { lastRunAt: dates.at(-1) as string } : {}),
    runsByJobType: countBy(runs, (run) => run.jobType),
    runsByAssetClass: countBy(runs, (run) => run.assetClass),
    realRunValidation: validationSummary(successfulRuns, calibrationPresent),
    subsystemOutcomes: {
      ...subsystemOutcomeRollup,
      failedRunCount: runs.filter((run) => run.failed).length,
      ledgerStatus: {
        ok: outcomeLedgers.filter((ledger) => ledger.status === "ok").length,
        absent: outcomeLedgers.filter((ledger) => ledger.status === "absent").length,
        malformed: outcomeLedgers.filter((ledger) => ledger.status === "malformed").length,
      },
    },
    gapOverview: gapOverview(routes),
    runArtifactIndex,
    validation,
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

function markdownTableCell(cell: string): string {
  return cell.replaceAll("\n", " ").replaceAll("|", String.raw`\|`);
}

function tableRow(cells: readonly string[]): string {
  return `| ${cells.map((cell) => markdownTableCell(cell)).join(" | ")} |`;
}

function renderProviderHealthMarkdown(summary: ProviderHealthSummary): string {
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
    tableRow(["Informational issues", String(summary.validation.informationalIssueCount)]),
    tableRow([
      "Run Artifact Index",
      `${summary.runArtifactIndex.state}: ${summary.runArtifactIndex.message}`,
    ]),
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
    tableRow(["Instrument runs", String(summary.realRunValidation.instrumentRuns)]),
    tableRow(["Deep instrument runs", String(summary.realRunValidation.deepInstrumentRuns)]),
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
    tableRow(["Relevant repeat kept", String(summary.realRunValidation.relevantRepeatKept)]),
    tableRow(["Scored runs", String(summary.realRunValidation.scoredRuns)]),
    tableRow(["Resolved predictions", String(summary.realRunValidation.resolvedPredictions)]),
    tableRow(["Calibration present", summary.realRunValidation.calibrationPresent ? "yes" : "no"]),
    "",
    "## Subsystem outcomes",
    "",
    "Failed Run Artifacts count `failure.json`. Outcome-ledger status counts `outcomes.json` for every run. Those are different questions.",
    "",
    tableRow(["Metric", "Value"]),
    tableRow(["---", "---"]),
    tableRow(["Failed Run Artifacts", String(summary.subsystemOutcomes.failedRunCount)]),
    tableRow(["Outcome ledger ok", String(summary.subsystemOutcomes.ledgerStatus.ok)]),
    tableRow(["Outcome ledger absent", String(summary.subsystemOutcomes.ledgerStatus.absent)]),
    tableRow([
      "Outcome ledger malformed",
      String(summary.subsystemOutcomes.ledgerStatus.malformed),
    ]),
    tableRow(["Recorded outcomes", String(summary.subsystemOutcomes.count)]),
    tableRow(["Expected empty", String(summary.subsystemOutcomes.expectedEmptyCount)]),
    ...Object.entries(summary.subsystemOutcomes.byOutcome).map(([outcome, count]) =>
      tableRow([`Outcome ${outcome}`, String(count)]),
    ),
    ...Object.entries(summary.subsystemOutcomes.byCode).map(([code, count]) =>
      tableRow([`Code ${code}`, String(count)]),
    ),
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
    tableRow(["Route", "Provider", "Total", "Degraded", "Status", "Cause", "Sample"]),
    tableRow(["---", "---", "---", "---", "---", "---", "---"]),
    ...summary.routes.map((route) =>
      tableRow([
        route.route,
        route.provider,
        String(route.total),
        String(route.degraded),
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
  runsDir: string,
  now: Date = new Date(),
): Promise<ProviderHealthWriteResult> {
  const summary = await buildProviderHealthSummary(runsDir, now);
  const outputDir = join(dataRootFromRunsDir(runsDir), "provider-health");
  const jsonPath = join(outputDir, "summary.json");
  const markdownPath = join(outputDir, "summary.md");

  await mkdir(outputDir, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(summary, undefined, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderProviderHealthMarkdown(summary), "utf8");

  return { jsonPath, markdownPath, summary };
}
