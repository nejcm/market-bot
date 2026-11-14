import { isFreshPeriodEnd } from "../config/shared";
import { resolveMarketSnapshotPriceAsOf, type MarketSnapshot } from "../domain/market-data";
import { isCashFlowInput, PRICE_RELATIVE_KEYS } from "../sources/extended-evidence/metric-engine";
import { unreconciledDividendsPerShare } from "../sources/extended-evidence/financial-statements";
import {
  nearZeroBase,
  YOY_BASE_SERIES,
} from "../sources/extended-evidence/sec-fundamentals-format";

interface ReportMetricInput {
  readonly artifact?: string;
  readonly category?: string;
  readonly series?: string;
  readonly key?: string;
  readonly value?: number | string;
  readonly periodType?: string;
  readonly periodStart?: string;
  readonly periodEnd?: string;
  readonly periodKey?: string;
  readonly currency?: string;
  readonly label?: string;
  readonly unit?: string;
  readonly sourceIds?: readonly string[];
  readonly derivation?: string;
}

interface ReportMetric {
  readonly id?: string;
  readonly status?: string;
  readonly value?: number | string | null;
  readonly unit?: string;
  readonly currency?: string;
  readonly periodEnd?: string;
  readonly periodMonths?: number;
  readonly priceAsOf?: string;
  readonly reason?: string;
  readonly label?: string;
  readonly inputs?: readonly ReportMetricInput[];
}

export type MetricSections = readonly {
  readonly id?: string;
  readonly metrics: readonly ReportMetric[];
}[];

type QuoteSnapshots = readonly Pick<MarketSnapshot, "sourceId" | "observedAt" | "quoteTimeUtc">[];

export interface ReportViolation {
  readonly invariant: string;
  readonly section: string;
  readonly metric: string;
  readonly detail: string;
}

const REVENUE_MULTIPLES = new Set([
  "marketCapToAnnualizedRevenue",
  "evToAnnualizedRevenue",
  "priceToSales",
  "enterpriseValueToRevenue",
]);
// Price-numerator multiples only: EV/revenue is legitimately negative when cash exceeds EV.
const VALUATION_MULTIPLES = new Set([
  "marketCapToAnnualizedRevenue",
  "priceToSales",
  "peRatio",
  "trailingPE",
  "forwardPe",
  "forwardPE",
  "pcfRatio",
  "priceToBook",
  "priceToEarnings",
  "priceToFreeCashFlow",
]);
const GROWTH_ROW =
  /DeltaPercent$|Cagr\dy$|Change\dy$|^issuer-report-.+-yoy-(?:quarter|ytd|annual)$/u;
// The shared verdict's floor and ceiling reasons from valuation-comps-contract.ts.
const REVENUE_MULTIPLE_VERDICT = /de-minimis floor|x ceiling$/u;
const CURRENT_VALUATION_SECTION = /^(financial-lens|business-framework)-/u;
const EQUIVALENT_SURFACES = [/^financial-lens-/u, /^business-framework-/u] as const;
const STALE_REASON = /^stale .+ as of (\d{4}-\d{2}-\d{2})$/u;
const YOY_WATCH = 1000;

function published(sections: MetricSections) {
  return sections.flatMap((section) =>
    section.metrics
      .filter((metric) => metric.status === "value")
      .map((metric) => ({ section: section.id ?? "", metric })),
  );
}

// One value's identity across rows: a statement fact by period, an evidence key by its row's period.
function slot(metric: ReportMetric, input: ReportMetricInput, series: string): string | undefined {
  if (input.artifact === "statements") {
    return `${series}@${input.periodKey}/${input.periodType}`;
  }
  const prior = input.key?.endsWith("Prior") === true ? "Prior" : "";
  return input.artifact === "evidence"
    ? `${series}${prior}@${metric.periodEnd}/${metric.periodMonths}`
    : undefined;
}

function seriesOf(input: ReportMetricInput | undefined): string {
  return input?.series ?? input?.key?.replace(/Prior$/u, "") ?? "";
}

// Issuer inputs quote cell text; the matching single-figure row holds its checked number.
function issuerKey(input: ReportMetricInput): string {
  return JSON.stringify([
    input.label,
    input.value,
    input.periodEnd,
    input.unit,
    input.currency,
    input.sourceIds?.[0],
  ]);
}

// Class checks over one report's Metric Sections; each names a defect class from .plans/issues.md.
export function reportInvariantViolations(
  sections: MetricSections,
  quoteSnapshots: QuoteSnapshots = [],
  depositorySic?: string,
  generatedAt?: string,
): readonly ReportViolation[] {
  const violations: ReportViolation[] = [];
  const add = (invariant: string, section: string, metric: string, detail: string) =>
    violations.push({ invariant, section, metric, detail });
  const rows = published(sections);

  for (const section of sections) {
    for (const metric of section.metrics) {
      if (
        generatedAt !== undefined &&
        CURRENT_VALUATION_SECTION.test(section.id ?? "") &&
        REVENUE_MULTIPLES.has(metric.id ?? "") &&
        (metric.status === "value" ||
          (metric.status === "not-meaningful" &&
            REVENUE_MULTIPLE_VERDICT.test(metric.reason ?? ""))) &&
        (metric.periodEnd === undefined || !isFreshPeriodEnd(metric.periodEnd, generatedAt))
      ) {
        add(
          "revenue-multiple-on-stale-revenue",
          section.id!,
          metric.id!,
          `${metric.status ?? ""} ${metric.periodEnd ?? "undated"}`,
        );
      }
    }
  }

  const supportabilityNotMeaningful = rows.some(
    ({ metric }) => metric.id === "valuationSupportability" && metric.value === "not-meaningful",
  );
  for (const section of sections) {
    const sectionVerdict = section.metrics.some(
      (metric) =>
        REVENUE_MULTIPLES.has(metric.id ?? "") &&
        metric.status === "not-meaningful" &&
        REVENUE_MULTIPLE_VERDICT.test(metric.reason ?? ""),
    );
    const currentVerdict =
      supportabilityNotMeaningful && CURRENT_VALUATION_SECTION.test(section.id ?? "");
    if (!sectionVerdict && !currentVerdict) {
      continue;
    }
    for (const metric of section.metrics) {
      if (metric.status === "value" && REVENUE_MULTIPLES.has(metric.id ?? "")) {
        add(
          "revenue-multiple-published-when-not-meaningful",
          section.id ?? "",
          metric.id!,
          `${String(metric.value)}: ${sectionVerdict ? "sibling revenue multiple not meaningful" : "valuationSupportability not-meaningful"}`,
        );
      }
    }
  }

  for (const section of sections) {
    const staleDates = new Set(
      section.metrics.flatMap((metric) => {
        const match = metric.status === "value" ? null : STALE_REASON.exec(metric.reason ?? "");
        return match === null ? [] : [match[1]!];
      }),
    );
    for (const metric of section.metrics) {
      if (
        metric.status === "value" &&
        metric.unit === "currency" &&
        metric.periodMonths === undefined &&
        metric.periodEnd !== undefined &&
        staleDates.has(metric.periodEnd)
      ) {
        add(
          "instant-published-beside-stale-sibling",
          section.id ?? "",
          metric.id ?? "",
          metric.periodEnd,
        );
      }
    }
  }

  const equivalents = new Map<
    string,
    { surface: number; section: string; status: string | undefined; value: ReportMetric["value"] }[]
  >();
  for (const section of sections) {
    const surface = EQUIVALENT_SURFACES.findIndex((pattern) => pattern.test(section.id ?? ""));
    if (surface === -1) {
      continue;
    }
    for (const metric of section.metrics) {
      if (metric.id === undefined || metric.periodEnd === undefined) {
        continue;
      }
      const key = [metric.id, metric.periodEnd, metric.periodMonths ?? ""].join("\n");
      equivalents.set(key, [
        ...(equivalents.get(key) ?? []),
        { surface, section: section.id ?? "", status: metric.status, value: metric.value },
      ]);
    }
  }
  for (const [key, entries] of equivalents) {
    const [id, periodEnd, periodMonths] = key.split("\n");
    const values = new Set(
      entries.filter((entry) => entry.status === "value").map((entry) => entry.value),
    );
    const statuses = new Set(entries.map((entry) => entry.status));
    if (
      new Set(entries.map((entry) => entry.surface)).size === EQUIVALENT_SURFACES.length &&
      (values.size > 1 || statuses.size > 1)
    ) {
      add(
        "surfaces-disagree",
        entries.map((entry) => entry.section).join(","),
        id!,
        `${[periodEnd, periodMonths].filter(Boolean).join(" ")}: ${entries.map((entry) => `${entry.status}=${entry.value ?? ""}`).join(" ")}`,
      );
    }
  }

  const quoteDates = new Map(
    quoteSnapshots.map((snapshot) => [
      snapshot.sourceId,
      resolveMarketSnapshotPriceAsOf(snapshot).instant.slice(0, 10),
    ]),
  );
  const issuerFigures = new Map(
    rows.flatMap(({ metric }) => {
      const [input] = metric.inputs ?? [];
      return metric.inputs?.length === 1 &&
        input?.artifact === "issuerReport" &&
        typeof metric.value === "number"
        ? [[issuerKey(input), metric.value] as const]
        : [];
    }),
  );
  const filedCurrencies = new Set(
    sections.flatMap(({ metrics }) =>
      metrics.flatMap(({ inputs = [] }) =>
        inputs.flatMap((input) =>
          input.artifact === "statements" && input.currency ? [input.currency.split("/")[0]!] : [],
        ),
      ),
    ),
  );
  const numberOf = (input: ReportMetricInput) =>
    typeof input.value === "number" ? input.value : issuerFigures.get(issuerKey(input));
  for (const { section, metric } of rows) {
    const id = metric.id ?? "";
    const inputs = metric.inputs ?? [];
    const priced = inputs.filter(
      (input) => input.artifact === "quote" || PRICE_RELATIVE_KEYS.has(input.key ?? ""),
    );
    // The engine omits priceAsOf when the row's periodEnd already is its quote's date.
    if (
      metric.unit !== "text" &&
      metric.priceAsOf === undefined &&
      priced.length > 0 &&
      !(
        metric.periodEnd !== undefined &&
        priced.some((input) =>
          (input.sourceIds ?? []).some(
            (sourceId) => quoteDates.get(sourceId) === metric.periodEnd?.slice(0, 10),
          ),
        )
      )
    ) {
      add("price-relative-row-undated", section, id, metric.periodEnd ?? "no periodEnd");
    }
    const currencies = new Set(inputs.flatMap((input) => input.currency ?? []));
    if (currencies.size > 1 && !inputs.some((input) => input.artifact === "fx")) {
      add("currency-mix-without-fx", section, id, [...currencies].join("+"));
    }
    // Valuation Evidence is USD-only, so it carries no operand currency of its own.
    if (
      metric.unit !== "text" &&
      [...filedCurrencies].some((currency) => currency !== "USD") &&
      inputs.some((input) => input.artifact === "evidence" && input.category === "valuation") &&
      !inputs.some((input) => input.artifact === "fx")
    ) {
      add(
        "currency-mix-without-fx",
        section,
        id,
        [...new Set(["USD", ...filedCurrencies])].join("+"),
      );
    }
    const flowPeriods = new Map<string, Set<string>>();
    for (const input of inputs) {
      if (input.artifact === "statements" && input.periodStart !== undefined) {
        const series = input.series ?? input.key ?? "";
        flowPeriods.set(
          series,
          (flowPeriods.get(series) ?? new Set()).add(`${input.periodKey}/${input.periodType}`),
        );
      }
    }
    const periodSets = [...flowPeriods.values()];
    const changeSets = periodSets.filter((periods) => periods.size > 1);
    // Workbench TTM lineage, Phase and capital-return trends span periods; a Lens/Framework ratio joins one.
    const spansPeriods =
      GROWTH_ROW.test(id) || id === "phase" || !CURRENT_VALUATION_SECTION.test(section);
    // A change row compares its multi-period series; a single-period series beside it is context.
    const periodMismatch =
      spansPeriods && changeSets.length > 0
        ? new Set(changeSets.map((periods) => [...periods].toSorted().join(","))).size > 1
        : new Set(periodSets.flatMap((periods) => [...periods])).size > 1;
    if (periodMismatch) {
      add(
        "flow-inputs-period-mismatch",
        section,
        id,
        [...flowPeriods]
          .map(([series, periods]) => `${series}@${[...periods].join("+")}`)
          .join(" "),
      );
    }
    if (depositorySic !== undefined && inputs.some(isCashFlowInput)) {
      add("cash-flow-row-published-for-depository-issuer", section, id, `SIC ${depositorySic}`);
    }
    if (VALUATION_MULTIPLES.has(id) && typeof metric.value === "number" && metric.value <= 0) {
      add("nonpositive-valuation-multiple", section, id, String(metric.value));
    }
    const endpoints = inputs.toSorted((a, b) =>
      (a.periodEnd ?? "").localeCompare(b.periodEnd ?? ""),
    );
    const [base, latest] = endpoints.map((input) => numberOf(input));
    if (
      GROWTH_ROW.test(id) &&
      endpoints.length === 2 &&
      typeof base === "number" &&
      typeof latest === "number" &&
      (base <= 0 || latest < 0)
    ) {
      add("growth-on-nonpositive-base-or-sign-flip", section, id, `${base} -> ${latest}`);
    }
  }

  const slots = new Map(
    sections.flatMap(({ metrics }) =>
      metrics.flatMap((metric) =>
        (metric.inputs ?? []).flatMap((input) => {
          const key = slot(metric, input, seriesOf(input));
          return key !== undefined && typeof input.value === "number"
            ? [[key, input.value] as const]
            : [];
        }),
      ),
    ),
  );
  const belowFloor = (metric: ReportMetric, input: ReportMetricInput | undefined, series = "") => {
    const at = (name: string) =>
      input === undefined ? undefined : slots.get(slot(metric, input, name) ?? "");
    const [base, revenue] = [at(series), at("revenue")];
    return base !== undefined && revenue !== undefined && nearZeroBase(base, revenue);
  };
  const byId = new Map(rows.map(({ metric }) => [metric.id, metric]));
  for (const { section, metric } of rows) {
    const id = metric.id ?? "";
    const [first, second] = metric.inputs ?? [];
    if (id === "cashConversion" && belowFloor(metric, second, seriesOf(second))) {
      add("cash-conversion-near-zero-denominator", section, id, String(metric.value));
    }
    const issuer = /^issuer-report-(.+)-yoy-(quarter|ytd|annual)$/u.exec(id);
    if (issuer !== null && issuer[1] !== "revenue" && second !== undefined) {
      const scope = metric.label?.endsWith(", continuing operations") === true ? "-continuing" : "";
      const row = byId.get(`issuer-report-revenue${scope}-${issuer[2]}-${second.periodEnd}`);
      const sameBasis =
        row?.currency === second.currency && row?.periodMonths === metric.periodMonths;
      const [base, revenue] = [numberOf(second), sameBasis ? row?.value : undefined];
      if (typeof revenue === "number" && typeof base === "number" && nearZeroBase(base, revenue)) {
        add("yoy-on-near-zero-base", section, id, String(metric.value));
      }
    }
    const [shares, paid] = ["dilutedShares", "dividendsPaid"].map((name) =>
      id !== "dpsLatestFy" || first === undefined
        ? undefined
        : slots.get(slot(metric, first, name) ?? ""),
    );
    const ratio =
      first?.derivation === undefined &&
      typeof metric.value === "number" &&
      metric.value > 0 &&
      shares &&
      paid
        ? unreconciledDividendsPerShare(metric.value, shares, Math.abs(paid))
        : undefined;
    if (ratio !== undefined) {
      add("dps-unreconciled-with-dividends", section, id, `${metric.value}: ${ratio.toFixed(3)}x`);
    }
    if (!id.endsWith("DeltaPercent")) {
      continue;
    }
    if (belowFloor(metric, first, YOY_BASE_SERIES[seriesOf(first)])) {
      add("yoy-on-near-zero-base", section, id, String(metric.value));
    }
    if (Math.abs(Number(metric.value)) > YOY_WATCH) {
      add("watch:yoy-above-1000-percent", section, id, String(metric.value));
    }
  }
  return violations;
}
