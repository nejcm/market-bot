import type { InstrumentIdentity, SourceGapCause } from "../domain/types";
import { numberAt } from "../sources/guards";
import type { ProviderRouteHealth, RunHealth } from "./provider-health";

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

// Identity exchange/currency is the primary signal; suffixes cover common Yahoo-style fallbacks.
const INTERNATIONAL_SUFFIXES = new Set([
  "AS",
  "AX",
  "BR",
  "CO",
  "DE",
  "F",
  "HE",
  "HK",
  "IR",
  "IS",
  "JO",
  "KQ",
  "KS",
  "L",
  "MC",
  "MI",
  "MX",
  "NZ",
  "OL",
  "PA",
  "SA",
  "SI",
  "SS",
  "ST",
  "SW",
  "SZ",
  "T",
  "TA",
  "TO",
  "VI",
  "VX",
]);

export type ValidationStatus = "pass" | "warn" | "fail";
export type ValidationIssueClassification = "blocking" | "expected" | "informational";
export type CoverageKey =
  | "daily-equity"
  | "weekly-equity"
  | "daily-crypto"
  | "weekly-crypto"
  | "ticker-equity"
  | "ticker-crypto"
  | "deep-equity-ticker"
  | "international-equity-ticker";

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

export interface ProviderValidationSummary {
  readonly status: ValidationStatus;
  readonly requiredCoverage: readonly ValidationCoverageItem[];
  readonly blockingIssueCount: number;
  readonly warningIssueCount: number;
  readonly informationalIssueCount: number;
  readonly routeClassifications: readonly ValidationRouteClassification[];
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
