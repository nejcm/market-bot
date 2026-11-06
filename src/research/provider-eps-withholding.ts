import type { MarketFundamentals, MarketSnapshot } from "../domain/market-data";
import {
  businessFrameworkSummary,
  sectionSummary,
} from "../sources/extended-evidence/business-framework";
import { businessFrameworkMetricSectionId } from "../sources/extended-evidence/business-framework-metrics";
import { financialLensSummary } from "../sources/extended-evidence/financial-lens";
import type { MetricResult, MetricSection } from "../sources/extended-evidence/metric-engine";
import {
  perShareCurrency,
  yahooFundamentalsSummary,
} from "../sources/extended-evidence/yahoo-fundamentals";
import type { CollectedSources } from "../sources/types";

const YAHOO_EPS_KEYS: ReadonlySet<string> = new Set(["trailingPE", "epsTrailingTwelveMonths"]);
const YAHOO_WITHHELD = "Trailing EPS and trailing PE withheld; see the issuer-report Source Gap.";
const LENS_EPS_KEYS: ReadonlySet<string> = new Set([
  "peRatio",
  "epsTrailingTwelveMonths",
  "payoutRatio",
]);

function withoutKeys<T extends object>(record: T, keys: ReadonlySet<string>): T {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.has(key))) as T;
}

// Yahoo trailing EPS and everything priced off it, once code has seen it contradict the issuer's report.
export function withholdProviderEps(
  collectedSources: CollectedSources,
  symbol: string,
  reason: string,
): CollectedSources {
  const isSubject = (value: string) => value.toUpperCase() === symbol.toUpperCase();
  const stripped = (snapshot: MarketSnapshot): MarketSnapshot => {
    if (!isSubject(snapshot.symbol) || snapshot.fundamentals === undefined) {
      return snapshot;
    }
    const { fundamentals: provided, ...rest } = snapshot;
    const kept = withoutKeys(provided, YAHOO_EPS_KEYS);
    return Object.keys(kept).length === 0 ? rest : { ...rest, fundamentals: kept };
  };
  const marketSnapshots = collectedSources.marketSnapshots.map(stripped);
  const fundamentals: MarketFundamentals | undefined = marketSnapshots.find(({ symbol: row }) =>
    isSubject(row),
  )?.fundamentals;
  const evidence = collectedSources.extendedEvidence;
  const yahooSourceIds = new Set(
    evidence?.items.find(({ category }) => category === "yahoo-fundamentals")?.sourceIds,
  );
  const lenses = collectedSources.financialLenses?.lenses.map((lens) => ({
    ...lens,
    metrics: lens.metrics.filter(
      ({ key, sourceIds }) =>
        !LENS_EPS_KEYS.has(key) || !sourceIds.every((sourceId) => yahooSourceIds.has(sourceId)),
    ),
  }));
  const keptLensKeys = new Set(lenses?.flatMap((lens) => lens.metrics.map(({ key }) => key)));
  const withheldLensKeys = new Set([...LENS_EPS_KEYS].filter((key) => !keptLensKeys.has(key)));
  const withheld = (metric: MetricResult) =>
    metric.inputs.some(
      ({ category, key = "" }) =>
        (category === "yahoo-fundamentals" && YAHOO_EPS_KEYS.has(key)) ||
        (category === "financial-lens" && withheldLensKeys.has(key)),
    );
  const metricSections = collectedSources.metricSections?.map(
    (section): MetricSection => ({
      ...section,
      metrics: section.metrics.map((metric): MetricResult => {
        if (!withheld(metric)) {
          return metric;
        }
        const { value: _value, ...rest } = metric;
        return { ...rest, status: "not-meaningful", reason, inputs: [] };
      }),
    }),
  );
  const { businessFramework } = collectedSources;
  const frameworkSections = businessFramework?.sections.map((section) => ({
    ...section,
    summary: sectionSummary(
      section.name,
      section.posture,
      metricSections?.find(({ id }) => id === businessFrameworkMetricSectionId(section.name)),
    ),
  }));
  const lensMetricKeys = new Set([...withheldLensKeys].flatMap((key) => [key, `${key}PeriodEnd`]));
  return {
    ...collectedSources,
    marketSnapshots,
    supplementalMarketSnapshots: collectedSources.supplementalMarketSnapshots.map(stripped),
    ...(evidence === undefined
      ? {}
      : {
          extendedEvidence: {
            ...evidence,
            items: evidence.items.map((item) => {
              if (item.category === "yahoo-fundamentals") {
                return {
                  ...item,
                  summary: `${yahooFundamentalsSummary(fundamentals ?? {}, perShareCurrency(item.identity))} ${YAHOO_WITHHELD}`,
                  ...(item.metrics === undefined
                    ? {}
                    : { metrics: withoutKeys(item.metrics, YAHOO_EPS_KEYS) }),
                };
              }
              if (item.category === "financial-lens" && lenses !== undefined) {
                return {
                  ...item,
                  summary: financialLensSummary(lenses),
                  ...(item.metrics === undefined
                    ? {}
                    : { metrics: withoutKeys(item.metrics, lensMetricKeys) }),
                };
              }
              return item.category === "business-framework" && frameworkSections !== undefined
                ? { ...item, summary: businessFrameworkSummary(frameworkSections) }
                : item;
            }),
          },
        }),
    ...(metricSections === undefined ? {} : { metricSections }),
    ...(collectedSources.financialLenses === undefined || lenses === undefined
      ? {}
      : { financialLenses: { ...collectedSources.financialLenses, lenses } }),
    ...(businessFramework === undefined || frameworkSections === undefined
      ? {}
      : { businessFramework: { ...businessFramework, sections: frameworkSections } }),
  };
}
