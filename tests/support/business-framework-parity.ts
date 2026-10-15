import { expect } from "bun:test";
import type { InstrumentCommand } from "../../src/cli/args";
import type { ExtendedEvidence } from "../../src/domain/evidence";
import type { BusinessFrameworkSectionName } from "../../src/sources/extended-evidence/business-framework";
import {
  legacyBusinessFrameworkEvidence,
  type LegacyOverrides,
} from "../../src/sources/extended-evidence/business-framework-legacy";
import { businessFrameworkMetricSectionId } from "../../src/sources/extended-evidence/business-framework-metrics";
import { currentRatioIsCurrent } from "../../src/sources/extended-evidence/financial-lens-builders";
import {
  itemByCategory,
  secFundamentalItem,
} from "../../src/sources/extended-evidence/financial-lens-metrics";
import {
  financialStatementFacts,
  financialStatementSeriesByKey,
  isYearAligned,
  latestFinancialStatementFact,
} from "../../src/sources/extended-evidence/financial-statement-selection";
import type {
  FinancialStatementFact,
  FinancialStatementSeriesKey,
} from "../../src/sources/extended-evidence/financial-statements-contract";
import { SEC_METRIC_DEFINITIONS } from "../../src/sources/extended-evidence/sec-edgar";
import { readNumberMetric } from "../../src/sources/extended-evidence/utils";
import type { CollectedSources } from "../../src/sources/types";

// D1-D5 are the metric-engine plan §4 classes; D6 is the one this phase adds (see build-p5).
export type WaiverClass = "D1" | "D2" | "D3" | "D4" | "D5" | "D6";

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
  | "businessFramework"
  | "metricSections"
  | "marketSnapshots"
  | "verifiedMarketSnapshot"
  | "financialStatements"
>;

interface Gate {
  readonly command: InstrumentCommand;
  readonly input: ParityInput;
  readonly diffs: readonly ParityDiff[];
}

type Value = number | string | undefined;

const SECTION_COUNT = 7;
const METRIC_SECTION_NAMES: readonly BusinessFrameworkSectionName[] = [
  "Business",
  "Phase",
  "Moat",
  "Growth",
  "Risk",
  "Valuation",
];
const AMOUNTS: Readonly<Record<string, FinancialStatementSeriesKey>> = {
  revenue: "revenue",
  grossProfit: "grossProfit",
  operatingIncome: "operatingIncome",
};
const YOY: Readonly<Record<string, FinancialStatementSeriesKey>> = {
  revenueDeltaPercent: "revenue",
  operatingIncomeDeltaPercent: "operatingIncome",
  netIncomeDeltaPercent: "netIncome",
};
const SEC_ONLY_AMOUNTS = new Set([...Object.keys(AMOUNTS), "shareRepurchases"]);
const MARGINS: Readonly<
  Record<string, readonly [FinancialStatementSeriesKey, FinancialStatementSeriesKey]>
> = {
  grossMargin: ["grossProfit", "revenue"],
  operatingMargin: ["operatingIncome", "revenue"],
};

function sameValue(left: unknown, right: unknown): boolean {
  return typeof left === "number" && typeof right === "number"
    ? Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left))
    : left === right;
}

function gapCode(gap: unknown): unknown {
  return typeof gap === "string" ? gap : (gap as { code?: string }).code;
}

function facts(input: ParityInput, key: FinancialStatementSeriesKey) {
  const series =
    input.financialStatements === undefined
      ? undefined
      : financialStatementSeriesByKey(input.financialStatements, key);
  return series === undefined ? [] : financialStatementFacts(series);
}

function aligned(fact: FinancialStatementFact): boolean {
  return fact.periodStart !== undefined && isYearAligned(fact.periodStart, fact.periodEnd);
}

function eligible(input: ParityInput, key: FinancialStatementSeriesKey) {
  return facts(input, key).filter((fact) => fact.periodType === "interim" || aligned(fact));
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

function ratioOf(
  numerator: FinancialStatementFact,
  denominator: FinancialStatementFact | undefined,
) {
  return denominator !== undefined && denominator.value > 0
    ? numerator.value / denominator.value
    : undefined;
}

// Independent of the rebuilt module: R1 eligibility and the exact-period join, re-derived here.
function recomputed(input: ParityInput, metricKey: string): Value {
  const amount = AMOUNTS[metricKey];
  if (amount !== undefined) {
    return latestFinancialStatementFact(eligible(input, amount))?.value;
  }
  const [numerator, denominator] = MARGINS[metricKey] ?? [];
  const anchor =
    numerator === undefined ? undefined : latestFinancialStatementFact(eligible(input, numerator));
  return anchor === undefined || denominator === undefined
    ? undefined
    : ratioOf(anchor, samePeriod(input, anchor, denominator));
}

function subjectQuoteCurrency({ command, input }: Gate): string {
  const symbol = command.symbol.toUpperCase();
  const snapshot = input.marketSnapshots.find(
    (candidate) =>
      candidate.assetClass === command.assetClass && candidate.symbol.toUpperCase() === symbol,
  );
  return snapshot?.identity?.quoteCurrency ?? "USD";
}

function metricRow(input: ParityInput, section: string, metricKey: string) {
  return input.metricSections
    ?.find(
      ({ id }) => id === businessFrameworkMetricSectionId(section as BusinessFrameworkSectionName),
    )
    ?.metrics.find(({ id }) => id === metricKey);
}

function yoyOf(latest: FinancialStatementFact, prior: FinancialStatementFact): number | undefined {
  return prior.value === 0
    ? undefined
    : ((latest.value - prior.value) / Math.abs(prior.value)) * 100;
}

// D1 for YoY: a pair with a misaligned annual fact produced the old value; the new one compares
// The latest annual fact only with a year-aligned annual prior ending about a year earlier.
function d1YearOverYear(input: ParityInput, series: FinancialStatementSeriesKey, diff: ParityDiff) {
  const annual = facts(input, series).filter((fact) => fact.periodType === "annual");
  const latest = latestFinancialStatementFact(eligible(input, series));
  if (latest?.periodType !== "annual") {
    return false;
  }
  const oldFromMisaligned = annual.some((end) =>
    annual.some(
      (start) =>
        start.periodEnd < end.periodEnd &&
        !(aligned(start) && aligned(end)) &&
        sameValue(yoyOf(end, start), diff.old),
    ),
  );
  const priors = annual.filter(
    (prior) => aligned(prior) && isYearAligned(prior.periodEnd, latest.periodEnd),
  );
  const newRederived =
    diff.new === undefined
      ? priors.length === 0
      : priors.some((prior) => sameValue(yoyOf(latest, prior), diff.new));
  return oldFromMisaligned && newRederived;
}

// D1: a non-year-aligned annual fact produced the old value; the new one is the R1-eligible fact.
function d1(gate: Gate, _section: string, metricKey: string, diff: ParityDiff): boolean {
  const { input } = gate;
  const yoySeries = YOY[metricKey];
  if (yoySeries !== undefined) {
    return d1YearOverYear(input, yoySeries, diff);
  }
  if (!(metricKey in AMOUNTS || metricKey in MARGINS)) {
    return false;
  }
  const misaligned = (fact: FinancialStatementFact) =>
    fact.periodType === "annual" && !aligned(fact);
  const amount = AMOUNTS[metricKey];
  const [numerator, denominator] = MARGINS[metricKey] ?? [];
  const oldFromMisaligned =
    amount !== undefined
      ? facts(input, amount).some((fact) => misaligned(fact) && sameValue(fact.value, diff.old))
      : numerator !== undefined &&
        denominator !== undefined &&
        facts(input, numerator).some(
          (fact) =>
            misaligned(fact) &&
            facts(input, denominator).some(
              (base) =>
                base.periodKey === fact.periodKey && sameValue(ratioOf(fact, base), diff.old),
            ),
        );
  return oldFromMisaligned && sameValue(diff.new, recomputed(input, metricKey));
}

// D2: the latest numerator has no same-period denominator; the old value joined an older period.
function d2(gate: Gate, _section: string, metricKey: string, diff: ParityDiff): boolean {
  const { input } = gate;
  const [numerator, denominator] = MARGINS[metricKey] ?? [];
  if (numerator === undefined || denominator === undefined || diff.new !== undefined) {
    return false;
  }
  const anchor = latestFinancialStatementFact(eligible(input, numerator));
  return (
    anchor !== undefined &&
    samePeriod(input, anchor, denominator) === undefined &&
    eligible(input, numerator).some(
      (fact) =>
        fact.periodEnd < anchor.periodEnd &&
        sameValue(ratioOf(fact, samePeriod(input, fact, denominator)), diff.old),
    )
  );
}

// D4: the lens ratio the old builder labelled historical is stale at the framework's as-of date.
function d4(gate: Gate, section: string, metricKey: string, diff: ParityDiff): boolean {
  const evidence = gate.input.extendedEvidence;
  const generatedAt = gate.input.businessFramework?.generatedAt ?? "";
  return (
    section === "Risk" &&
    metricKey === "currentRatio" &&
    diff.new === undefined &&
    sameValue(
      readNumberMetric(itemByCategory(evidence, "financial-lens")?.metrics, "currentRatio"),
      diff.old,
    ) &&
    !currentRatioIsCurrent(secFundamentalItem(evidence), generatedAt)
  );
}

// Without statements the SEC summary is the filed source, read only in its definition's unit.
function secSummaryFiled(input: ParityInput, metricKey: string) {
  const value = readNumberMetric(
    itemByCategory(input.extendedEvidence, "sec-edgar")?.metrics,
    metricKey,
  );
  const currency = SEC_METRIC_DEFINITIONS.find(({ key }) => key === metricKey)?.unitKeys[0];
  return value === undefined || currency === undefined || !SEC_ONLY_AMOUNTS.has(metricKey)
    ? undefined
    : { value, currency };
}

// D6: the amount is unchanged; only its label moves from the quote currency to the filed one.
function d6(gate: Gate, section: string, metricKey: string, diff: ParityDiff): boolean {
  const amount = AMOUNTS[metricKey];
  const fact =
    gate.input.financialStatements === undefined
      ? secSummaryFiled(gate.input, metricKey)
      : amount === undefined
        ? undefined
        : latestFinancialStatementFact(eligible(gate.input, amount));
  const row = metricRow(gate.input, section, metricKey);
  return (
    fact !== undefined &&
    diff.old === subjectQuoteCurrency(gate) &&
    diff.new === fact.currency &&
    row?.status === "value" &&
    sameValue(row.value, fact.value) &&
    !gate.diffs.some(({ key }) => key === `${section}.${metricKey}`)
  );
}

type MetricCheck = (gate: Gate, section: string, metricKey: string, diff: ParityDiff) => boolean;

const VALUE_CHECKS: Partial<Record<WaiverClass, MetricCheck>> = { D1: d1, D2: d2, D4: d4 };
const DERIVED_FROM: Readonly<Record<WaiverClass, readonly WaiverClass[]>> = {
  D1: ["D1"],
  D2: ["D2"],
  D3: [],
  D4: ["D4"],
  D5: ["D1", "D2", "D3"],
  D6: ["D6"],
};

function metricKeyParts(
  key: string,
): { section: string; metricKey: string; currency: boolean } | undefined {
  const match = /^([A-Z][a-z]+)\.([A-Za-z]+)(\.currency)?$/u.exec(key);
  if (
    match === null ||
    ["summary", "posture", "sourceIds", "gaps", "phase"].includes(match[2] ?? "")
  ) {
    return undefined;
  }
  return { section: match[1] ?? "", metricKey: match[2] ?? "", currency: match[3] !== undefined };
}

function overridesFrom(
  waivers: readonly Waiver[],
  classes: readonly WaiverClass[],
): LegacyOverrides {
  const values: Record<string, number | undefined> = {};
  const currencies: Record<string, string> = {};
  for (const waiver of waivers) {
    const parts = metricKeyParts(waiver.key);
    if (parts === undefined || !classes.includes(waiver.class)) {
      continue;
    }
    if (parts.currency && typeof waiver.new === "string") {
      currencies[parts.metricKey] = waiver.new;
    } else if (!parts.currency && (waiver.new === undefined || typeof waiver.new === "number")) {
      values[parts.metricKey] = waiver.new;
    }
  }
  return { values, currencies };
}

export function waiverPreconditionHolds(
  command: InstrumentCommand,
  input: ParityInput,
  waiver: Waiver,
  waived: readonly Waiver[],
): boolean {
  const gate: Gate = { command, input, diffs: businessFrameworkParityDiffs(command, input) };
  const parts = metricKeyParts(waiver.key);
  if (parts !== undefined) {
    const check = parts.currency
      ? waiver.class === "D6"
        ? d6
        : undefined
      : VALUE_CHECKS[waiver.class];
    return check?.(gate, parts.section, parts.metricKey, waiver) ?? false;
  }
  // Summaries, postures and item metrics: the old builder fed the waived metrics must reproduce them.
  const classes = DERIVED_FROM[waiver.class];
  const explaining = waived.filter(
    (other) => metricKeyParts(other.key) !== undefined && classes.includes(other.class),
  );
  return (
    explaining.length > 0 &&
    !businessFrameworkParityDiffs(
      gate.command,
      gate.input,
      overridesFrom(explaining, classes),
    ).some(({ key }) => key === waiver.key)
  );
}

// Old builder over the evidence the new one saw vs the rebuilt framework, per projection key.
export function businessFrameworkParityDiffs(
  command: InstrumentCommand,
  input: ParityInput,
  overrides: LegacyOverrides = {},
): readonly ParityDiff[] {
  const evidence = input.extendedEvidence;
  const framework = input.businessFramework;
  if (evidence === undefined || framework === undefined) {
    throw new Error("parity gate needs Extended Evidence and a Business Framework");
  }
  const before: ExtendedEvidence = {
    ...evidence,
    items: evidence.items.filter(({ category }) => category !== "business-framework"),
  };
  const old = legacyBusinessFrameworkEvidence(
    command,
    input.marketSnapshots,
    before,
    input.verifiedMarketSnapshot,
    framework.generatedAt,
    overrides,
  );
  const oldItem = old.extendedEvidence?.items.find(
    ({ category }) => category === "business-framework",
  );
  const newItem = evidence.items.find(({ category }) => category === "business-framework");
  const oldSections = old.artifact?.sections ?? [];
  if (oldItem === undefined || newItem === undefined) {
    throw new Error("both builders must emit a business-framework evidence item");
  }
  if (oldSections.length !== SECTION_COUNT || framework.sections.length !== SECTION_COUNT) {
    throw new Error(`both frameworks must carry ${SECTION_COUNT} sections`);
  }
  for (const name of METRIC_SECTION_NAMES) {
    const id = businessFrameworkMetricSectionId(name);
    const section = framework.sections.find((candidate) => candidate.name === name);
    if (
      !input.metricSections?.some((candidate) => candidate.id === id) ||
      !section?.metricSectionIds.includes(id)
    ) {
      throw new Error(`${name} must reference Metric Section ${id}`);
    }
  }
  const resolved = new Set<unknown>(framework.reconciliation?.resolvedGaps ?? []);
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
  for (const oldSection of oldSections) {
    const { name } = oldSection;
    const newSection = framework.sections.find((section) => section.name === name);
    compare(`${name}.summary`, oldSection.summary, newSection?.summary);
    compare(`${name}.posture`, oldSection.posture, newSection?.posture);
    compare(`${name}.sourceIds`, oldSection.sourceIds, newSection?.sourceIds);
    // Web reconciliation runs after both builders; it only drops resolved gap codes.
    compare(
      `${name}.gaps`,
      oldSection.gaps.filter((gap) => !resolved.has(gapCode(gap))),
      newSection?.gaps,
    );
    const section = input.metricSections?.find(
      ({ id }) => id === businessFrameworkMetricSectionId(name),
    );
    const rows = new Map(
      (section?.metrics ?? []).flatMap((metric) =>
        metric.status === "value" ? [[metric.id, metric] as const] : [],
      ),
    );
    for (const key of new Set([
      ...oldSection.metrics.map((metric) => metric.key),
      ...rows.keys(),
    ])) {
      const left = oldSection.metrics.find((metric) => metric.key === key);
      const right = rows.get(key);
      const path = `${name}.${key}`;
      if (left === undefined || right === undefined || !sameValue(left.value, right.value)) {
        compare(path, left?.value, right?.value);
      }
      if (left !== undefined && right !== undefined) {
        compare(`${path}.label`, left.label, right.label);
        compare(`${path}.unit`, left.unit, right.unit);
        compare(`${path}.currency`, left.currency, right.currency);
      }
    }
  }
  return diffs;
}

export function expectBusinessFrameworkParity(
  fixture: string,
  command: InstrumentCommand,
  input: ParityInput,
  waivers: readonly Waiver[],
): void {
  const waived = waivers.filter((waiver) => waiver.fixture === fixture);
  const diffs = businessFrameworkParityDiffs(command, input);
  expect(diffs, `${fixture} framework differences are exactly the waived ones`).toEqual(
    waived.map(({ key, old, new: next }) => ({ key, old, new: next })),
  );
  for (const waiver of waived) {
    expect(
      waiverPreconditionHolds(command, input, waiver, waived),
      `${fixture} ${waiver.key}: ${waiver.class} precondition holds`,
    ).toBe(true);
  }
}
