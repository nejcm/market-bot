import {
  isInstrumentJobType,
  marketUpdateHorizonBucketOf,
  type SourceGapCause,
} from "../domain/types";
import { numberAt } from "../guards";
import { hasNonUsSuffix, isInternationalIdentity } from "../sources/instrument-capability";
import type { ProviderRouteHealth, RunHealth } from "./provider-health";

type ValidationStatus = "pass" | "warn" | "fail";
export type ValidationIssueClassification = "blocking" | "expected" | "informational";
type CoverageKey =
  | "market-overview-equity-short"
  | "market-overview-equity-medium"
  | "market-overview-crypto-short"
  | "market-overview-crypto-medium"
  | "ticker-equity"
  | "ticker-crypto"
  | "deep-equity-ticker"
  | "international-equity-ticker";

interface ValidationCoverageItem {
  readonly key: CoverageKey;
  readonly label: string;
  readonly met: boolean;
  readonly runIds: readonly string[];
}

interface ValidationRouteClassification {
  readonly route: string;
  readonly provider: string;
  readonly classification: ValidationIssueClassification;
  readonly reason: string;
  readonly runIds: readonly string[];
  readonly sampleMessages: readonly string[];
}

export interface ProviderValidationSummary {
  readonly status: ValidationStatus;
  readonly requiredCoverage: readonly ValidationCoverageItem[];
  readonly blockingIssueCount: number;
  readonly warningIssueCount: number;
  readonly informationalIssueCount: number;
  readonly routeClassifications: readonly ValidationRouteClassification[];
}

function isInternationalEquityTicker(run: RunHealth): boolean {
  if (!isInstrumentJobType(run.jobType) || run.assetClass !== "equity") {
    return false;
  }
  if (run.symbol !== undefined && hasNonUsSuffix(run.symbol)) {
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

function runHorizonBucket(run: RunHealth): string | undefined {
  if (run.jobType === undefined) {
    return undefined;
  }
  // Market-overview health rows may predate the explicit horizon column, so fall
  // Back to the first prediction horizon before the canonical derivation.
  const horizonTradingDays = run.horizonTradingDays ?? run.predictionHorizons[0];
  return marketUpdateHorizonBucketOf({ jobType: run.jobType, horizonTradingDays });
}

function requiredCoverage(runs: readonly RunHealth[]): readonly ValidationCoverageItem[] {
  return [
    coverageItem(
      "market-overview-equity-short",
      "Market overview equity short horizon",
      runs,
      (run) => run.assetClass === "equity" && runHorizonBucket(run) === "2-5d",
    ),
    coverageItem(
      "market-overview-equity-medium",
      "Market overview equity medium horizon",
      runs,
      (run) => run.assetClass === "equity" && runHorizonBucket(run) === "11-15d",
    ),
    coverageItem(
      "market-overview-crypto-short",
      "Market overview crypto short horizon",
      runs,
      (run) => run.assetClass === "crypto" && runHorizonBucket(run) === "2-5d",
    ),
    coverageItem(
      "market-overview-crypto-medium",
      "Market overview crypto medium horizon",
      runs,
      (run) => run.assetClass === "crypto" && runHorizonBucket(run) === "11-15d",
    ),
    coverageItem(
      "ticker-equity",
      "Ticker equity",
      runs,
      (run) => isInstrumentJobType(run.jobType) && run.assetClass === "equity",
    ),
    coverageItem(
      "ticker-crypto",
      "Ticker crypto",
      runs,
      (run) => isInstrumentJobType(run.jobType) && run.assetClass === "crypto",
    ),
    coverageItem(
      "deep-equity-ticker",
      "Deep equity ticker",
      runs,
      (run) =>
        isInstrumentJobType(run.jobType) && run.assetClass === "equity" && run.depth === "deep",
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

/*
 * True when EVERY gap the route aggregated carried `cause`.
 *
 * Reconciled against `total`, not read off `causes`. `causes` counts only gaps that declared one
 * (provider-health.ts increments it under `gap.cause !== undefined`), while `total` counts them
 * all — so a cause-less gap lands in `total` and in one of the class counters and leaves no trace
 * in `causes`. Inspecting `causes` alone therefore called a route "sole cause" while a genuine
 * cause-less HTTP failure sat beside the routine one, downgrading a broken route to informational.
 *
 * Sole-cause is the whole point: a routine outcome stops being routine the moment it appears
 * alongside a real defect, and a mixed route must keep its blocking classification.
 */
function routeSoleCause(route: ProviderRouteHealth, cause: SourceGapCause): boolean {
  return route.total > 0 && (route.causes[cause] ?? 0) === route.total;
}

function routeRunIds(
  route: ProviderRouteHealth,
  runsById: ReadonlyMap<string, RunHealth>,
): readonly string[] {
  return route.runIds.filter((runId) => runsById.has(runId));
}

function gapClassTotal(route: ProviderRouteHealth): number {
  return route.missingCredential + route.fetchFailed + route.yahooAuth + route.other;
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
  /*
   * The fetchFailed counter records cause-less HTTP failures too, which routeHasCause cannot see.
   * CoinGecko below has always checked its counter; Yahoo did not, so a cause-less transport
   * failure on the primary equity source reached the generic fallback instead of this rule.
   */
  if (
    provider === "yahoo" &&
    (route.yahooAuth > 0 || route.fetchFailed > 0 || routeHasCause(route, "fetch-failed"))
  ) {
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
  /*
   * Trimming an in-progress bar is the market-data collector succeeding, not a provider failing:
   * the partial session is dropped and the prior completed session is published. Left unclassified
   * this routine outcome fell through to "Unclassified provider gap requires review" and registered
   * as a blocking provider defect on every intraday run.
   */
  if (routeSoleCause(route, "session-in-progress")) {
    return {
      ...base,
      classification: "informational",
      reason:
        "An in-progress session bar was trimmed before indicators; the snapshot is anchored on the last completed session.",
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
  // Routes aggregate across runs, so any profile failure wins over reuse and stays blocking.
  if (
    routeName === "news-seen" ||
    routeHasCause(route, "repeat-fallback") ||
    (routeName === "web-subject-profile" &&
      !routeHasCause(route, "validation-failed") &&
      !routeHasCause(route, "provider-data-missing"))
  ) {
    return {
      ...base,
      classification: "informational",
      reason: "Intended fallback is disclosed but nonblocking.",
    };
  }
  if (route.missingCredential > 0) {
    return {
      ...base,
      classification: "expected",
      reason: "Missing optional provider credentials are disclosed as coverage gaps.",
    };
  }
  /*
   * Web-search degradation routes come from `analytics.json`, not Source Gaps, so they carry no gap
   * class and would otherwise fall through to "unclassified". Warn requires verified coverage on
   * every affected run — `degradedCovered === degraded` — because `degraded` alone only says a
   * fallback was entered. A degraded `firecrawlSearch` route means the mitigation itself returned
   * nothing usable, so it can never reach the warn branch. Anything short of full coverage stays
   * blocking: an uncovered web-search failure must not read as a healthy fallback, and the run's
   * own Source Gap routes cannot be relied on to catch it (a missing or malformed source-gaps.json
   * yields no gaps at all).
   */
  if (route.degraded > 0 && gapClassTotal(route) === 0) {
    if (route.degradedCovered === route.degraded) {
      return {
        ...base,
        classification: "expected",
        reason: "The primary web-search provider degraded and a fallback provider served the run.",
      };
    }
    return {
      ...base,
      classification: "blocking",
      reason: `A web-search provider degraded with no fallback coverage on ${String(route.degraded - route.degradedCovered)} of ${String(route.degraded)} affected run(s).`,
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

export function buildValidation(
  runs: readonly RunHealth[],
  routes: readonly ProviderRouteHealth[],
  calibrationPresent: boolean,
  now: Date,
): ProviderValidationSummary {
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
    (classification) => classification.classification === "expected",
  ).length;
  const informationalIssueCount = classifications.filter(
    (classification) => classification.classification === "informational",
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
    informationalIssueCount,
    routeClassifications: classifications.toSorted(
      (a, b) => a.classification.localeCompare(b.classification) || a.route.localeCompare(b.route),
    ),
  };
}
