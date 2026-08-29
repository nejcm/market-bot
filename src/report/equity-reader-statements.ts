import type {
  FinancialStatementFact,
  FinancialStatementNote,
  FinancialStatementsArtifact,
} from "../sources/extended-evidence/financial-statements-contract";
import {
  financialStatementFacts,
  financialStatementSeriesByKey,
  latestFinancialStatementFact,
} from "../sources/extended-evidence/financial-statement-selection";

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
  if (period.kind === "ttm") {
    return `TTM (${period.periodEnd}; filed ${period.filedAt})`;
  }
  return `${period.kind === "annual" ? "FY" : "Interim"} ending ${period.periodEnd} (filed ${period.filedAt})`;
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
  };
}

function statementSurfaceNotes(
  artifact: FinancialStatementsArtifact,
): readonly FinancialStatementNote[] | undefined {
  if (artifact.omissionNotes === undefined && artifact.validationNotes === undefined) {
    return undefined;
  }
  return [...(artifact.omissionNotes ?? []), ...(artifact.validationNotes ?? [])].filter(
    (note) =>
      note.code === "stale-instant-series" ||
      (note.code === "untagged-balance-sheet-series" && note.seriesKey === "debt"),
  );
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

export function financialPosition(
  artifact: FinancialStatementsArtifact | undefined,
  reportGeneratedAt: string | undefined,
): EquityReaderFinancialPosition | undefined {
  if (artifact === undefined) {
    return undefined;
  }
  const cutoff = (reportGeneratedAt ?? artifact.analysisAsOf).slice(0, 10);
  const cash = latestPositionValue(artifact, "cash", cutoff);
  const debt = latestPositionValue(artifact, "debt", cutoff);
  const dilutedShares = latestPositionValue(artifact, "dilutedShares", cutoff);
  if (cash === undefined && debt === undefined && dilutedShares === undefined) {
    return undefined;
  }
  const notes = statementSurfaceNotes(artifact);
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
  const rows = periods.flatMap((periodEnd): readonly EquityReaderBalanceSheetRow[] => {
    const cashFact = latestFinancialStatementFact(
      financialStatementFacts(cash).filter(
        (fact) => observableStatementFact(fact, cutoff) && fact.periodEnd === periodEnd,
      ),
    );
    const debtFact = latestFinancialStatementFact(
      financialStatementFacts(debt).filter(
        (fact) => observableStatementFact(fact, cutoff) && fact.periodEnd === periodEnd,
      ),
    );
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
  const notes = statementSurfaceNotes(artifact);
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
