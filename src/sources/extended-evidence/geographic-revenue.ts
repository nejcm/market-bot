import type { ExtendedEvidenceItem } from "../../domain/evidence";
import { sourceGap } from "../../domain/source-gaps";
import type { SourceGap } from "../../domain/sources";
import {
  GEOGRAPHY_CONCEPTS,
  GEOGRAPHY_FACT_PREFIX,
  GEOGRAPHY_TOTAL_MEMBER,
  GEOGRAPHY_UNIT_KEY,
} from "../sec-segment-facts";
import {
  evaluateMetricSection,
  type MetricDefinition,
  type MetricInput,
  type MetricOutcome,
  type MetricSection,
} from "./metric-engine";
import { memberLabel, monthsBetween, periodicItems } from "./segment-results";

export const GEOGRAPHIC_REVENUE_SECTION_ID = "geographic-revenue";
const TITLE = "Revenue by geography";
const [REVENUES, CONTRACT_REVENUE] = GEOGRAPHY_CONCEPTS;
const LABELS: Readonly<Record<string, string>> = {
  "country:US": "United States",
  "us-gaap:NonUsMember": "Non-US",
};

interface RegionPeriod {
  readonly member: string;
  readonly concept: string;
  readonly start: string;
  readonly end: string;
}

const factKey = (member: string, concept: string, start: string, end: string) =>
  `${GEOGRAPHY_FACT_PREFIX}${member}|${concept}|${start}|${end}`;

// One concept per member and period: the first in preference order whose total is also tagged.
function regionPeriods(metrics: Record<string, number | string>): readonly RegionPeriod[] {
  const periods = new Map<string, RegionPeriod>();
  for (const key of Object.keys(metrics)) {
    const [, member, concept, start, end, suffix] = key.split("|");
    if (
      !key.startsWith(GEOGRAPHY_FACT_PREFIX) ||
      suffix !== undefined ||
      member === GEOGRAPHY_TOTAL_MEMBER ||
      !member ||
      !concept ||
      !start ||
      !end
    ) {
      continue;
    }
    const id = `${member}|${start}|${end}`;
    const rank = (row: RegionPeriod) =>
      (metrics[factKey(GEOGRAPHY_TOTAL_MEMBER, row.concept, start, end)] === undefined ? 2 : 0) +
      GEOGRAPHY_CONCEPTS.indexOf(row.concept as (typeof GEOGRAPHY_CONCEPTS)[number]);
    const candidate = { member, concept, start, end };
    const prior = periods.get(id);
    if (prior === undefined || rank(candidate) < rank(prior)) {
      periods.set(id, candidate);
    }
  }
  return [...periods.values()];
}

// The filing's latest period end, its longest span there (YTD or fiscal year), and the prior-year comparative.
function reportedPeriods(item: ExtendedEvidenceItem): readonly RegionPeriod[] {
  const periods = regionPeriods(item.metrics ?? {});
  const latestEnd = periods.reduce((max, { end }) => (end > max ? end : max), "");
  const months = Math.max(
    ...periods
      .filter(({ end }) => end === latestEnd)
      .map(({ start, end }) => monthsBetween(start, end)),
  );
  return periods.filter(
    ({ start, end }) =>
      monthsBetween(start, end) === months &&
      (end === latestEnd || monthsBetween(end, latestEnd) === 12),
  );
}

function regionDefinitions(
  item: ExtendedEvidenceItem,
  periods: readonly RegionPeriod[],
): MetricDefinition[] {
  const metrics = item.metrics ?? {};
  const unit = String(metrics[GEOGRAPHY_UNIT_KEY] ?? "unknown");
  const currency = /^iso4217:([A-Z]{3})$/u.exec(unit)?.[1];
  const filing = `${String(metrics.form)} filed ${String(metrics.filingDate)}, accession ${String(metrics.accessionNumber)}`;
  return periods.flatMap((period): MetricDefinition[] => {
    const label = LABELS[period.member] ?? memberLabel(period.member);
    const months = monthsBetween(period.start, period.end);
    const input = (member: string, name: string): MetricInput | undefined => {
      const key = factKey(member, period.concept, period.start, period.end);
      const value = metrics[key];
      return typeof value !== "number"
        ? undefined
        : {
            label: name,
            value,
            artifact: "evidence",
            category: "sec-edgar",
            key,
            periodType: months >= 12 ? "annual" : "interim",
            periodStart: period.start,
            periodEnd: period.end,
            unit,
            ...(currency === undefined ? {} : { currency }),
            sourceIds: item.sourceIds,
            derivation: `${period.concept} ${member === GEOGRAPHY_TOTAL_MEMBER ? "without dimensions" : `for geographic member ${member}`}`,
          };
    };
    const region = input(period.member, `${label} revenue`);
    const total = input(GEOGRAPHY_TOTAL_MEMBER, "Total revenue");
    const inputs = [region, total].filter((row) => row !== undefined);
    const missing = (reason: string): MetricOutcome => ({
      status: "missing",
      reason,
      periodEnd: period.end,
      inputs,
    });
    const unitGate =
      currency === undefined
        ? missing(`geographic revenue facts are not in one currency (${unit})`)
        : undefined;
    const contractSubtotal =
      period.concept === CONTRACT_REVENUE &&
      metrics[factKey(GEOGRAPHY_TOTAL_MEMBER, REVENUES, period.start, period.end)] !== undefined;
    const base = contractSubtotal ? "revenue from contracts with customers" : "revenue";
    const id = `${period.member.replace(":", "_")}-${period.start}-${period.end}`;
    return [
      {
        id: `${id}-revenue`,
        label: `${label} ${base}`,
        unit: "currency",
        basis: `issuer-tagged revenue by geography; ${filing}`,
        compute: () =>
          unitGate ??
          (region === undefined
            ? missing("no revenue fact tagged for this region and period")
            : {
                status: "value",
                value: region.value,
                currency: currency!,
                periodEnd: period.end,
                periodMonths: months,
                inputs: [region],
              }),
      },
      {
        id: `${id}-share`,
        label: `${label} share of ${base}`,
        unit: "ratio-percent",
        basis: `region ${base} / total ${base}, same concept, period and filing; ${filing}`,
        compute: () => {
          if (unitGate !== undefined) {
            return unitGate;
          }
          if (region === undefined || total === undefined) {
            return missing("total revenue is not tagged with the region's concept for this period");
          }
          if (Number(total.value) <= 0) {
            return {
              status: "not-meaningful",
              reason: "total revenue is zero or negative",
              periodEnd: period.end,
              inputs,
            };
          }
          return {
            status: "value",
            value: Number(region.value) / Number(total.value),
            periodEnd: period.end,
            periodMonths: months,
            inputs,
          };
        },
      },
    ];
  });
}

function missingFactsGap(symbol: string, item: ExtendedEvidenceItem): SourceGap {
  const form = String(item.metrics?.form);
  const filing = `the SEC ${form} for ${symbol} (filed ${String(item.metrics?.filingDate)})`;
  return sourceGap({
    source: GEOGRAPHIC_REVENUE_SECTION_ID,
    message:
      form === "10-K" || form === "10-Q"
        ? `No revenue facts by geography were read from ${filing}; geographic revenue shares are not computed`
        : `Geographic revenue facts are read only from 10-K/10-Q inline XBRL, so ${filing} yields no geographic revenue shares`,
    symbol,
    provider: "sec-edgar",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
  });
}

// Undefined when no periodic filing was collected. Rows come from the newest filing with geography facts,
// Plus the newest older 10-K's fiscal years when that filing is a 10-Q; filings without facts are gaps.
export function geographicRevenueSection(
  symbol: string,
  filingItems: readonly ExtendedEvidenceItem[],
): { readonly section?: MetricSection; readonly sourceGaps: readonly SourceGap[] } | undefined {
  const items = periodicItems(filingItems);
  if (items.length === 0) {
    return undefined;
  }
  const upper = symbol.toUpperCase();
  const latest = items.findIndex((item) => regionPeriods(item.metrics ?? {}).length > 0);
  if (latest === -1) {
    return { sourceGaps: items.map((item) => missingFactsGap(upper, item)) };
  }
  const item = items[latest]!;
  const annual =
    item.metrics?.form === "10-Q"
      ? items.slice(latest + 1).find((older) => older.metrics?.form === "10-K")
      : undefined;
  const annualHasFacts = annual !== undefined && regionPeriods(annual.metrics ?? {}).length > 0;
  const gaps = [
    ...items.slice(0, latest),
    ...(annual !== undefined && !annualHasFacts ? [annual] : []),
  ].map((gapItem) => missingFactsGap(upper, gapItem));
  const result = evaluateMetricSection(
    GEOGRAPHIC_REVENUE_SECTION_ID,
    TITLE,
    [
      ...regionDefinitions(item, reportedPeriods(item)),
      ...(annualHasFacts ? regionDefinitions(annual, reportedPeriods(annual)) : []),
    ],
    { symbol },
  );
  return { section: result.section, sourceGaps: [...gaps, ...result.sourceGaps] };
}
