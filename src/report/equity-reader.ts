import { isRecord } from "../guards";
import type {
  FundamentalHistoryArtifact,
  FundamentalHistoryPoint,
  FundamentalHistorySeries,
} from "../sources/extended-evidence/fundamental-history";

export interface TrendPeriod {
  readonly kind: "annual" | "ttm";
  readonly periodEnd: string;
  readonly filedAt: string;
}

export interface LabeledPeriod {
  readonly kind: "annual" | "interim" | "ttm";
  readonly periodEnd: string;
  readonly filedAt: string;
}

export interface FinancialTrendRow {
  readonly period: string;
  readonly revenue: string;
  readonly netIncome: string;
  readonly operatingMargin: string;
  readonly freeCashFlow: string;
}

export interface CompanyDescription {
  readonly text: string;
  readonly sourceIds: readonly string[];
}

interface CompanyDescriptionReport {
  readonly extras?: unknown;
  readonly sources?: unknown;
}

export const NO_COMPANY_DESCRIPTION = "No cited plain-language company description is available.";
const TREND_SERIES_KEYS = ["revenue", "netIncome", "operatingMargin", "freeCashFlowProxy"] as const;

export function periodLabel(period: LabeledPeriod): string {
  if (period.kind === "ttm") {
    return `TTM (${period.periodEnd}; filed ${period.filedAt})`;
  }
  return `${period.kind === "annual" ? "FY" : "Interim"} ending ${period.periodEnd} (filed ${period.filedAt})`;
}

export function trendPeriods(history: FundamentalHistoryArtifact): readonly TrendPeriod[] {
  const annual = new Map<string, TrendPeriod>();
  for (const key of TREND_SERIES_KEYS) {
    const series = history.series[key];
    for (const point of series.annual) {
      const existing = annual.get(point.periodEnd);
      if (existing === undefined || point.filedAt > existing.filedAt) {
        annual.set(point.periodEnd, {
          kind: "annual",
          periodEnd: point.periodEnd,
          filedAt: point.filedAt,
        });
      }
    }
  }

  const annualRows = [...annual.values()]
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    .slice(-5);
  let ttm: TrendPeriod | undefined = undefined;
  for (const key of TREND_SERIES_KEYS) {
    const series = history.series[key];
    const point = series.ttm;
    if (
      point !== undefined &&
      (ttm === undefined ||
        point.periodEnd > ttm.periodEnd ||
        (point.periodEnd === ttm.periodEnd && point.filedAt > ttm.filedAt))
    ) {
      ttm = {
        kind: "ttm",
        periodEnd: point.periodEnd,
        filedAt: point.filedAt,
      };
    }
  }
  return ttm === undefined ? annualRows : [...annualRows, ttm];
}

export function financialTrendGaps(history: FundamentalHistoryArtifact): readonly string[] {
  const missingRevenuePeriods = trendPeriods(history).filter(
    (period) => historyPoint(history.series.revenue, period.periodEnd, period.kind) === undefined,
  ).length;
  if (missingRevenuePeriods === 0) {
    return [];
  }
  return [
    `fundamental-history-revenue: SEC revenue history is unavailable for ${String(missingRevenuePeriods)} rendered period(s); affected revenue and derived operating-margin values are shown as unavailable`,
  ];
}

export function historyPoint(
  series: FundamentalHistorySeries,
  periodEnd: string,
  kind: TrendPeriod["kind"],
): FundamentalHistoryPoint | undefined {
  if (kind === "ttm") {
    return series.ttm?.periodEnd === periodEnd ? series.ttm : undefined;
  }
  return series.annual.find((point) => point.periodEnd === periodEnd);
}

export function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  const units = [
    [1_000_000_000_000, "T"],
    [1_000_000_000, "B"],
    [1_000_000, "M"],
  ] as const;
  for (const [scale, suffix] of units) {
    if (absolute >= scale) {
      return `${(value / scale).toFixed(1)}${suffix}`;
    }
  }
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
}

function trendValue(
  history: FundamentalHistoryArtifact,
  key: keyof FundamentalHistoryArtifact["series"],
  period: TrendPeriod,
): number | undefined {
  return historyPoint(history.series[key], period.periodEnd, period.kind)?.value;
}

export function formatTrendAmount(value: number | undefined): string {
  return value === undefined ? "—" : compactNumber(value);
}

function formatTrendPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

export function financialTrendRows(
  history: FundamentalHistoryArtifact,
): readonly FinancialTrendRow[] {
  return trendPeriods(history).map((period) => ({
    period: periodLabel(period),
    revenue: formatTrendAmount(trendValue(history, "revenue", period)),
    netIncome: formatTrendAmount(trendValue(history, "netIncome", period)),
    operatingMargin: formatTrendPercent(trendValue(history, "operatingMargin", period)),
    freeCashFlow: formatTrendAmount(trendValue(history, "freeCashFlowProxy", period)),
  }));
}

export function financialTrendCurrency(history: FundamentalHistoryArtifact): string | undefined {
  return history.series.revenue.ttm?.currency ?? history.series.revenue.annual.at(-1)?.currency;
}

function hasPlainLanguageDescription(text: string): boolean {
  const outsideParentheses = text.replaceAll(/\([^()]*\)/gu, " ");
  const descriptiveWords = (outsideParentheses.match(/[A-Za-z][A-Za-z'-]*/gu) ?? []).filter(
    (word) =>
      !["business", "criteria", "supported", "mixed", "not", "insufficient", "data"].includes(
        word.toLowerCase(),
      ),
  );
  return descriptiveWords.length >= 2;
}

function knownSourceIds(report: CompanyDescriptionReport, sourceIds: unknown): readonly string[] {
  if (!Array.isArray(sourceIds)) {
    return [];
  }
  const known = new Set(
    Array.isArray(report.sources)
      ? report.sources.flatMap((source) =>
          isRecord(source) && typeof source.id === "string" ? [source.id] : [],
        )
      : [],
  );
  return sourceIds.filter(
    (sourceId): sourceId is string => typeof sourceId === "string" && known.has(sourceId),
  );
}

export function companyDescription(report: CompanyDescriptionReport): CompanyDescription {
  const extras = isRecord(report.extras) ? report.extras : undefined;
  const profile = isRecord(extras?.webSubjectProfile) ? extras.webSubjectProfile : undefined;
  if (profile !== undefined) {
    const candidates = [
      profile.subjectSummary,
      isRecord(profile.questions) ? profile.questions.whatItDoes : undefined,
    ];
    for (const candidate of candidates) {
      if (!isRecord(candidate) || typeof candidate.answer !== "string" || candidate.answer === "") {
        continue;
      }
      return {
        text: candidate.answer,
        sourceIds: knownSourceIds(report, candidate.sourceIds),
      };
    }
  }

  const framework = isRecord(extras?.businessFramework) ? extras.businessFramework : undefined;
  if (framework !== undefined && Array.isArray(framework.sections)) {
    const business = framework.sections.find(
      (section) => isRecord(section) && section.name === "Business",
    );
    if (isRecord(business)) {
      let rawText = "";
      if (typeof business.text === "string") {
        rawText = business.text;
      } else if (typeof business.summary === "string") {
        rawText = business.summary;
      }
      const posture = typeof business.posture === "string" ? business.posture : "";
      const prefix = `Business ${posture}`;
      const plainText = (
        rawText.startsWith(prefix) ? rawText.slice(prefix.length) : rawText
      ).trim();
      if (plainText !== "" && hasPlainLanguageDescription(rawText)) {
        return {
          text: plainText,
          sourceIds: knownSourceIds(report, business.sourceIds),
        };
      }
    }
  }

  return { text: NO_COMPANY_DESCRIPTION, sourceIds: [] };
}
