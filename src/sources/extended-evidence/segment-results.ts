import type { ExtendedEvidenceItem } from "../../domain/evidence";
import { sourceGap } from "../../domain/source-gaps";
import type { SourceGap } from "../../domain/sources";
import { SEGMENT_FACT_PREFIX, SEGMENT_UNIT_KEY, type SegmentMeasure } from "../sec-segment-facts";
import {
  evaluateMetricSection,
  type MetricDefinition,
  type MetricInput,
  type MetricOutcome,
  type MetricSection,
} from "./metric-engine";

export const SEGMENT_RESULTS_SECTION_ID = "segment-results";
const TITLE = "Segment results per ASC 280";
// Segment facts are parsed from 10-K/10-Q only; a newer 20-F/40-F declares the gap.
const PERIODIC_FORMS = new Set(["10-K", "10-Q", "20-F", "40-F"]);

interface SegmentPeriod {
  readonly member: string;
  readonly start: string;
  readonly end: string;
}

function periodicItems(items: readonly ExtendedEvidenceItem[]): readonly ExtendedEvidenceItem[] {
  return items
    .filter(
      (item) =>
        item.category === "sec-edgar" && PERIODIC_FORMS.has(String(item.metrics?.form ?? "")),
    )
    .toSorted(
      (a, b) =>
        String(b.metrics?.reportDate ?? "").localeCompare(String(a.metrics?.reportDate ?? "")) ||
        String(b.metrics?.filingDate ?? "").localeCompare(String(a.metrics?.filingDate ?? "")),
    );
}

function segmentPeriods(metrics: Record<string, number | string>): readonly SegmentPeriod[] {
  const periods = new Map<string, SegmentPeriod>();
  for (const key of Object.keys(metrics)) {
    const [, member, , start, end] = key.split("|");
    if (key.startsWith(SEGMENT_FACT_PREFIX) && member && start && end) {
      periods.set(`${member}|${start}|${end}`, { member, start, end });
    }
  }
  return [...periods.values()];
}

// `amd:DataCenterMember` -> `Data Center`.
function memberLabel(member: string): string {
  return (member.split(":").at(-1) ?? member)
    .replace(/(Segment)?Member$/u, "")
    .replaceAll(/(?<=[a-z0-9])(?=[A-Z])/gu, " ")
    .replaceAll(" And ", " and ");
}

function monthsBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / (30.44 * 86_400_000));
}

function segmentMargin(
  metrics: Record<string, number | string>,
  period: SegmentPeriod,
): number | "not-meaningful" | undefined {
  const key = (measure: SegmentMeasure) =>
    `${SEGMENT_FACT_PREFIX}${period.member}|${measure}|${period.start}|${period.end}`;
  const revenue = metrics[key("revenue")];
  const operatingIncome = metrics[key("operatingIncome")];
  if (typeof revenue !== "number" || typeof operatingIncome !== "number") {
    return undefined;
  }
  return revenue > 0 ? operatingIncome / revenue : "not-meaningful";
}

function periodKey(period: SegmentPeriod): string {
  return `${period.member}|${period.start}|${period.end}`;
}

function segmentDefinitions(item: ExtendedEvidenceItem, periods: readonly SegmentPeriod[]) {
  const metrics = item.metrics ?? {};
  const unit = String(metrics[SEGMENT_UNIT_KEY] ?? "unknown");
  const currency = /^iso4217:([A-Z]{3})$/u.exec(unit)?.[1];
  const filing = `${String(metrics.form)} filed ${String(metrics.filingDate)}, accession ${String(metrics.accessionNumber)}`;
  const basis = `issuer-reported segment measure per ASC 280, not GAAP consolidated; ${filing}`;
  return periods.flatMap((period): MetricDefinition[] => {
    const label = memberLabel(period.member);
    const months = monthsBetween(period.start, period.end);
    const input = (measure: SegmentMeasure): MetricInput | undefined => {
      const key = `${SEGMENT_FACT_PREFIX}${period.member}|${measure}|${period.start}|${period.end}`;
      const value = metrics[key];
      return typeof value !== "number"
        ? undefined
        : {
            label: `${label} segment ${measure === "revenue" ? "revenue" : "operating income"}`,
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
            derivation: `${measure === "revenue" ? "revenue" : "operating income"} tagged as ${String(metrics[`${key}|concept`] ?? "unknown concept")} for member ${period.member}`,
          };
    };
    const revenue = input("revenue");
    const operatingIncome = input("operatingIncome");
    const inputs = [revenue, operatingIncome].filter((row) => row !== undefined);
    const missing = (reason: string): MetricOutcome => ({
      status: "missing",
      reason,
      periodEnd: period.end,
      inputs,
    });
    const unitGate =
      currency === undefined
        ? missing(`segment facts are not in one currency (${unit})`)
        : undefined;
    const amount = (row: MetricInput | undefined, name: string): MetricOutcome =>
      unitGate ??
      (row === undefined
        ? missing(`no ${name} fact tagged for this segment and period`)
        : {
            status: "value",
            value: row.value,
            currency: currency!,
            periodEnd: period.end,
            periodMonths: months,
            inputs: [row],
          });
    const id = `${period.member.replace(":", "_")}-${period.start}-${period.end}`;
    // Only the filing's current-period pairs; older pairs repeat what earlier filings showed.
    const prior =
      period.end !== String(metrics.reportDate)
        ? undefined
        : periods.find(
            (other) =>
              other.member === period.member &&
              monthsBetween(other.start, other.end) === months &&
              monthsBetween(other.end, period.end) === 12,
          );
    const priorYear: MetricDefinition[] =
      prior === undefined
        ? []
        : [
            {
              id: `${id}-margin-yoy-change`,
              label: `${label} segment operating margin YoY change, percentage points`,
              unit: "number",
              basis: `segment operating margin ${period.start} to ${period.end} minus ${prior.start} to ${prior.end}, both from ${filing}`,
              compute: () => {
                const current = segmentMargin(metrics, period);
                const earlier = segmentMargin(metrics, prior);
                if (unitGate !== undefined) {
                  return unitGate;
                }
                if (current === undefined || earlier === undefined) {
                  return missing(
                    "segment revenue or operating income is not tagged for this period or its prior-year comparative",
                  );
                }
                return current === "not-meaningful" || earlier === "not-meaningful"
                  ? {
                      status: "not-meaningful",
                      reason:
                        "segment revenue is zero or negative in this period or its prior-year comparative",
                      periodEnd: period.end,
                      inputs,
                    }
                  : {
                      status: "value",
                      value: (current - earlier) * 100,
                      periodEnd: period.end,
                      periodMonths: months,
                      inputs,
                    };
              },
            },
          ];
    return [
      {
        id: `${id}-revenue`,
        label: `${label} segment revenue`,
        unit: "currency",
        basis,
        compute: () => amount(revenue, "segment revenue"),
      },
      {
        id: `${id}-operating-income`,
        label: `${label} segment operating income`,
        unit: "currency",
        basis,
        compute: () => amount(operatingIncome, "segment operating income"),
      },
      {
        id: `${id}-margin`,
        label: `${label} segment operating margin`,
        unit: "ratio-percent",
        basis: `segment operating income / segment revenue, same period and filing; ${basis}`,
        compute: () => {
          if (unitGate !== undefined) {
            return unitGate;
          }
          if (revenue === undefined || operatingIncome === undefined) {
            return missing("segment revenue or operating income is not tagged for this period");
          }
          if (Number(revenue.value) <= 0) {
            return {
              status: "not-meaningful",
              reason: "segment revenue is zero or negative",
              periodEnd: period.end,
              inputs,
            };
          }
          return {
            status: "value",
            value: Number(operatingIncome.value) / Number(revenue.value),
            periodEnd: period.end,
            periodMonths: months,
            inputs,
          };
        },
      },
      ...priorYear,
    ];
  });
}

function missingFactsGap(symbol: string, item: ExtendedEvidenceItem): SourceGap {
  const form = String(item.metrics?.form);
  const filing = `the SEC ${form} for ${symbol} (filed ${String(item.metrics?.filingDate)})`;
  return sourceGap({
    source: SEGMENT_RESULTS_SECTION_ID,
    message:
      form === "10-K" || form === "10-Q"
        ? `No ASC 280 segment revenue or operating income facts were read from ${filing}; segment margins are not computed`
        : `Segment facts are read only from 10-K/10-Q inline XBRL, so ${filing} yields no segment revenue, operating income or margins`,
    symbol,
    provider: "sec-edgar",
    capability: "extended-evidence",
    cause: "provider-data-missing",
    evidenceQualityImpact: "no-cap",
  });
}

// Distinct QNames are distinct members; a same-label pair is disclosed unless a shared period disagrees.
function renamedMemberGaps(symbol: string, items: readonly ExtendedEvidenceItem[]): SourceGap[] {
  const byLabel = new Map<string, Map<string, { filing: string; facts: Map<string, number> }>>();
  for (const item of items) {
    const metrics = item.metrics ?? {};
    for (const [key, value] of Object.entries(metrics)) {
      const [, member, measure, start, end] = key.split("|");
      const label = memberLabel(member ?? "")
        .toLowerCase()
        .replaceAll(/[^\p{L}\p{N}]/gu, "");
      if (!key.startsWith(SEGMENT_FACT_PREFIX) || typeof value !== "number" || !end || !label) {
        continue;
      }
      const members = byLabel.get(label) ?? new Map();
      const entry = members.get(member!) ?? {
        filing: `${String(metrics.form)} filed ${String(metrics.filingDate)}`,
        facts: new Map<string, number>(),
      };
      if (!entry.facts.has(`${measure}|${start}|${end}`)) {
        entry.facts.set(`${measure}|${start}|${end}`, value);
      }
      members.set(member!, entry);
      byLabel.set(label, members);
    }
  }
  return [...byLabel.values()]
    .flatMap((members) => {
      const entries = [...members];
      return entries.flatMap((one, index) =>
        entries
          .slice(index + 1)
          .filter(([, other]) =>
            [...one[1].facts].every(
              ([period, value]) => (other.facts.get(period) ?? value) === value,
            ),
          )
          .map((other) => [one, other]),
      );
    })
    .map((pair) =>
      sourceGap({
        source: SEGMENT_RESULTS_SECTION_ID,
        message: `Segment members ${pair.map(([member, { filing }]) => `${member} (${filing})`).join(" and ")} share a label; segment continuity across these QNames is unverified, so rows remain separate`,
        symbol,
        provider: "sec-edgar",
        capability: "extended-evidence",
        cause: "suppressed-by-design",
        evidenceQualityImpact: "no-cap",
        triage: "diagnostic",
      }),
    );
}

// Undefined when no periodic filing was collected; each filing without segment facts is a declared gap.
export function segmentResultsSection(
  symbol: string,
  filingItems: readonly ExtendedEvidenceItem[],
): { readonly section?: MetricSection; readonly sourceGaps: readonly SourceGap[] } | undefined {
  const items = periodicItems(filingItems);
  if (items.length === 0) {
    return undefined;
  }
  const upper = symbol.toUpperCase();
  const withFacts = items.filter((item) => segmentPeriods(item.metrics ?? {}).length > 0);
  const gaps = items
    .filter((item) => !withFacts.includes(item))
    .map((item) => missingFactsGap(upper, item));
  if (withFacts.length === 0) {
    return { sourceGaps: gaps };
  }
  const winners = new Map<string, ExtendedEvidenceItem>();
  // Newest filing first, so a period restated as a later filing's comparative keeps the latest filing's rows.
  for (const item of withFacts) {
    for (const period of segmentPeriods(item.metrics ?? {})) {
      if (!winners.has(periodKey(period))) {
        winners.set(periodKey(period), item);
      }
    }
  }
  const definitions = withFacts.flatMap((item) =>
    segmentDefinitions(
      item,
      segmentPeriods(item.metrics ?? {}).filter(
        (period) => winners.get(periodKey(period)) === item,
      ),
    ),
  );
  const result = evaluateMetricSection(SEGMENT_RESULTS_SECTION_ID, TITLE, definitions, { symbol });
  return {
    section: result.section,
    sourceGaps: [...gaps, ...renamedMemberGaps(upper, withFacts), ...result.sourceGaps],
  };
}
