import type {
  FinancialStatementFact,
  FinancialStatementNote,
  FinancialStatementNotePeriod,
  FinancialStatementsArtifact,
} from "../sources/extended-evidence/financial-statements-contract";
import {
  financialStatementFacts,
  financialStatementSeriesByKey,
  isYearAlignedFact,
  latestFinancialStatementFact,
} from "../sources/extended-evidence/financial-statement-selection";
import { heldForSaleRecast, withheldDebt } from "../sources/extended-evidence/sec-debt";
import { formatLensValue } from "../sources/extended-evidence/value-format";
import { REIT_SIC } from "../sources/extended-evidence/industry-classification";
import { payoutScope, payoutScopeAmbiguity } from "../sources/extended-evidence/payout-basis";
import { formatRatioPercent } from "../sources/extended-evidence/percent-format";
import { SPECIAL_DIVIDENDS_BASIS } from "../sources/extended-evidence/financial-statement-definitions";
import { isFreshPeriodEnd, SEC_FRESHNESS_DAYS } from "../config/shared";

export interface LabeledPeriod {
  readonly kind: "annual" | "interim" | "ttm";
  readonly periodEnd: string;
  readonly filedAt: string;
}

interface EquityReaderStatementValue {
  readonly value: number;
  readonly filedAt: string;
  readonly unit: string;
  readonly unitScale: number;
  readonly sourceIds: readonly string[];
  readonly zeroBorrowingsProof?: string;
}

interface EquityReaderBalanceSheetRow {
  readonly period: string;
  readonly cash?: EquityReaderStatementValue;
  readonly debt?: EquityReaderStatementValue;
  readonly dilutedShares?: EquityReaderStatementValue;
}

export interface EquityReaderBalanceSheetHistory {
  readonly reportingCurrency?: string;
  readonly sourceIds: readonly string[];
  readonly notes?: readonly FinancialStatementNote[];
  readonly rows: readonly EquityReaderBalanceSheetRow[];
}

export const CAPITAL_RETURN_HISTORY_BASIS = `dividends paid ${SPECIAL_DIVIDENDS_BASIS}`;

type EquityReaderPayout =
  | { readonly status: "value"; readonly value: number }
  | { readonly status: "not-meaningful"; readonly reason: string }
  | { readonly status: "withheld" };

interface EquityReaderCapitalReturnRow {
  readonly period: string;
  readonly dividendsPaid?: EquityReaderStatementValue;
  readonly shareRepurchases?: EquityReaderStatementValue;
  readonly netIncome?: EquityReaderStatementValue;
  readonly payout?: EquityReaderPayout;
}

export interface EquityReaderCapitalReturnHistory {
  readonly reportingCurrency?: string;
  readonly sourceIds: readonly string[];
  readonly notes: readonly string[];
  readonly rows: readonly EquityReaderCapitalReturnRow[];
}

interface EquityReaderFinancialPositionValue extends EquityReaderStatementValue {
  readonly periodEnd: string;
}

export interface EquityReaderFinancialPosition {
  readonly reportingCurrency?: string;
  readonly cash?: EquityReaderFinancialPositionValue;
  readonly debt?: EquityReaderFinancialPositionValue;
  readonly dilutedShares?: EquityReaderFinancialPositionValue;
  readonly notes?: readonly FinancialStatementNote[];
}

export function periodLabel(period: LabeledPeriod): string {
  // The filed date is the latest filing that reported the period, not the first public date.
  if (period.kind === "ttm") {
    return `TTM (${period.periodEnd}; latest filed ${period.filedAt})`;
  }
  return `${period.kind === "annual" ? "FY" : "Interim"} ending ${period.periodEnd} (latest filed ${period.filedAt})`;
}

function uniqueSourceIds(sourceIds: readonly string[]): readonly string[] {
  return [...new Set(sourceIds)];
}

function observableStatementFact(fact: FinancialStatementFact, cutoff: string): boolean {
  return fact.periodEnd <= cutoff && fact.filedAt <= cutoff;
}

function statementValue(fact: FinancialStatementFact): EquityReaderStatementValue {
  return {
    value: fact.value,
    filedAt: fact.filedAt,
    unit: fact.unit,
    unitScale: fact.unitScale,
    sourceIds: fact.sourceIds,
    ...(fact.zeroBorrowingsProof === undefined
      ? {}
      : { zeroBorrowingsProof: fact.zeroBorrowingsProof }),
  };
}

function statementSurfaceNotes(
  artifact: FinancialStatementsArtifact,
  cutoff: string,
  recastPeriodKeys: readonly string[] = [],
  zeroProofPeriodKeys: readonly string[] = [],
): readonly FinancialStatementNote[] | undefined {
  if (artifact.omissionNotes === undefined && artifact.validationNotes === undefined) {
    return undefined;
  }
  const withheldDebtKey = `instant|${withheldDebt(artifact, cutoff)?.periodEnd}`;
  const notes = [...(artifact.omissionNotes ?? []), ...(artifact.validationNotes ?? [])].filter(
    (note) =>
      note.code === "stale-instant-series" ||
      (note.code === "tagged-zero-debt" &&
        zeroProofPeriodKeys.includes(note.periodKey ?? "") &&
        (note.publicAt ?? "") <= cutoff) ||
      (note.code === "debt-held-for-sale" &&
        (note.periodKey === withheldDebtKey || recastPeriodKeys.includes(note.periodKey ?? ""))) ||
      (note.code === "mixed-share-basis" && note.seriesKey === "dilutedShares") ||
      ((note.code === "untagged-balance-sheet-series" ||
        note.code === "incomplete-composite-series") &&
        note.seriesKey === "debt"),
  );
  return groupedDebtCompositeNotes(notes);
}

const LEGACY_DEBT_COMPOSITE_NOTE = /^Debt composite for (\S+) is incomplete: (.+)\.$/u;

// Artifacts written before notes carried `periods`/`reason` hold them only in the message.
function debtReason(note: FinancialStatementNote): string | undefined {
  if (note.code !== "incomplete-composite-series") {
    return undefined;
  }
  return note.reason ?? LEGACY_DEBT_COMPOSITE_NOTE.exec(note.message)?.[2];
}

function debtPeriods(note: FinancialStatementNote): readonly FinancialStatementNotePeriod[] {
  const legacyEnd = LEGACY_DEBT_COMPOSITE_NOTE.exec(note.message)?.[1];
  return note.periods ?? (legacyEnd === undefined ? [] : [{ end: legacyEnd }]);
}

// One note per withhold reason, listing its instants; each instant's note stays in the evidence bundle.
function groupedDebtCompositeNotes(
  notes: readonly FinancialStatementNote[],
): readonly FinancialStatementNote[] {
  const periodsByReason = new Map<string, FinancialStatementNotePeriod[]>();
  for (const note of notes) {
    const reason = debtReason(note);
    if (reason !== undefined) {
      periodsByReason.set(reason, [...(periodsByReason.get(reason) ?? []), ...debtPeriods(note)]);
    }
  }
  const emitted = new Set<string>();
  return notes.flatMap((note) => {
    const reason = debtReason(note);
    const periods = reason === undefined ? [] : (periodsByReason.get(reason) ?? []);
    if (reason === undefined || periods.length < 2) {
      return [note];
    }
    if (emitted.has(reason)) {
      return [];
    }
    emitted.add(reason);
    const { periodKey: _periodKey, ...rest } = note;
    return [
      {
        ...rest,
        periods,
        message: `Debt composite for ${periods.map((period) => period.end).join(", ")} is incomplete: ${reason}.`,
      },
    ];
  });
}

export function operatingRatioNotes(
  artifact: FinancialStatementsArtifact | undefined,
): readonly FinancialStatementNote[] | undefined {
  const notes = artifact?.omissionNotes;
  if (notes === undefined) {
    return undefined;
  }
  const unreconciled = notes.filter(
    (note) =>
      note.code === "unreconciled-component" && note.seriesKey === "depreciationAndAmortization",
  );
  const kept = notes.filter(
    (note) =>
      (note.code === "incomplete-composite-series" &&
        (note.seriesKey === "depreciationAndAmortization" ||
          note.seriesKey === "capitalExpenditure")) ||
      note.code === "unchecked-extension-capex" ||
      note.code === "revenue-concept-splice",
  );
  const unchecked = notes.filter(
    (note) =>
      note.code === "unchecked-component-sum" && note.seriesKey === "depreciationAndAmortization",
  );
  const unprovenCapex = notes.filter((note) => note.code === "capex-scope-unproven");
  return [
    ...kept,
    ...collapsed(
      unreconciled,
      (periods) =>
        `SEC depreciation and amortization for periods ending ${periods} uses AmortizationOfIntangibleAssets; the same-filing cash-flow AdjustmentForAmortization is higher in each and is not proven to be intangible amortization`,
    ),
    ...collapsed(
      unchecked,
      (periods) =>
        `SEC depreciation and amortization for periods ending ${periods} is a sum of filed D&A components, not checked against the filed cash-flow statement`,
    ),
    ...collapsed(
      unprovenCapex,
      (periods) =>
        `SEC capital expenditure for periods ending ${periods} is the filed line beside continuing-operations operating cash flow; no calculation linkbase proves it is continuing-operations only, and no discontinued-operations investing is reported`,
    ),
  ];
}

function collapsed(
  notes: readonly FinancialStatementNote[],
  message: (periods: string) => string,
): readonly FinancialStatementNote[] {
  if (notes.length < 2) {
    return notes;
  }
  const periods = notes.map((note) => note.periodKey?.split("|").at(-1) ?? "unknown");
  return [
    {
      code: notes[0]!.code,
      seriesKey: notes[0]!.seriesKey ?? "depreciationAndAmortization",
      message: message(periods.join(", ")),
    },
  ];
}

function latestPositionValue(
  artifact: FinancialStatementsArtifact,
  key: "cash" | "debt" | "dilutedShares",
  cutoff: string,
): EquityReaderFinancialPositionValue | undefined {
  const series = financialStatementSeriesByKey(artifact, key);
  if (series === undefined) {
    return undefined;
  }
  const fact = latestFinancialStatementFact(
    financialStatementFacts(series).filter((candidate) =>
      observableStatementFact(candidate, cutoff),
    ),
  );
  return fact === undefined ? undefined : { ...statementValue(fact), periodEnd: fact.periodEnd };
}

function staleInstantNote(
  key: "cash" | "debt",
  value: EquityReaderFinancialPositionValue | undefined,
  asOf: string,
): FinancialStatementNote | undefined {
  if (value === undefined || isFreshPeriodEnd(value.periodEnd, asOf)) {
    return undefined;
  }
  return {
    code: "stale-instant-series",
    seriesKey: key,
    periodKey: `instant|${value.periodEnd}`,
    message: `${key === "cash" ? "Cash" : "Debt"} as of ${value.periodEnd} is more than ${SEC_FRESHNESS_DAYS} days before the analysis cutoff; withheld.`,
  };
}

export function financialPosition(
  artifact: FinancialStatementsArtifact | undefined,
  reportGeneratedAt: string | undefined,
): EquityReaderFinancialPosition | undefined {
  if (artifact === undefined) {
    return undefined;
  }
  const asOf = reportGeneratedAt ?? artifact.analysisAsOf;
  const cutoff = asOf.slice(0, 10);
  const latestCash = latestPositionValue(artifact, "cash", cutoff);
  const latestDebt =
    withheldDebt(artifact, cutoff) === undefined
      ? latestPositionValue(artifact, "debt", cutoff)
      : undefined;
  const cashStale = staleInstantNote("cash", latestCash, asOf);
  const debtStale = staleInstantNote("debt", latestDebt, asOf);
  const cash = cashStale === undefined ? latestCash : undefined;
  const debt = debtStale === undefined ? latestDebt : undefined;
  const staleNotes = [cashStale, debtStale].filter((note) => note !== undefined);
  const dilutedShares = latestPositionValue(artifact, "dilutedShares", cutoff);
  if (
    cash === undefined &&
    debt === undefined &&
    dilutedShares === undefined &&
    staleNotes.length === 0
  ) {
    return undefined;
  }
  const surfaceNotes = statementSurfaceNotes(
    artifact,
    cutoff,
    [],
    debt?.zeroBorrowingsProof === undefined ? [] : [`instant|${debt.periodEnd}`],
  );
  const newStale = staleNotes.filter(
    (stale) =>
      !surfaceNotes?.some((note) => note.code === stale.code && note.seriesKey === stale.seriesKey),
  );
  const notes = newStale.length === 0 ? surfaceNotes : [...(surfaceNotes ?? []), ...newStale];
  return {
    ...(artifact.reportingCurrency === undefined
      ? {}
      : { reportingCurrency: artifact.reportingCurrency }),
    ...(cash === undefined ? {} : { cash }),
    ...(debt === undefined ? {} : { debt }),
    ...(dilutedShares === undefined ? {} : { dilutedShares }),
    ...(notes === undefined ? {} : { notes }),
  };
}

export function balanceSheetHistory(
  artifact: FinancialStatementsArtifact | undefined,
  reportGeneratedAt: string | undefined,
): EquityReaderBalanceSheetHistory | undefined {
  if (artifact === undefined) {
    return undefined;
  }
  const cutoff = (reportGeneratedAt ?? artifact.analysisAsOf).slice(0, 10);
  const cash = financialStatementSeriesByKey(artifact, "cash");
  const debt = financialStatementSeriesByKey(artifact, "debt");
  const dilutedShares = financialStatementSeriesByKey(artifact, "dilutedShares");
  if (cash === undefined || debt === undefined || dilutedShares === undefined) {
    return undefined;
  }
  const series = [cash, debt, dilutedShares];
  const facts = series
    .flatMap((item) => financialStatementFacts(item))
    .filter((fact) => observableStatementFact(fact, cutoff));
  const periods = [...new Set(facts.map((fact) => fact.periodEnd))].toSorted().slice(-5);
  const recastPeriodKeys: string[] = [];
  const zeroProofPeriodKeys: string[] = [];
  const rows = periods.flatMap((periodEnd): readonly EquityReaderBalanceSheetRow[] => {
    const cashFact = latestFinancialStatementFact(
      financialStatementFacts(cash).filter(
        (fact) => observableStatementFact(fact, cutoff) && fact.periodEnd === periodEnd,
      ),
    );
    const publishedDebt = latestFinancialStatementFact(
      financialStatementFacts(debt).filter(
        (fact) => observableStatementFact(fact, cutoff) && fact.periodEnd === periodEnd,
      ),
    );
    const recast =
      publishedDebt !== undefined && heldForSaleRecast(artifact, publishedDebt, cutoff);
    if (recast) {
      recastPeriodKeys.push(`instant|${periodEnd}`);
    }
    const debtFact = recast ? undefined : publishedDebt;
    if (debtFact?.zeroBorrowingsProof !== undefined) {
      zeroProofPeriodKeys.push(`instant|${periodEnd}`);
    }
    const dilutedSharesFact = latestFinancialStatementFact(
      financialStatementFacts(dilutedShares).filter(
        (fact) => observableStatementFact(fact, cutoff) && fact.periodEnd === periodEnd,
      ),
    );
    const filingFact = latestFinancialStatementFact(
      [cashFact, debtFact, dilutedSharesFact].filter(
        (fact): fact is FinancialStatementFact => fact !== undefined,
      ),
    );
    if (filingFact === undefined) {
      return [];
    }
    const { filedAt, periodType: kind } = filingFact;
    return [
      {
        period: periodLabel({ kind, periodEnd, filedAt }),
        ...(cashFact === undefined ? {} : { cash: statementValue(cashFact) }),
        ...(debtFact === undefined ? {} : { debt: statementValue(debtFact) }),
        ...(dilutedSharesFact === undefined
          ? {}
          : { dilutedShares: statementValue(dilutedSharesFact) }),
      },
    ];
  });
  if (rows.length === 0) {
    return undefined;
  }
  const notes = statementSurfaceNotes(artifact, cutoff, recastPeriodKeys, zeroProofPeriodKeys);
  return {
    ...(artifact.reportingCurrency === undefined
      ? {}
      : { reportingCurrency: artifact.reportingCurrency }),
    sourceIds: uniqueSourceIds([
      artifact.sourceId,
      ...rows.flatMap((row) => [
        ...(row.cash?.sourceIds ?? []),
        ...(row.debt?.sourceIds ?? []),
        ...(row.dilutedShares?.sourceIds ?? []),
      ]),
    ]),
    ...(notes === undefined ? {} : { notes }),
    rows,
  };
}

export function capitalReturnPayoutCell(payout: EquityReaderPayout | undefined): string {
  if (payout === undefined) {
    return "—";
  }
  if (payout.status === "withheld") {
    return "withheld";
  }
  return payout.status === "value"
    ? formatLensValue(payout.value, "ratio-percent")
    : `not meaningful, ${payout.reason}`;
}

const CAPITAL_RETURN_YEARS = 5;
const CAPITAL_RETURN_LABELS = {
  dividendsPaid: "dividends paid",
  shareRepurchases: "share repurchases",
  netIncome: "net income",
} as const;

function annualFlowFacts(
  artifact: FinancialStatementsArtifact,
  key: keyof typeof CAPITAL_RETURN_LABELS,
  cutoff: string,
): readonly FinancialStatementFact[] {
  const series = financialStatementSeriesByKey(artifact, key);
  return series === undefined
    ? []
    : financialStatementFacts(series).filter(
        (fact) =>
          fact.periodType === "annual" &&
          isYearAlignedFact(key, fact) &&
          observableStatementFact(fact, cutoff),
      );
}

function missingYearsNote(
  key: keyof typeof CAPITAL_RETURN_LABELS,
  periodEnds: readonly string[],
  rowCount: number,
): readonly string[] {
  if (periodEnds.length === 0) {
    return [];
  }
  const label = CAPITAL_RETURN_LABELS[key];
  return [
    periodEnds.length === rowCount && key !== "netIncome"
      ? `No year-aligned annual ${label} filed for these fiscal years.`
      : `No year-aligned annual ${label} for the fiscal years ending ${periodEnds.join(", ")}.`,
  ];
}

function groupedNote(prefix: string, byReason: ReadonlyMap<string, readonly string[]>): string[] {
  return [...byReason].map(
    ([reason, periodEnds]) =>
      `${prefix} for the fiscal years ending ${periodEnds.join(", ")}: ${reason}.`,
  );
}

// A year whose parent and consolidated bounds display differently is withheld.
function yearScope(
  artifact: FinancialStatementsArtifact,
  dividends: FinancialStatementFact,
  income: FinancialStatementFact,
): string | undefined {
  const scope = payoutScope(artifact, dividends, income);
  if (scope.status === "withheld") {
    return scope.reason;
  }
  if (scope.status === "same" || income.value <= 0) {
    return undefined;
  }
  const paid = Math.abs(dividends.value);
  return scope.consolidated.value > 0 &&
    formatRatioPercent(paid / income.value) === formatRatioPercent(paid / scope.consolidated.value)
    ? undefined
    : payoutScopeAmbiguity(dividends.concept);
}

// The window is the latest five filed fiscal years; a flow absent inside it is declared, not skipped.
export function capitalReturnHistory(
  artifact: FinancialStatementsArtifact | undefined,
  reportGeneratedAt: string | undefined,
  issuerSic?: string,
): EquityReaderCapitalReturnHistory | undefined {
  if (artifact === undefined) {
    return undefined;
  }
  const cutoff = (reportGeneratedAt ?? artifact.analysisAsOf).slice(0, 10);
  const facts = {
    dividendsPaid: annualFlowFacts(artifact, "dividendsPaid", cutoff),
    shareRepurchases: annualFlowFacts(artifact, "shareRepurchases", cutoff),
    netIncome: annualFlowFacts(artifact, "netIncome", cutoff),
  };
  const at = (key: keyof typeof facts, periodEnd: string) =>
    latestFinancialStatementFact(facts[key].filter((fact) => fact.periodEnd === periodEnd));
  const periods = [
    ...new Set(Object.values(facts).flatMap((series) => series.map((fact) => fact.periodEnd))),
  ]
    .toSorted()
    .slice(-CAPITAL_RETURN_YEARS);
  if (
    !periods.some(
      (periodEnd) =>
        at("dividendsPaid", periodEnd) !== undefined ||
        at("shareRepurchases", periodEnd) !== undefined,
    )
  ) {
    return undefined;
  }
  const withheld = new Map<string, string[]>();
  const rows = periods.map((periodEnd): EquityReaderCapitalReturnRow => {
    const dividends = at("dividendsPaid", periodEnd);
    const repurchases = at("shareRepurchases", periodEnd);
    const income = at("netIncome", periodEnd);
    const { filedAt } = latestFinancialStatementFact(
      [dividends, repurchases, income].filter((fact) => fact !== undefined),
    )!;
    const scope =
      dividends === undefined || income === undefined
        ? undefined
        : yearScope(artifact, dividends, income);
    if (scope !== undefined) {
      withheld.set(scope, [...(withheld.get(scope) ?? []), periodEnd]);
    }
    let payout: EquityReaderPayout | undefined;
    if (scope !== undefined) {
      payout = { status: "withheld" };
    } else if (dividends !== undefined && income !== undefined) {
      payout =
        income.value > 0
          ? { status: "value", value: Math.abs(dividends.value) / income.value }
          : { status: "not-meaningful", reason: "net income is zero or negative" };
    }
    return {
      period: periodLabel({ kind: "annual", periodEnd, filedAt }),
      ...(dividends === undefined
        ? {}
        : { dividendsPaid: { ...statementValue(dividends), value: Math.abs(dividends.value) } }),
      ...(repurchases === undefined
        ? {}
        : {
            shareRepurchases: {
              ...statementValue(repurchases),
              value: Math.abs(repurchases.value),
            },
          }),
      ...(income === undefined || dividends === undefined
        ? {}
        : { netIncome: statementValue(income) }),
      ...(payout === undefined ? {} : { payout }),
    };
  });
  const missing = (key: keyof typeof facts, candidates: readonly string[]) =>
    candidates.filter((periodEnd) => at(key, periodEnd) === undefined);
  const paidPeriods = periods.filter((periodEnd) => at("dividendsPaid", periodEnd) !== undefined);
  return {
    ...(artifact.reportingCurrency === undefined
      ? {}
      : { reportingCurrency: artifact.reportingCurrency }),
    sourceIds: uniqueSourceIds([
      artifact.sourceId,
      ...rows.flatMap((row) => [
        ...(row.dividendsPaid?.sourceIds ?? []),
        ...(row.shareRepurchases?.sourceIds ?? []),
        ...(row.netIncome?.sourceIds ?? []),
      ]),
    ]),
    notes: [
      ...missingYearsNote("dividendsPaid", missing("dividendsPaid", periods), periods.length),
      ...missingYearsNote("shareRepurchases", missing("shareRepurchases", periods), periods.length),
      ...missingYearsNote("netIncome", missing("netIncome", paidPeriods), periods.length),
      ...groupedNote("Payout withheld", withheld),
      ...(issuerSic === REIT_SIC && rows.some((row) => row.payout?.status === "value")
        ? [
            "Payout is against net income, not the FFO/AFFO basis REIT distributions are usually measured on.",
          ]
        : []),
    ],
    rows,
  };
}
