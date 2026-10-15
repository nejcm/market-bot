import { expect } from "bun:test";
import type { InstrumentCommand } from "../../src/cli/args";
import type { ExtendedEvidence } from "../../src/domain/evidence";
import { DAY_MS, SEC_FRESHNESS_DAYS } from "../../src/config/shared";
import { legacyFinancialLensEvidence } from "../../src/sources/extended-evidence/financial-lens-legacy";
import { priorComparable } from "../../src/sources/extended-evidence/financial-lens-canonical";
import type { FinancialLensArtifact } from "../../src/sources/extended-evidence/financial-lens";
import {
  latestCommonFinancialStatementFacts,
  financialStatementFacts,
  financialStatementPeriodMonths,
  financialStatementSeriesByKey,
  isYearAligned,
  latestFinancialStatementFact,
} from "../../src/sources/extended-evidence/financial-statement-selection";
import type {
  FinancialStatementFact,
  FinancialStatementSeriesKey,
} from "../../src/sources/extended-evidence/financial-statements-contract";
import { MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS } from "../../src/sources/extended-evidence/valuation-comps";
import type { CollectedSources } from "../../src/sources/types";
import { tickerSnapshot } from "../../src/sources/extended-evidence/financial-lens-metrics";

export type WaiverClass = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "D8";

export interface ParityDiff {
  readonly key: string;
  readonly old: unknown;
  readonly new: unknown;
}

export interface Waiver extends ParityDiff {
  readonly fixture: string;
  readonly class: WaiverClass;
}

export type ParityInput = Pick<
  CollectedSources,
  | "extendedEvidence"
  | "financialLenses"
  | "metricSections"
  | "marketSnapshots"
  | "verifiedMarketSnapshot"
  | "financialStatements"
  | "subsequentFinancing"
  | "reportingFreshness"
> &
  Partial<Pick<CollectedSources, "sourceGaps">>;

const LENSES = ["Quality", "Growth", "Financial Strength", "Value", "Momentum"] as const;
const LENS_SECTION_IDS: Readonly<Record<string, string>> = {
  Quality: "financial-lens-quality",
  Growth: "financial-lens-growth",
  "Financial Strength": "financial-lens-financial-strength",
  Value: "financial-lens-value",
  Momentum: "financial-lens-momentum",
};

interface MetricSpec {
  readonly series: readonly FinancialStatementSeriesKey[];
  readonly kind:
    | "ratio"
    | "difference"
    | "amount"
    | "endpoint"
    | "inverted-ratio"
    | "annualized-ratio";
}

const LENS_METRIC_INPUTS: Readonly<Record<string, MetricSpec>> = {
  grossMargin: { series: ["grossProfit", "revenue"], kind: "ratio" },
  operatingMargin: { series: ["operatingIncome", "revenue"], kind: "ratio" },
  netMargin: { series: ["netIncome", "revenue"], kind: "ratio" },
  freeCashFlowProxy: { series: ["operatingCashFlow", "capitalExpenditure"], kind: "difference" },
  cashConversion: { series: ["operatingCashFlow", "netIncome"], kind: "ratio" },
  roe: { series: ["netIncome", "stockholdersEquity"], kind: "annualized-ratio" },
  roa: { series: ["netIncome", "totalAssets"], kind: "annualized-ratio" },
  revenueDeltaPercent: { series: ["revenue"], kind: "endpoint" },
  grossProfitDeltaPercent: { series: ["grossProfit"], kind: "endpoint" },
  operatingIncomeDeltaPercent: { series: ["operatingIncome"], kind: "endpoint" },
  netIncomeDeltaPercent: { series: ["netIncome"], kind: "endpoint" },
  dilutedEpsDeltaPercent: { series: ["dilutedEps"], kind: "endpoint" },
  continuingIncomeDeltaPercent: { series: ["continuingIncome"], kind: "endpoint" },
  continuingDilutedEpsDeltaPercent: { series: ["continuingDilutedEps"], kind: "endpoint" },
  operatingCashFlowDeltaPercent: { series: ["operatingCashFlow"], kind: "endpoint" },
  consolidatedNetIncome: { series: ["consolidatedNetIncome"], kind: "amount" },
  cash: { series: ["cash"], kind: "amount" },
  debt: { series: ["debt"], kind: "amount" },
  netDebt: { series: ["debt", "cash"], kind: "difference" },
  debtToMarketCap: { series: ["debt"], kind: "ratio" },
  netDebtToMarketCap: { series: ["debt", "cash"], kind: "inverted-ratio" },
  currentRatio: { series: ["currentAssets", "currentLiabilities"], kind: "ratio" },
  debtToEquity: { series: ["debt", "stockholdersEquity"], kind: "ratio" },
  payoutRatio: { series: ["dividendsPaid", "netIncome"], kind: "inverted-ratio" },
};

const LEGACY_INPUT_KEYS: Readonly<
  Record<
    string,
    readonly { readonly category: string; readonly key: string; readonly aux?: readonly string[] }[]
  >
> = {
  grossMargin: [{ category: "sec-edgar", key: "grossMarginSelectedValue" }],
  operatingMargin: [{ category: "sec-edgar", key: "operatingMarginSelectedValue" }],
  netMargin: [{ category: "sec-edgar", key: "netMarginSelectedValue" }],
  freeCashFlowProxy: [{ category: "sec-edgar", key: "freeCashFlowProxySelectedValue" }],
  cashConversion: [{ category: "sec-edgar", key: "cashConversionSelectedValue" }],
  roe: [{ category: "sec-edgar", key: "roeSelectedValue" }],
  roa: [{ category: "sec-edgar", key: "roaSelectedValue" }],
  revenueDeltaPercent: [{ category: "sec-edgar", key: "revenueDeltaPercent" }],
  grossProfitDeltaPercent: [{ category: "sec-edgar", key: "grossProfitDeltaPercent" }],
  operatingIncomeDeltaPercent: [{ category: "sec-edgar", key: "operatingIncomeDeltaPercent" }],
  netIncomeDeltaPercent: [
    { category: "sec-edgar", key: "netIncomeDeltaPercent", aux: ["netIncomePrior"] },
  ],
  dilutedEpsDeltaPercent: [{ category: "sec-edgar", key: "dilutedEpsDeltaPercent" }],
  continuingIncomeDeltaPercent: [
    { category: "sec-edgar", key: "continuingIncomeDeltaPercent", aux: ["continuingIncomePrior"] },
  ],
  continuingDilutedEpsDeltaPercent: [
    { category: "sec-edgar", key: "continuingDilutedEpsDeltaPercent" },
  ],
  operatingCashFlowDeltaPercent: [{ category: "sec-edgar", key: "operatingCashFlowDeltaPercent" }],
  cash: [{ category: "sec-edgar", key: "cash" }],
  debt: [{ category: "sec-edgar", key: "debt" }],
  netDebt: [
    { category: "sec-edgar", key: "netDebtSelectedValue" },
    { category: "valuation", key: "netDebt" },
  ],
  debtToMarketCap: [{ category: "valuation", key: "debtToMarketCap" }],
  netDebtToMarketCap: [{ category: "valuation", key: "netDebtToMarketCap" }],
  currentRatio: [{ category: "sec-edgar", key: "currentRatioSelectedValue" }],
  debtToEquity: [{ category: "sec-edgar", key: "debtToEquitySelectedValue" }],
  payoutRatio: [{ category: "sec-edgar", key: "payoutRatioSelectedValue" }],
};

function sameValue(left: unknown, right: unknown): boolean {
  return typeof left === "number" && typeof right === "number"
    ? Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left))
    : left === right;
}

function facts(input: ParityInput, key: FinancialStatementSeriesKey) {
  const series =
    input.financialStatements === undefined
      ? undefined
      : financialStatementSeriesByKey(input.financialStatements, key);
  return series === undefined ? [] : financialStatementFacts(series);
}

function aligned(fact: FinancialStatementFact): boolean {
  return fact.periodStart === undefined || isYearAligned(fact.periodStart, fact.periodEnd);
}

function eligible(input: ParityInput, key: FinancialStatementSeriesKey) {
  return facts(input, key).filter((fact) => fact.periodType === "interim" || aligned(fact));
}

function latest(input: ParityInput, key: FinancialStatementSeriesKey) {
  return latestFinancialStatementFact(eligible(input, key));
}

function samePeriod(
  input: ParityInput,
  anchor: FinancialStatementFact,
  key: FinancialStatementSeriesKey,
) {
  return latestFinancialStatementFact(
    eligible(input, key).filter(
      (fact) => fact.periodKey === anchor.periodKey && fact.periodType === anchor.periodType,
    ),
  );
}

function priorOf(input: ParityInput, key: FinancialStatementSeriesKey, yearAlignedPrior: boolean) {
  const anchor = latest(input, key);
  const series =
    input.financialStatements === undefined
      ? undefined
      : financialStatementSeriesByKey(input.financialStatements, key);
  if (anchor === undefined || series === undefined) {
    return undefined;
  }
  return priorComparable(
    yearAlignedPrior ? { ...series, annual: series.annual.filter(aligned) } : series,
    anchor,
    new Set(),
  );
}

function recomputed(input: ParityInput, id: string): number | undefined {
  const spec = LENS_METRIC_INPUTS[id];
  if (spec === undefined) {
    return undefined;
  }
  const [first, second] = spec.series as [
    FinancialStatementSeriesKey,
    FinancialStatementSeriesKey | undefined,
  ];
  if (spec.kind === "endpoint") {
    const anchor = latest(input, first);
    const prior = priorOf(input, first, true);
    return anchor === undefined || prior === undefined || prior.value === 0
      ? undefined
      : ((anchor.value - prior.value) / Math.abs(prior.value)) * 100;
  }
  const anchor = latest(input, first);
  if (anchor === undefined) {
    return undefined;
  }
  if (spec.kind === "amount") {
    return anchor.value;
  }
  if (second === undefined) {
    return undefined;
  }
  const other = samePeriod(input, anchor, second);
  if (other === undefined) {
    return undefined;
  }
  switch (spec.kind) {
    case "ratio": {
      return other.value <= 0 ? undefined : anchor.value / other.value;
    }
    case "difference": {
      return anchor.value - other.value;
    }
    case "inverted-ratio": {
      return other.value <= 0 ? undefined : Math.abs(anchor.value) / other.value;
    }
    case "annualized-ratio": {
      const months = financialStatementPeriodMonths(anchor);
      return other.value <= 0 || months === undefined
        ? undefined
        : (anchor.value * (12 / months)) / other.value;
    }
    default: {
      return undefined;
    }
  }
}

function legacyRecomputed(input: ParityInput, id: string): number | undefined {
  const spec = LENS_METRIC_INPUTS[id];
  if (spec === undefined || input.financialStatements === undefined) {
    return undefined;
  }
  const series = spec.series.map((key) =>
    financialStatementSeriesByKey(
      input.financialStatements as NonNullable<ParityInput["financialStatements"]>,
      key,
    ),
  );
  if (spec.kind === "endpoint") {
    const anchor = latestFinancialStatementFact(
      facts(input, spec.series[0] as FinancialStatementSeriesKey),
    );
    const prior = priorOf(input, spec.series[0] as FinancialStatementSeriesKey, false);
    return anchor === undefined || prior === undefined || prior.value === 0
      ? undefined
      : ((anchor.value - prior.value) / Math.abs(prior.value)) * 100;
  }
  if (spec.kind === "amount") {
    return latestFinancialStatementFact(facts(input, spec.series[0] as FinancialStatementSeriesKey))
      ?.value;
  }
  const [left, right] = latestCommonFinancialStatementFacts(series) ?? [];
  if (left === undefined || right === undefined) {
    return undefined;
  }
  switch (spec.kind) {
    case "ratio": {
      return right.value === 0 ? undefined : left.value / right.value;
    }
    case "difference": {
      return left.value - right.value;
    }
    case "inverted-ratio": {
      return right.value <= 0 ? undefined : Math.abs(left.value) / right.value;
    }
    case "annualized-ratio": {
      const months = financialStatementPeriodMonths(left);
      return right.value <= 0 || months === undefined
        ? undefined
        : (left.value * (12 / months)) / right.value;
    }
    default: {
      return undefined;
    }
  }
}

function misalignedProducedOld(input: ParityInput, id: string, oldValue: unknown): boolean {
  const spec = LENS_METRIC_INPUTS[id];
  if (spec === undefined || input.financialStatements === undefined) {
    return false;
  }
  const misaligned = spec.series.flatMap((key) =>
    facts(input, key).filter((fact) => fact.periodType === "annual" && !aligned(fact)),
  );
  if (misaligned.length === 0) {
    return false;
  }
  return sameValue(legacyRecomputed(input, id), oldValue);
}

function anchorPeriodEnd(input: ParityInput, id: string): string | undefined {
  const spec = LENS_METRIC_INPUTS[id];
  const key = spec?.series[0];
  return key === undefined ? undefined : latest(input, key)?.periodEnd;
}

function staleAnchor(input: ParityInput, id: string, generatedAt: string): boolean {
  const periodEnd = anchorPeriodEnd(input, id);
  if (periodEnd === undefined || !Number.isFinite(Date.parse(periodEnd))) {
    return false;
  }
  const asOfMs = Date.parse(generatedAt);
  if (!Number.isFinite(asOfMs)) {
    return false;
  }
  const ageDays = (asOfMs - Date.parse(periodEnd)) / DAY_MS;
  if (ageDays < 0 || ageDays > SEC_FRESHNESS_DAYS) {
    return true;
  }
  if (id === "payoutRatio") {
    return false;
  }
  const newest = Math.max(
    ...(
      [
        "cash",
        "debt",
        "currentAssets",
        "currentLiabilities",
        "stockholdersEquity",
        "totalAssets",
      ] as const
    )
      .flatMap((key) => facts(input, key))
      .filter((fact) => {
        const age = (asOfMs - Date.parse(fact.periodEnd)) / DAY_MS;
        return age >= 0 && age <= SEC_FRESHNESS_DAYS;
      })
      .map((fact) => Date.parse(fact.periodEnd)),
  );
  return (newest - Date.parse(periodEnd)) / DAY_MS > MAX_BALANCE_SHEET_PERIOD_DIVERGENCE_DAYS;
}

function metricKeyParts(
  key: string,
): { lens: string; metricId: string; field?: string } | undefined {
  const lensMatch =
    /^lens\.([A-Za-z ]+)\.([A-Za-z]+)(?:\.(label|unit|currency|periodEnd|periodMonths|sourceIds))?$/u.exec(
      key,
    );
  if (lensMatch !== null) {
    return {
      lens: lensMatch[1] ?? "",
      metricId: lensMatch[2] ?? "",
      field: lensMatch[3] ?? "value",
    };
  }
  const itemMatch = /^item\.metrics\.([A-Za-z]+?)(PeriodEnd)?$/u.exec(key);
  return itemMatch === null
    ? undefined
    : {
        lens: "",
        metricId: itemMatch[1] ?? "",
        field: itemMatch[2] === undefined ? "value" : "periodEnd",
      };
}

function lensArtifactOf(input: ParityInput): FinancialLensArtifact {
  const artifact = input.financialLenses;
  if (artifact === undefined) {
    throw new Error("parity gate needs a Financial Lens artifact");
  }
  for (const lens of LENSES) {
    if (!artifact.lenses.some((candidate) => candidate.name === lens)) {
      throw new Error(`parity gate needs the ${lens} lens`);
    }
  }
  return artifact;
}

export function financialLensParityDiffs(
  command: InstrumentCommand,
  input: ParityInput,
  patchedEvidence?: ExtendedEvidence,
): readonly ParityDiff[] {
  const evidence = patchedEvidence ?? input.extendedEvidence;
  const generatedAt = input.financialLenses?.generatedAt;
  if (evidence === undefined || input.financialLenses === undefined || generatedAt === undefined) {
    throw new Error("parity gate needs Extended Evidence and a Financial Lens artifact");
  }
  const lensItem = evidence.items.find((item) => item.category === "financial-lens");
  const newItem = input.extendedEvidence?.items.find((item) => item.category === "financial-lens");
  if (lensItem === undefined || newItem === undefined) {
    throw new Error("both builders must emit a financial-lens evidence item");
  }
  const lensSections =
    input.metricSections?.filter((section) => section.id.startsWith("financial-lens-")) ?? [];
  if (lensSections.some((section) => section.metrics.length === 0)) {
    throw new Error("parity gate needs non-empty lens Metric Sections");
  }
  const before: ExtendedEvidence = {
    ...evidence,
    items: evidence.items.filter((item) => item.category !== "financial-lens"),
  };
  const old = legacyFinancialLensEvidence(
    command,
    input.marketSnapshots,
    before,
    input.verifiedMarketSnapshot,
    generatedAt,
    input.subsequentFinancing,
    input.reportingFreshness,
  );
  const oldItem = old.extendedEvidence?.items.find((item) => item.category === "financial-lens");
  const oldArtifact = old.artifact;
  const newArtifact = lensArtifactOf(input);
  assertSectionCoverage(input, newArtifact);
  if (oldItem === undefined || oldArtifact === undefined) {
    throw new Error("the frozen builder must emit a financial-lens item and artifact");
  }
  const itemKeys = new Set(Object.keys(newItem.metrics ?? {}));
  for (const lens of newArtifact.lenses) {
    for (const row of lens.metrics) {
      if (!itemKeys.has(row.key)) {
        throw new Error(`the rebuilt item must carry ${lens.name}.${row.key}`);
      }
      if (row.periodEnd !== undefined && !itemKeys.has(`${row.key}PeriodEnd`)) {
        throw new Error(`the rebuilt item must date ${lens.name}.${row.key}`);
      }
    }
  }
  const diffs: ParityDiff[] = [];
  const compare = (key: string, left: unknown, right: unknown) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) {
      diffs.push({ key, old: left, new: right });
    }
  };
  for (const key of ["title", "summary", "sourceIds", "observedAt", "identity"] as const) {
    compare(`item.${key}`, oldItem[key], newItem[key]);
  }
  for (const key of new Set([
    ...Object.keys(oldItem.metrics ?? {}),
    ...Object.keys(newItem.metrics ?? {}),
  ])) {
    compare(`item.metrics.${key}`, oldItem.metrics?.[key], newItem.metrics?.[key]);
  }
  for (const name of LENSES) {
    const oldLens = oldArtifact.lenses.find((lens) => lens.name === name);
    const newLens = newArtifact.lenses.find((lens) => lens.name === name);
    if (oldLens === undefined || newLens === undefined) {
      throw new Error(`both builders must emit the ${name} lens`);
    }
    compare(`lens.${name}.posture`, oldLens.posture, newLens.posture);
    compare(`lens.${name}.sourceIds`, oldLens.sourceIds, newLens.sourceIds);
    compare(`lens.${name}.currentStatus`, oldLens.currentStatus, newLens.currentStatus);
    compare(
      `lens.${name}.order`,
      oldLens.metrics.map((metric) => metric.key),
      newLens.metrics.map((metric) => metric.key),
    );
    const oldRows = new Map(oldLens.metrics.map((metric) => [metric.key, metric] as const));
    const newRows = new Map(newLens.metrics.map((metric) => [metric.key, metric] as const));
    for (const key of new Set([...oldRows.keys(), ...newRows.keys()])) {
      const left = oldRows.get(key);
      const right = newRows.get(key);
      const path = `lens.${name}.${key}`;
      if (left === undefined || right === undefined || !sameValue(left.value, right.value)) {
        compare(path, left?.value, right?.value);
      }
      if (left !== undefined && right !== undefined) {
        compare(`${path}.label`, left.label, right.label);
        compare(`${path}.unit`, left.unit, right.unit);
        compare(`${path}.currency`, left.currency, right.currency);
        compare(`${path}.periodEnd`, left.periodEnd, right.periodEnd);
        compare(`${path}.periodMonths`, left.periodMonths, right.periodMonths);
        compare(`${path}.sourceIds`, left.sourceIds, right.sourceIds);
      }
    }
  }
  if (diffs.length === 0 && Object.keys(newItem.metrics ?? {}).length === 0) {
    throw new Error("the comparison is vacuous: the rebuilt item carries no metric");
  }
  return diffs;
}

function patchEvidence(evidence: ExtendedEvidence, waivers: readonly Waiver[]): ExtendedEvidence {
  const patches = waivers.flatMap((waiver) => {
    const parts = metricKeyParts(waiver.key);
    if (parts === undefined || !["value", "periodEnd"].includes(parts.field ?? "value")) {
      return [];
    }
    const targets = LEGACY_INPUT_KEYS[parts.metricId];
    return targets === undefined ? [] : targets.map((target) => ({ target, value: waiver.new }));
  });
  if (patches.length === 0) {
    return evidence;
  }
  return {
    ...evidence,
    items: evidence.items.map((item) => {
      const own = patches.filter(({ target }) => target.category === item.category);
      if (own.length === 0 || item.metrics === undefined) {
        return item;
      }
      const metrics: Record<string, number | string> = { ...item.metrics };
      for (const { target, value } of own) {
        for (const key of [target.key, ...(target.aux ?? [])]) {
          if (typeof value === "number" || typeof value === "string") {
            metrics[key] = value;
          } else {
            delete metrics[key];
          }
        }
      }
      return { ...item, metrics };
    }),
  };
}

export function waiverPreconditionHolds(
  command: InstrumentCommand,
  input: ParityInput,
  waiver: Waiver,
  waived: readonly Waiver[],
): boolean {
  const generatedAt =
    input.financialStatements?.analysisAsOf ?? input.financialLenses?.generatedAt ?? "";
  const parts = metricKeyParts(waiver.key);
  if (waiver.class === "D5") {
    return derivedFromWaived(command, input, waived, waiver);
  }
  if (waiver.class === "D7") {
    return parts?.field === "sourceIds" && sourceIdsNarrowed(input, parts.metricId, waiver);
  }
  if (waiver.class === "D6" && waiver.key === "item.summary") {
    return summaryDiffersOnlyInFiledCurrency(waiver, waived);
  }
  if (parts === undefined) {
    return false;
  }
  if (waiver.class === "D8") {
    const debt = latest(input, "debt");
    const quote = tickerSnapshot(command, input.marketSnapshots);
    const marketCap = quote?.marketCap;
    const quoteCurrency = quote?.identity?.quoteCurrency ?? "USD";
    return (
      parts.metricId === "debtToMarketCap" &&
      waiver.old === undefined &&
      debt !== undefined &&
      !staleAnchor(input, "debtToMarketCap", generatedAt) &&
      samePeriod(input, debt, "cash") === undefined &&
      marketCap !== undefined &&
      marketCap > 0 &&
      (debt.currency === null || debt.currency === quoteCurrency) &&
      (parts.field === "value"
        ? sameValue(debt.value / marketCap, waiver.new)
        : parts.field === "periodEnd" && debt.periodEnd === waiver.new)
    );
  }
  const valueLevel =
    parts.field === "value" || parts.field === "periodEnd" || parts.field === "periodMonths";
  if (waiver.class === "D4" && !staleMetricDeclared(input, parts.metricId, generatedAt)) {
    return false;
  }
  if (parts.field === "periodEnd") {
    return periodEndFollowsValue(input, parts, waiver, waived);
  }
  switch (waiver.class) {
    case "D1": {
      return (
        valueLevel &&
        misalignedProducedOld(input, parts.metricId, waiver.old) &&
        sameValue(recomputed(input, parts.metricId), waiver.new)
      );
    }
    case "D2": {
      return (
        valueLevel &&
        sameValue(legacyRecomputed(input, parts.metricId), waiver.old) &&
        recomputed(input, parts.metricId) === undefined &&
        waiver.new === undefined
      );
    }
    case "D4": {
      return (
        valueLevel && waiver.new === undefined && staleAnchor(input, parts.metricId, generatedAt)
      );
    }
    case "D6": {
      return (
        parts.field === "currency" &&
        waiver.old === undefined &&
        typeof waiver.new === "string" &&
        filedCurrencies(input, parts.metricId).includes(waiver.new)
      );
    }
    default: {
      return false;
    }
  }
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function periodEndFollowsValue(
  input: ParityInput,
  parts: { lens: string; metricId: string; field?: string },
  waiver: Waiver,
  waived: readonly Waiver[],
): boolean {
  const spec = LENS_METRIC_INPUTS[parts.metricId];
  if (spec === undefined) {
    return false;
  }
  const valueWaiver = waived.find((other) => {
    const otherParts = metricKeyParts(other.key);
    return (
      otherParts !== undefined &&
      otherParts.metricId === parts.metricId &&
      other.class === waiver.class &&
      otherParts.field === "value" &&
      (other.new === undefined) === (waiver.new === undefined)
    );
  });
  if (valueWaiver === undefined) {
    return false;
  }
  if (waiver.new === undefined) {
    return true;
  }
  const anchor = latest(input, spec.series[0] as FinancialStatementSeriesKey);
  return anchor?.periodEnd === waiver.new;
}

function summaryDiffersOnlyInFiledCurrency(
  waiver: Pick<Waiver, "old" | "new">,
  waived: readonly Waiver[],
): boolean {
  if (typeof waiver.old !== "string" || typeof waiver.new !== "string") {
    return false;
  }
  const currencies = [
    ...new Set(
      waived.flatMap((other) =>
        other.class === "D6" && other.key.endsWith(".currency") && typeof other.new === "string"
          ? [other.new]
          : [],
      ),
    ),
  ];
  if (currencies.length === 0) {
    return false;
  }
  const strip = (text: string) =>
    currencies
      .reduce((current, currency) => current.replaceAll(`${currency} `, ""), text)
      .replaceAll("$", "");
  return strip(waiver.old) === strip(waiver.new);
}

function requiredSourceIds(input: ParityInput, id: string): readonly string[] {
  const sec = input.extendedEvidence?.items.find(
    (item) => item.category === "sec-edgar" && item.metrics !== undefined,
  );
  const valuation = input.extendedEvidence?.items.find((item) => item.category === "valuation");
  const snapshot = input.marketSnapshots.find(
    (candidate) =>
      candidate.symbol ===
      (input.financialStatements?.symbol ?? input.extendedEvidence?.instrument?.symbol),
  );
  const quoteIds =
    snapshot?.marketCap !== undefined ? [snapshot.sourceId] : (valuation?.sourceIds ?? []);
  if (input.financialStatements === undefined) {
    if (["debtToMarketCap", "netDebtToMarketCap"].includes(id)) {
      return valuation?.sourceIds ?? [];
    }
    return id === "pcfRatio"
      ? [...new Set([...(sec?.sourceIds ?? []), ...quoteIds])]
      : id === "netDebt" && typeof valuation?.metrics?.netDebt === "number"
        ? valuation.sourceIds
        : (sec?.sourceIds ?? []);
  }
  const spec = LENS_METRIC_INPUTS[id];
  const first = id === "pcfRatio" ? "operatingCashFlow" : spec?.series[0];
  if (first === undefined) {
    return [];
  }
  const anchor = latest(input, first);
  if (anchor === undefined) {
    return [];
  }
  const second =
    id === "cashConversion" && anchor.concept.includes("Continuing")
      ? "continuingIncome"
      : spec?.series[1];
  const partner =
    second === undefined
      ? undefined
      : id === "roe" || id === "roa"
        ? latestFinancialStatementFact(
            eligible(input, second).filter(
              (fact) => fact.periodKey === `instant|${anchor.periodEnd}`,
            ),
          )
        : samePeriod(input, anchor, second);
  const prior = spec?.kind === "endpoint" ? priorOf(input, first, true) : undefined;
  return [
    ...new Set([
      ...anchor.sourceIds,
      ...(partner?.sourceIds ?? []),
      ...(prior?.sourceIds ?? []),
      ...(["debtToMarketCap", "netDebtToMarketCap", "pcfRatio"].includes(id) ? quoteIds : []),
    ]),
  ];
}

function sourceIdsNarrowed(input: ParityInput, metricId: string, waiver: Waiver): boolean {
  const oldIds = stringArray(waiver.old);
  const newIds = stringArray(waiver.new);
  const required = requiredSourceIds(input, metricId);
  return (
    required.length > 0 &&
    newIds.length === required.length &&
    newIds.every((id) => oldIds.includes(id)) &&
    required.every((id) => newIds.includes(id))
  );
}

const CURRENTNESS_METRICS = new Set([
  "netDebt",
  "currentRatio",
  "debtToEquity",
  "debtToMarketCap",
  "netDebtToMarketCap",
  "payoutRatio",
]);

function staleMetricDeclared(input: ParityInput, id: string, generatedAt: string): boolean {
  if (!CURRENTNESS_METRICS.has(id) || !staleAnchor(input, id, generatedAt)) {
    return false;
  }
  const section = input.metricSections?.find(
    (candidate) => candidate.id === LENS_SECTION_IDS["Financial Strength"],
  );
  const row = section?.metrics.find((candidate) => candidate.id === id);
  const gap = input.sourceGaps?.find((candidate) => candidate.source === section?.id);
  return (
    row?.status === "missing" &&
    row.periodEnd === anchorPeriodEnd(input, id) &&
    row.reason?.startsWith("stale ") === true &&
    gap?.triage === "material" &&
    gap.message.includes(row.reason) &&
    gap.message.includes(row.label)
  );
}

const REQUIRED_METRICS: Readonly<Record<string, readonly string[]>> = {
  Quality: [
    "grossMargin",
    "operatingMargin",
    "netMargin",
    "freeCashFlowProxy",
    "cashConversion",
    "roe",
    "roa",
  ],
  Growth: [
    "revenueDeltaPercent",
    "grossProfitDeltaPercent",
    "operatingIncomeDeltaPercent",
    "netIncomeDeltaPercent",
    "dilutedEpsDeltaPercent",
    "continuingIncomeDeltaPercent",
    "continuingDilutedEpsDeltaPercent",
    "operatingCashFlowDeltaPercent",
  ],
  "Financial Strength": [
    "cash",
    "debt",
    "netDebt",
    "debtToMarketCap",
    "netDebtToMarketCap",
    "currentRatio",
    "debtToEquity",
    "payoutRatio",
    "dividendYield",
  ],
  Value: ["pcfRatio"],
};

function requiresSection(input: ParityInput, name: string): boolean {
  const ids = REQUIRED_METRICS[name] ?? [];
  if (input.financialStatements !== undefined) {
    return ids.some((id) => {
      const first = id === "pcfRatio" ? "operatingCashFlow" : LENS_METRIC_INPUTS[id]?.series[0];
      return first !== undefined && latest(input, first) !== undefined;
    });
  }
  const metrics = input.extendedEvidence?.items.find(
    (item) => item.category === "sec-edgar" && item.metrics !== undefined,
  )?.metrics;
  return ids.some((id) => {
    if (id === "pcfRatio") {
      return (
        typeof metrics?.operatingCashFlow === "number" &&
        metrics.operatingCashFlow !== 0 &&
        (input.marketSnapshots.some((snapshot) => snapshot.marketCap !== undefined) ||
          input.extendedEvidence?.items.some(
            (item) => item.category === "valuation" && typeof item.metrics?.marketCap === "number",
          ) === true)
      );
    }
    const keys = (LEGACY_INPUT_KEYS[id] ?? [])
      .filter((key) => key.category === "sec-edgar")
      .map((key) => key.key);
    if (keys.some((key) => typeof metrics?.[key] === "number")) {
      return true;
    }
    const spec = LENS_METRIC_INPUTS[id];
    if (spec?.kind === "endpoint" || metrics?.financialLensSelectionVersion !== undefined) {
      return false;
    }
    const rawKeys =
      spec?.series.map((key) =>
        key === "capitalExpenditure" ? "capex" : key === "totalAssets" ? "assets" : key,
      ) ?? [];
    const values = rawKeys.map((key) => metrics?.[key]);
    return (
      values.length > 0 &&
      values.every((value) => typeof value === "number") &&
      (values.length === 1 || values[1] !== 0)
    );
  });
}

function assertSectionCoverage(input: ParityInput, artifact: FinancialLensArtifact): void {
  for (const name of LENSES) {
    if (!requiresSection(input, name)) {
      continue;
    }
    const section = input.metricSections?.find(
      (candidate) => candidate.id === LENS_SECTION_IDS[name],
    );
    if (section === undefined || section.metrics.length === 0) {
      throw new Error(`parity gate needs the ${name} Metric Section`);
    }
    for (const id of REQUIRED_METRICS[name] ?? []) {
      if (!section.metrics.some((row) => row.id === id)) {
        throw new Error(`parity gate needs ${name}.${id} in its Metric Section`);
      }
    }
    for (const row of artifact.lenses.find((lens) => lens.name === name)?.metrics ?? []) {
      const metric = section.metrics.find((candidate) => candidate.id === row.key);
      if (
        metric?.status !== "value" ||
        !sameValue(metric.value, row.value) ||
        metric.periodEnd !== row.periodEnd ||
        JSON.stringify(metric.sourceIds) !== JSON.stringify(row.sourceIds)
      ) {
        throw new Error(`parity gate needs ${name}.${row.key} section-to-projection coverage`);
      }
    }
  }
}

function filedCurrencies(input: ParityInput, metricId: string): readonly string[] {
  const spec = LENS_METRIC_INPUTS[metricId];
  const key = spec?.series[0];
  const metric = input.financialLenses?.lenses
    .flatMap((lens) => lens.metrics)
    .find((row) => row.key === metricId);
  if (key === undefined || metric?.periodEnd === undefined) {
    return [];
  }
  return facts(input, key).flatMap((fact) =>
    fact.periodEnd === metric.periodEnd && fact.currency !== null ? [fact.currency] : [],
  );
}

function derivedFromWaived(
  command: InstrumentCommand,
  input: ParityInput,
  waived: readonly Waiver[],
  waiver: Waiver,
): boolean {
  const evidence = input.extendedEvidence;
  if (evidence === undefined) {
    return false;
  }
  const explaining = waived.filter((other) => {
    const parts = metricKeyParts(other.key);
    return (
      other.fixture === waiver.fixture &&
      parts !== undefined &&
      LEGACY_INPUT_KEYS[parts.metricId] !== undefined &&
      (["D1", "D2", "D4", "D6"].includes(other.class) ||
        (other.class === "D8" && parts.field === "value"))
    );
  });
  if (explaining.length === 0) {
    return false;
  }
  const patched = patchEvidence(evidence, explaining);
  const diffs = financialLensParityDiffs(command, input, patched);
  if (!diffs.some(({ key }) => key === waiver.key)) {
    return true;
  }
  const summary = diffs.find(({ key }) => key === "item.summary");
  return (
    waiver.key === "item.summary" &&
    summary !== undefined &&
    summaryDiffersOnlyInFiledCurrency(summary, waived)
  );
}

function byKey<T extends { readonly key: string }>(rows: readonly T[]): readonly T[] {
  return [...rows].toSorted((left, right) => left.key.localeCompare(right.key));
}

export function expectFinancialLensParity(
  fixture: string,
  command: InstrumentCommand,
  input: ParityInput,
  waivers: readonly Waiver[],
): void {
  const waived = waivers.filter((waiver) => waiver.fixture === fixture);
  const diffs = financialLensParityDiffs(command, input);
  expect(byKey(diffs), `${fixture} lens differences are exactly the waived ones`).toEqual(
    byKey(waived.map(({ key, old, new: next }) => ({ key, old, new: next }))),
  );
  for (const waiver of waived) {
    expect(
      waiverPreconditionHolds(command, input, waiver, waived),
      `${fixture} ${waiver.key}: ${waiver.class} precondition holds`,
    ).toBe(true);
  }
}
