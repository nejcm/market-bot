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
import { readRunArtifactIndexStatus, type RunArtifactIndexStatus } from "../run-artifact-index";
import { isRecord, numberAt } from "../sources/guards";
import {
  buildValidation,
  type ProviderValidationSummary,
  type ValidationIssueClassification,
} from "./validation";

export type { ValidationCoverageItem, ValidationRouteClassification } from "./validation";

const SOURCE_GAPS_FILE = "source-gaps.json";
const REPORT_FILE = "report.json";
const ANALYTICS_FILE = "analytics.json";
const SCORE_FILE = "score.json";
const SAMPLE_MESSAGE_LIMIT = 3;

type IssueClass = "missingCredential" | "fetchFailed" | "yahooAuth" | "other";

export interface SourceHealth {
  readonly kind: Source["kind"];
  readonly assetClass?: AssetClass;
  readonly symbol?: string;
  readonly provider?: string;
  readonly identity?: InstrumentIdentity;
}

export interface RunHealth {
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
    value === "discussion" ||
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

async function hasCalibration(runsDir: string): Promise<boolean> {
  return (
    (await readJson(join(dataRootFromRunsDir(runsDir), "calibration", "summary.json"))) !==
    undefined
  );
}

function dataRootFromRunsDir(runsDir: string): string {
  return dirname(runsDir);
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
  const runs = await Promise.all(runDirs.map((runDir) => loadRunHealth(runDir)));
  const dates = generatedDates(runs);
  const routes = routeHealth(runs);
  const calibrationPresent = await hasCalibration(runsDir);
  const runArtifactIndex = readRunArtifactIndexStatus(runsDir);
  const validation = validationWithIndexStatus(
    buildValidation(runs, routes, calibrationPresent, now),
    runArtifactIndex,
  );

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
