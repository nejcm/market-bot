import { isRecord } from "../src/guards";
import { deriveCapitalOwnershipArtifact } from "../src/sources/extended-evidence/capital-ownership";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import type { SecProviderResult } from "../src/sources/extended-evidence/sec-edgar";
import {
  deriveSubsequentFinancingBridge,
  withSubsequentFinancingEvidence,
} from "../src/sources/extended-evidence/subsequent-financing";
import { balanceSheetHistory, financialPosition } from "../src/report/equity-reader-statements";
import { capitalReturnSection } from "../src/sources/extended-evidence/capital-return";
import { financialLensMetrics } from "../src/sources/extended-evidence/financial-lens-sections";
import { financialStatementSeries } from "../src/sources/extended-evidence/financial-statement-selection";
import type {
  FinancialStatementFact,
  FinancialStatementNote,
  FinancialStatementsArtifact,
} from "../src/sources/extended-evidence/financial-statements-contract";
import {
  depositoryIssuerSic,
  secIssuerRegistration,
} from "../src/sources/extended-evidence/industry-classification";
import type { MetricContext, MetricResult } from "../src/sources/extended-evidence/metric-engine";
import { operatingRatiosSection } from "../src/sources/extended-evidence/operating-ratios";
import { withheldDebt } from "../src/sources/extended-evidence/sec-debt";
import {
  valuationPeriodInputs,
  type ValuationPeriodInputs,
} from "../src/sources/extended-evidence/valuation-workbench-inputs";

type LedgerStatus = "published" | "withheld" | "not-meaningful" | "not-applicable" | "missing";

export interface LedgerRow {
  readonly cik: string;
  readonly symbol: string;
  readonly metric: string;
  readonly period: string;
  readonly status: LedgerStatus;
  readonly value: number | string | null;
  readonly unit: string | null;
  readonly currency: string | null;
  readonly reason: string | null;
  readonly accession: string | null;
  readonly firstPublicAt: string | null;
  readonly detail: string | null;
}

type RowFields = Omit<LedgerRow, "cik" | "symbol" | "metric" | "period">;

const EMPTY: RowFields = {
  status: "missing",
  value: null,
  unit: null,
  currency: null,
  reason: null,
  accession: null,
  firstPublicAt: null,
  detail: null,
};

const VALUATION_INPUTS = [
  "revenue",
  "netIncome",
  "dilutedEps",
  "dilutedShares",
  "operatingCashFlow",
  "capitalExpenditure",
  "freeCashFlow",
  "cash",
  "debt",
  "enterpriseValueBridge",
] as const;

const VALUATION_FLAGS = [
  "enterpriseValueBridgeIncomplete",
  "debtScopeMismatch",
  "debtScopeUnproven",
  "debtBehindIncompleteInstant",
] as const;

function joined(values: readonly (string | undefined)[]): string | null {
  const present = [...new Set(values.filter((value) => value !== undefined && value !== ""))];
  return present.length === 0 ? null : present.toSorted().join("; ");
}

function factFields(fact: FinancialStatementFact, notes: readonly string[]): RowFields {
  return {
    status: "published",
    value: fact.value,
    unit: fact.unit,
    currency: fact.currency,
    reason: joined(notes),
    accession: fact.accessionNumber,
    firstPublicAt: fact.firstPublicAt,
    detail: joined([
      fact.concept,
      fact.composite === undefined ? undefined : "composite",
      fact.zeroBorrowingsProof && `zeroBorrowingsProof=${fact.zeroBorrowingsProof}`,
      fact.shortTermInvestmentsProof &&
        `shortTermInvestmentsProof=${fact.shortTermInvestmentsProof}`,
      fact.shortTermInvestmentsWithheld &&
        `shortTermInvestmentsWithheld=${fact.shortTermInvestmentsWithheld}`,
    ]),
  };
}

function metricFields(metric: MetricResult): RowFields {
  return {
    ...EMPTY,
    status: metric.status === "value" ? "published" : metric.status,
    value: metric.value ?? null,
    unit: metric.unit,
    currency: metric.currency ?? null,
    reason: metric.reason ?? null,
    detail: metric.basis,
  };
}

function noteCodes(notes: readonly FinancialStatementNote[]): readonly string[] {
  return notes.map((note) =>
    note.reason === undefined ? note.code : `${note.code}: ${note.reason}`,
  );
}

function statementRows(
  artifact: FinancialStatementsArtifact,
  push: (metric: string, period: string, fields: RowFields) => void,
): void {
  // Selection bookkeeping, not a withhold: those periods sit outside the kept history window.
  const notes = [...artifact.validationNotes, ...artifact.omissionNotes].filter(
    ({ code }) => code !== "duplicate-superseded" && code !== "history-cap",
  );
  for (const series of financialStatementSeries(artifact)) {
    const metric = `statement.${series.key}`;
    const seriesNotes = notes.filter((note) => note.seriesKey === series.key);
    const facts = [...series.annual, ...series.interim];
    const factKeys = new Set(facts.map((fact) => fact.periodKey));
    const seriesLevel = seriesNotes.filter((note) => note.periodKey === undefined);
    push(metric, "series", {
      ...EMPTY,
      status: facts.length > 0 ? "published" : seriesNotes.length > 0 ? "withheld" : "missing",
      reason: joined(noteCodes(seriesLevel)),
    });
    const used = new Set<string>();
    for (const fact of facts) {
      const period = used.has(fact.periodKey)
        ? `${fact.periodType}|${fact.periodKey}`
        : fact.periodKey;
      used.add(fact.periodKey);
      push(
        metric,
        period,
        factFields(
          fact,
          noteCodes(seriesNotes.filter((note) => note.periodKey === fact.periodKey)),
        ),
      );
    }
    const withheldKeys = new Set(
      seriesNotes.flatMap(({ periodKey }) =>
        periodKey === undefined || factKeys.has(periodKey) ? [] : [periodKey],
      ),
    );
    for (const period of withheldKeys) {
      const periodNotes = seriesNotes.filter((note) => note.periodKey === period);
      push(metric, period, {
        ...EMPTY,
        status: "withheld",
        reason: joined(noteCodes(periodNotes)),
        firstPublicAt: joined(periodNotes.map((note) => note.publicAt)),
        accession: joined(periodNotes.map((note) => note.faceAccession)),
      });
    }
    if (series.ttm !== undefined) {
      const { ttm } = series;
      const components = Object.values(ttm.components);
      push(metric, `ttm|${ttm.periodStart}|${ttm.periodEnd}`, {
        ...EMPTY,
        status: "published",
        value: ttm.value,
        unit: ttm.unit,
        currency: ttm.currency,
        accession: joined(components.map((fact) => fact.accessionNumber ?? undefined)),
        firstPublicAt:
          components
            .map((fact) => fact.firstPublicAt)
            .toSorted()
            .at(-1) ?? null,
        detail: ttm.formula,
      });
    }
  }
}

function readerRows(
  artifact: FinancialStatementsArtifact,
  push: (metric: string, period: string, fields: RowFields) => void,
): void {
  const position = financialPosition(artifact, undefined);
  const withheld = withheldDebt(artifact);
  for (const key of ["cash", "debt", "dilutedShares"] as const) {
    const value = position?.[key];
    if (value !== undefined) {
      push(`position.${key}`, value.periodEnd, {
        ...EMPTY,
        status: "published",
        value: value.value,
        unit: value.unit,
        currency: position?.reportingCurrency ?? null,
        detail: joined([
          `filedAt=${value.filedAt}`,
          value.zeroBorrowingsProof && `zeroBorrowingsProof=${value.zeroBorrowingsProof}`,
        ]),
      });
    } else if (key === "debt" && withheld !== undefined) {
      push("position.debt", withheld.periodEnd, {
        ...EMPTY,
        status: "withheld",
        reason: withheld.reason,
      });
    } else {
      push(`position.${key}`, "latest", EMPTY);
    }
  }
  const history = balanceSheetHistory(artifact, undefined);
  for (const row of history?.rows ?? []) {
    const periodEnd = /\d{4}-\d{2}-\d{2}/u.exec(row.period)?.[0] ?? row.period;
    const rowNotes = (history?.notes ?? []).filter(
      (note) =>
        note.periodKey === `instant|${periodEnd}` ||
        note.periods?.some(({ end }) => end === periodEnd) === true,
    );
    for (const key of ["cash", "debt", "dilutedShares"] as const) {
      const value = row[key];
      push(
        `balanceSheet.${key}`,
        periodEnd,
        value === undefined
          ? {
              ...EMPTY,
              status: key === "debt" && rowNotes.length > 0 ? "withheld" : "missing",
              reason: key === "debt" ? joined(noteCodes(rowNotes)) : null,
            }
          : {
              ...EMPTY,
              status: "published",
              value: value.value,
              unit: value.unit,
              currency: history?.reportingCurrency ?? null,
              detail: joined([
                `filedAt=${value.filedAt}`,
                value.zeroBorrowingsProof && `zeroBorrowingsProof=${value.zeroBorrowingsProof}`,
              ]),
            },
      );
    }
  }
}

function valuationRows(
  periods: readonly ValuationPeriodInputs[],
  push: (metric: string, period: string, fields: RowFields) => void,
): void {
  for (const inputs of periods) {
    const period = `${inputs.basis}|${inputs.periodEnd}`;
    const flags = joined(VALUATION_FLAGS.filter((flag) => inputs[flag] === true));
    for (const key of VALUATION_INPUTS) {
      const input = inputs[key];
      if (input === undefined) {
        push(`valuation.${key}`, period, { ...EMPTY, reason: flags });
        continue;
      }
      push(`valuation.${key}`, period, {
        ...EMPTY,
        status: "published",
        value: input.value,
        unit: input.unit,
        currency: input.currency,
        reason: flags,
        firstPublicAt: input.publicAt,
        detail: joined([input.label, input.derivation]),
      });
    }
    for (const component of inputs.enterpriseValueBridge?.lineage ?? []) {
      push(`valuation.enterpriseValueBridge.${component.label}`, period, {
        ...EMPTY,
        status: "published",
        value: component.value,
        unit: component.unit ?? null,
        currency: component.currency ?? null,
        detail: joined([component.key, component.periodEnd]),
      });
    }
  }
}

function sortRows(rows: readonly LedgerRow[]): readonly LedgerRow[] {
  return rows.toSorted(
    (left, right) =>
      left.cik.localeCompare(right.cik) ||
      left.metric.localeCompare(right.metric) ||
      left.period.localeCompare(right.period),
  );
}

// Every row a run would publish from these statements, through the run path's own metric chain.
export function secValueLedgerRows(input: {
  readonly cik: string;
  readonly symbol: string;
  readonly statements: FinancialStatementsArtifact;
  readonly companyFacts: unknown;
  readonly sec: SecProviderResult;
  readonly asOf: string;
}): readonly LedgerRow[] {
  const { cik, symbol, statements } = input;
  const rows = new Map<string, LedgerRow>();
  const push = (metric: string, period: string, fields: RowFields) => {
    let key = period;
    for (let index = 2; rows.has(`${metric}\n${key}`); index += 1) {
      key = `${period}#${index}`;
    }
    rows.set(`${metric}\n${key}`, { cik, symbol, metric, period: key, ...fields });
  };
  push(CUTOFF_METRIC, "-", {
    status: "published",
    value: input.asOf,
    unit: null,
    currency: null,
    reason: null,
    accession: null,
    firstPublicAt: null,
    detail: null,
  });
  statementRows(statements, push);
  readerRows(statements, push);
  valuationRows(valuationPeriodInputs(statements).periods, push);
  const subsequentFinancing = deriveSubsequentFinancingBridge(input.companyFacts, statements);
  const capitalOwnership = deriveCapitalOwnershipArtifact(
    input.companyFacts,
    statements,
    subsequentFinancing,
  );
  const evidence = withSubsequentFinancingEvidence(
    withCanonicalFinancialLensInputs(
      { items: input.sec.items.map(({ item }) => item), gaps: input.sec.gaps },
      statements,
      input.sec.sicClassification,
    ),
    subsequentFinancing,
  );
  const depositorySic = depositoryIssuerSic(evidence);
  const secIssuer = secIssuerRegistration(evidence);
  const lensContext: MetricContext = {
    symbol,
    statements,
    ...(evidence === undefined ? {} : { evidence }),
    asOf: input.asOf,
    ...(subsequentFinancing === undefined ? {} : { subsequentFinancing }),
  };
  const sections = [
    [
      "ratio",
      operatingRatiosSection({
        symbol,
        statements,
        ...(depositorySic === undefined ? {} : { depositorySic }),
        ...(secIssuer === undefined ? {} : { secIssuer }),
      }).section.metrics,
    ],
    [
      "capitalReturn",
      capitalReturnSection({
        symbol,
        statements,
        capitalOwnership,
        ...(depositorySic === undefined ? {} : { depositorySic }),
      }).section.metrics,
    ],
    ...Object.entries(financialLensMetrics(lensContext).lensMetrics).map(
      ([lens, metrics]) => [`lens.${lens}`, metrics] as const,
    ),
  ] as const;
  for (const [prefix, metrics] of sections) {
    for (const metric of metrics) {
      push(`${prefix}.${metric.id}`, metric.periodEnd ?? "latest", metricFields(metric));
    }
  }
  return sortRows([...rows.values()]);
}

const CUTOFF_METRIC = "cutoff";

type TransitionKind =
  | "cutoff changed"
  | "value changed"
  | "withheld→published"
  | "published→withheld"
  | "reason changed"
  | "provenance changed"
  | "row added"
  | "row removed";

const TRANSITION_ORDER: readonly TransitionKind[] = [
  "cutoff changed",
  "value changed",
  "withheld→published",
  "published→withheld",
  "reason changed",
  "provenance changed",
  "row added",
  "row removed",
];

interface LedgerTransition {
  readonly kind: TransitionKind;
  readonly before?: LedgerRow;
  readonly after?: LedgerRow;
}

function rowKey(row: LedgerRow): string {
  return `${row.cik}\n${row.metric}\n${row.period}`;
}

function transitionKind(before: LedgerRow, after: LedgerRow): TransitionKind | undefined {
  // A later cache day moves the freshness cutoff, so the CIK's other transitions may be input drift.
  if (before.metric === CUTOFF_METRIC && before.value !== after.value) {
    return "cutoff changed";
  }
  const published = [before.status === "published", after.status === "published"];
  if (published[0] !== published[1]) {
    return published[1] ? "withheld→published" : "published→withheld";
  }
  if (before.value !== after.value || before.unit !== after.unit) {
    return "value changed";
  }
  if (before.status !== after.status || before.reason !== after.reason) {
    return "reason changed";
  }
  return PROVENANCE_FIELDS.some((field) => before[field] !== after[field])
    ? "provenance changed"
    : undefined;
}

const PROVENANCE_FIELDS = ["symbol", "currency", "accession", "firstPublicAt", "detail"] as const;

function keyedRows(rows: readonly LedgerRow[], side: string): Map<string, LedgerRow> {
  const keyed = new Map<string, LedgerRow>();
  for (const row of rows) {
    const key = rowKey(row);
    if (keyed.has(key)) {
      throw new Error(`${side} ledger has duplicate row ${key.replaceAll("\n", " ")}`);
    }
    keyed.set(key, row);
  }
  return keyed;
}

export function diffLedgers(
  baseline: readonly LedgerRow[],
  current: readonly LedgerRow[],
): readonly LedgerTransition[] {
  const before = keyedRows(baseline, "Baseline");
  const after = keyedRows(current, "Current");
  const transitions: LedgerTransition[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].toSorted()) {
    const old = before.get(key);
    const next = after.get(key);
    const kind =
      old === undefined
        ? "row added"
        : next === undefined
          ? "row removed"
          : transitionKind(old, next);
    if (kind !== undefined) {
      transitions.push({
        kind,
        ...(old === undefined ? {} : { before: old }),
        ...(next === undefined ? {} : { after: next }),
      });
    }
  }
  return transitions;
}

function describe(row: LedgerRow | undefined): string {
  if (row === undefined) {
    return "(none)";
  }
  const value =
    row.value === null ? row.status : `${row.value}${row.unit === null ? "" : ` ${row.unit}`}`;
  return row.reason === null ? value : `${value} [${row.status}: ${row.reason}]`;
}

export function formatLedgerDiff(transitions: readonly LedgerTransition[]): string {
  const lines: string[] = [];
  for (const kind of TRANSITION_ORDER) {
    const group = transitions.filter((transition) => transition.kind === kind);
    if (group.length === 0) {
      continue;
    }
    lines.push(`${kind} (${group.length}):`);
    for (const { before, after } of group) {
      const row = (after ?? before)!;
      const change =
        kind === "provenance changed"
          ? PROVENANCE_FIELDS.filter((field) => before?.[field] !== after?.[field])
              .map(
                (field) =>
                  `${field} ${JSON.stringify(before?.[field])} -> ${JSON.stringify(after?.[field])}`,
              )
              .join("; ")
          : `${describe(before)} -> ${describe(after)}`;
      lines.push(`  ${row.symbol} (${row.cik}) ${row.metric} ${row.period}: ${change}`);
    }
  }
  const counts = TRANSITION_ORDER.map(
    (kind) => `${transitions.filter((transition) => transition.kind === kind).length} ${kind}`,
  );
  lines.push(`Ledger diff: ${transitions.length} transitions (${counts.join(", ")})`);
  return `${lines.join("\n")}\n`;
}

export function serializeLedger(rows: readonly LedgerRow[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

const LEDGER_STATUSES = new Set<unknown>([
  "published",
  "withheld",
  "not-meaningful",
  "not-applicable",
  "missing",
]);
const STRING_FIELDS = ["cik", "symbol", "metric", "period"] as const;
const NULLABLE_STRING_FIELDS = [
  "unit",
  "currency",
  "reason",
  "accession",
  "firstPublicAt",
  "detail",
] as const;

function isLedgerRow(value: unknown): value is LedgerRow {
  return (
    isRecord(value) &&
    STRING_FIELDS.every((field) => typeof value[field] === "string") &&
    NULLABLE_STRING_FIELDS.every(
      (field) => value[field] === null || typeof value[field] === "string",
    ) &&
    LEDGER_STATUSES.has(value.status) &&
    (value.value === null || typeof value.value === "number" || typeof value.value === "string")
  );
}

export function parseLedger(text: string): readonly LedgerRow[] {
  return text.split("\n").flatMap((line, index) => {
    if (line === "") {
      return [];
    }
    const row: unknown = JSON.parse(line);
    if (!isLedgerRow(row)) {
      throw new Error(`Ledger line ${index + 1} is not a ledger row: ${line}`);
    }
    return [row];
  });
}
