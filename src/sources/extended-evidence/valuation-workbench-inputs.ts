import { statementInput } from "./metric-engine";
import { debtScopeUnproven, isWithheldDebtNote } from "./sec-debt";
import {
  ENTERPRISE_VALUE_BRIDGE_KEYS,
  bridgeContributors,
  resolveEnterpriseValueBridge,
} from "./enterprise-value-bridge";
import type {
  FinancialStatementSeriesKey,
  FinancialStatementFact,
  FinancialStatementSeries,
  FinancialStatementTtm,
  FinancialStatementsArtifact,
} from "./financial-statements-contract";
import {
  CAPEX_SCOPE_CAVEAT,
  conceptScope,
  DEBT_SCOPE_CAVEAT,
  FINANCIAL_STATEMENT_SERIES_DEFINITIONS,
  hasNegativeCapex,
  scopedLabel,
  TOTAL_OPERATIONS_SCOPE,
} from "./financial-statement-definitions";
import {
  deriveFinancialStatementTtm,
  earlierShareBasisPeriods,
  touchesEarlierShareBasis,
  financialStatementFactForPeriod,
  financialStatementPeriodKey,
  financialStatementFacts,
  financialStatementTtmsAreCompatible,
  financialStatementTtmsSharePeriod,
  latestFinancialStatementFact,
} from "./financial-statement-selection";
import type {
  ValuationFundamentalInput,
  ValuationObservationBasis,
} from "./valuation-workbench-contract";

export interface ValuationPeriodInputs {
  readonly basis: ValuationObservationBasis;
  readonly periodEnd: string;
  // Annual rows only: the fiscal span, which keeps a transition period apart from a full year.
  readonly periodKey?: string;
  readonly revenue?: ValuationFundamentalInput;
  readonly netIncome?: ValuationFundamentalInput;
  readonly dilutedEps?: ValuationFundamentalInput;
  readonly dilutedShares?: ValuationFundamentalInput;
  readonly operatingCashFlow?: ValuationFundamentalInput;
  readonly capitalExpenditure?: ValuationFundamentalInput;
  readonly freeCashFlow?: ValuationFundamentalInput;
  readonly cash?: ValuationFundamentalInput;
  readonly debt?: ValuationFundamentalInput;
  readonly enterpriseValueBridge?: ValuationFundamentalInput;
  readonly enterpriseValueBridgeIncomplete?: true;
  readonly debtScopeMismatch?: true;
  readonly debtScopeUnproven?: true;
  // A newer incomplete debt instant sits between this debt and the cash instant, so they never pair.
  readonly debtBehindIncompleteInstant?: true;
  readonly earlierShareBasis?: readonly ("dilutedEps" | "dilutedShares")[];
  // Annual rows only: the date pricing the row, its first annual report unless that is unavailable.
  readonly rowPublicAt?: string;
  readonly restatedAfterFirstFiling?: readonly FinancialStatementSeriesKey[];
  // The artifact records first annual reports but none for this span, so every flow input is withheld.
  readonly firstAnnualReportUnavailable?: true;
}

export function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function latest(values: readonly string[]): string {
  return values.toSorted().at(-1) ?? "";
}

function withScope(
  label: string,
  concept: string,
  totalOperations = false,
): Pick<ValuationFundamentalInput, "label" | "scope"> {
  const scope = conceptScope(concept) ?? (totalOperations ? TOTAL_OPERATIONS_SCOPE : undefined);
  return { label: scopedLabel(label, scope), ...(scope !== undefined ? { scope } : {}) };
}

const INPUT_SERIES: Readonly<Record<string, FinancialStatementSeriesKey>> = {
  Revenue: "revenue",
  "Net income": "netIncome",
  "Diluted EPS": "dilutedEps",
  "Diluted weighted-average shares": "dilutedShares",
  "Operating cash flow": "operatingCashFlow",
  "Capital expenditure": "capitalExpenditure",
  Cash: "cash",
  Debt: "debt",
};

function factInput(
  label: string,
  fact: FinancialStatementFact,
  totalOperations = false,
): ValuationFundamentalInput {
  return {
    value: fact.value,
    ...withScope(label, fact.concept, totalOperations),
    periodEnd: fact.periodEnd,
    publicAt: fact.firstPublicAt,
    currency: fact.currency,
    unit: fact.unit,
    sourceIds: fact.sourceIds,
    lineage: [statementInput(fact, INPUT_SERIES[label]!, label)],
  };
}

function ttmInput(
  label: string,
  ttm: FinancialStatementTtm,
  totalOperations = false,
): ValuationFundamentalInput {
  return {
    value: ttm.value,
    ...withScope(
      label,
      Object.values(ttm.components).find((fact) => conceptScope(fact.concept) !== undefined)
        ?.concept ?? ttm.components.fiscalYear.concept,
      totalOperations,
    ),
    periodEnd: ttm.periodEnd,
    publicAt: latest(Object.values(ttm.components).map((fact) => fact.firstPublicAt)),
    currency: ttm.currency,
    unit: ttm.unit,
    sourceIds: ttm.sourceIds,
    lineage: Object.values(ttm.components).map((fact) =>
      statementInput(fact, INPUT_SERIES[label]!, label),
    ),
    derivation: ttm.formula,
  };
}

function fcfInput(
  operatingCashFlow: ValuationFundamentalInput | undefined,
  capitalExpenditure: ValuationFundamentalInput | undefined,
): ValuationFundamentalInput | undefined {
  if (operatingCashFlow === undefined || capitalExpenditure === undefined) {
    return undefined;
  }
  if (
    hasNegativeCapex(
      [capitalExpenditure, ...(capitalExpenditure.lineage ?? [])].map(({ value }) => value),
    ) ||
    operatingCashFlow.periodEnd !== capitalExpenditure.periodEnd ||
    operatingCashFlow.currency !== capitalExpenditure.currency ||
    operatingCashFlow.unit !== capitalExpenditure.unit
  ) {
    return undefined;
  }
  return {
    value: operatingCashFlow.value - capitalExpenditure.value,
    label: scopedLabel("Free cash flow proxy", operatingCashFlow.scope),
    ...(operatingCashFlow.scope !== undefined ? { scope: operatingCashFlow.scope } : {}),
    periodEnd: operatingCashFlow.periodEnd,
    publicAt: latest([operatingCashFlow.publicAt, capitalExpenditure.publicAt]),
    currency: operatingCashFlow.currency,
    unit: operatingCashFlow.unit,
    sourceIds: unique([...operatingCashFlow.sourceIds, ...capitalExpenditure.sourceIds]),
    lineage: [...(operatingCashFlow.lineage ?? []), ...(capitalExpenditure.lineage ?? [])],
    derivation:
      operatingCashFlow.scope === undefined
        ? "operating cash flow - capital expenditure"
        : `operating cash flow (${operatingCashFlow.scope}) - capital expenditure; ${CAPEX_SCOPE_CAVEAT}`,
  };
}

// Diluted EPS is parent-attributable; IFRS ProfitLoss includes NCI (IAS 33.10).
const isParentIncome = (fact: FinancialStatementFact) =>
  fact.taxonomy === "us-gaap" && fact.concept === "NetIncomeLoss";

function deriveShares(
  netIncome: ValuationFundamentalInput | undefined,
  dilutedEps: ValuationFundamentalInput | undefined,
  parentIncome: boolean,
): ValuationFundamentalInput | undefined {
  if (
    !parentIncome ||
    netIncome === undefined ||
    dilutedEps === undefined ||
    dilutedEps.value === 0 ||
    netIncome.periodEnd !== dilutedEps.periodEnd ||
    netIncome.currency === null ||
    netIncome.currency !== dilutedEps.currency ||
    netIncome.unit !== netIncome.currency ||
    dilutedEps.unit !== `${netIncome.currency}/shares` ||
    !Number.isFinite(netIncome.value / dilutedEps.value)
  ) {
    return undefined;
  }
  return {
    value: netIncome.value / dilutedEps.value,
    label: "Diluted weighted-average shares",
    periodEnd: netIncome.periodEnd,
    publicAt: latest([netIncome.publicAt, dilutedEps.publicAt]),
    currency: null,
    unit: "shares",
    sourceIds: unique([...netIncome.sourceIds, ...dilutedEps.sourceIds]),
    lineage: [...(netIncome.lineage ?? []), ...(dilutedEps.lineage ?? [])],
    derivation: "net income / diluted EPS",
  };
}

const BRIDGE_SIGNS = {
  shortTermInvestments: -1,
  noncontrollingInterest: 1,
  preferredStock: 1,
  temporaryEquity: 1,
} as const;

function bridgeInput(
  artifact: FinancialStatementsArtifact,
  cashFact: FinancialStatementFact | undefined,
  publicAt: string,
): Pick<ValuationPeriodInputs, "enterpriseValueBridge" | "enterpriseValueBridgeIncomplete"> {
  if (cashFact === undefined) {
    return {};
  }
  const resolved = resolveEnterpriseValueBridge(artifact.enterpriseValueBridge, cashFact, publicAt);
  const parts = ENTERPRISE_VALUE_BRIDGE_KEYS.map((key) => [key, resolved[key]] as const);
  if (parts.some(([, part]) => part.status === "incomplete")) {
    return { enterpriseValueBridgeIncomplete: true };
  }
  const tagged = parts.flatMap(([key, part]) => (part.status === "tagged" ? [{ key, part }] : []));
  const [first] = tagged;
  if (first === undefined) {
    return {};
  }
  const contributors = tagged.flatMap(({ key, part }) =>
    bridgeContributors(part).map((contributor) => ({ key, ...contributor })),
  );
  return {
    enterpriseValueBridge: {
      value: tagged.reduce((sum, { key, part }) => sum + BRIDGE_SIGNS[key] * part.value, 0),
      label: "EV bridge",
      periodEnd: cashFact.periodEnd,
      publicAt: latest(contributors.map(({ fact }) => fact.firstPublicAt)),
      currency: first.part.fact.currency,
      unit: first.part.fact.unit,
      sourceIds: unique(contributors.flatMap(({ fact }) => fact.sourceIds)),
      lineage: contributors.map(({ key, fact, value, label }) => ({
        label: `${key} (${label})`,
        value,
        artifact: "statements" as const,
        key: fact.concept,
        periodType: fact.periodType,
        periodEnd: fact.periodEnd,
        periodKey: fact.periodKey,
        unit: fact.unit,
        ...(fact.currency === null ? {} : { currency: fact.currency }),
        sourceIds: fact.sourceIds,
      })),
      derivation:
        "preferred stock + noncontrolling interest + temporary equity (each at carrying amount) − short-term investments",
    },
  };
}

// Older complete debt never stands in past a newer incomplete debt instant.
function debtInput(
  artifact: FinancialStatementsArtifact,
  debtFact: FinancialStatementFact | undefined,
  cashFact: FinancialStatementFact | undefined,
  publicAt: string,
  flow: { readonly periodEnd: string; readonly firstPublicAt: string },
): Pick<
  ValuationPeriodInputs,
  "debt" | "debtScopeMismatch" | "debtScopeUnproven" | "debtBehindIncompleteInstant"
> {
  if (debtFact === undefined) {
    return {};
  }
  const published = artifact.omissionNotes.filter(
    (note) => isWithheldDebtNote(note) && (note.publicAt ?? "") <= publicAt,
  );
  const atInstant = (periodEnd: string | undefined) =>
    published.filter((note) => note.periodKey === `instant|${periodEnd}`);
  if (
    atInstant(debtFact.periodEnd).some(
      (note) => note.code === "debt-held-for-sale" && (note.publicAt ?? "") > debtFact.filedAt,
    )
  ) {
    return { debtScopeMismatch: true };
  }
  const newer = published.filter((note) => {
    const periodEnd = note.periodKey?.replace(/^instant\|/u, "");
    return (
      periodEnd !== undefined &&
      periodEnd > debtFact.periodEnd &&
      periodEnd <= (cashFact?.periodEnd ?? debtFact.periodEnd)
    );
  });
  if (newer.some((note) => note.periodKey === `instant|${cashFact?.periodEnd}`)) {
    return {};
  }
  const unproven = debtScopeUnproven(artifact, debtFact, flow) !== undefined;
  return {
    debt: {
      ...factInput("Debt", debtFact),
      ...(unproven ? { scope: DEBT_SCOPE_CAVEAT } : {}),
    },
    ...(unproven ? { debtScopeUnproven: true as const } : {}),
    ...(newer.length > 0 ? { debtBehindIncompleteInstant: true as const } : {}),
  };
}

function annualInputs(
  artifact: FinancialStatementsArtifact,
  revenueFact: FinancialStatementFact,
  anchored = true,
): ValuationPeriodInputs {
  const { incomeStatement, balanceSheet, cashFlowStatement, perShare } = artifact.statements;
  const { periodEnd, periodKey, periodType } = revenueFact;
  const netIncomeFact = financialStatementFactForPeriod(
    financialStatementFacts(incomeStatement.netIncome),
    periodKey,
    periodType,
  );
  const dilutedEpsFact = financialStatementFactForPeriod(
    financialStatementFacts(perShare.dilutedEps),
    periodKey,
    periodType,
  );
  const dilutedSharesFact = financialStatementFactForPeriod(
    financialStatementFacts(perShare.dilutedShares),
    periodKey,
    periodType,
  );
  const operatingCashFlowFact = financialStatementFactForPeriod(
    financialStatementFacts(cashFlowStatement.operatingCashFlow),
    periodKey,
    periodType,
  );
  const capitalExpenditureFact = financialStatementFactForPeriod(
    financialStatementFacts(cashFlowStatement.capitalExpenditure),
    periodKey,
    periodType,
  );
  const hasContinuing = (series: FinancialStatementSeries) =>
    financialStatementFactForPeriod(financialStatementFacts(series), periodKey, periodType) !==
    undefined;
  const earlierShareBasis = (["dilutedEps", "dilutedShares"] as const).filter((key) =>
    earlierShareBasisPeriods(artifact.omissionNotes, key).has(periodKey),
  );
  const flowFacts = {
    revenue: revenueFact,
    netIncome: netIncomeFact,
    dilutedEps: dilutedEpsFact,
    dilutedShares: dilutedSharesFact,
    operatingCashFlow: operatingCashFlowFact,
    capitalExpenditure: capitalExpenditureFact,
  };
  const census = anchored ? artifact.firstAnnualReports : undefined;
  const firstFiledAt = anchored
    ? census === undefined
      ? // Pre-census artifacts only: a restated fact dates its period from the filing it restated.
        Object.values(flowFacts)
          .flatMap((fact) =>
            fact === undefined ? [] : [fact.restatedFrom?.filedAt ?? fact.firstPublicAt],
          )
          .toSorted()[0]
      : census.find((report) => financialStatementPeriodKey(report) === periodKey)?.filedAt
    : undefined;
  const firstAnnualReportUnavailable = census !== undefined && firstFiledAt === undefined;
  const restatedAfterFirstFiling = (Object.keys(flowFacts) as (keyof typeof flowFacts)[]).filter(
    (key) =>
      firstFiledAt !== undefined &&
      (flowFacts[key]?.firstPublicAt ?? "") > firstFiledAt &&
      !(earlierShareBasis as readonly string[]).includes(key),
  );
  const usable = <Key extends keyof typeof flowFacts>(key: Key) =>
    firstAnnualReportUnavailable ||
    restatedAfterFirstFiling.includes(key) ||
    (earlierShareBasis as readonly string[]).includes(key)
      ? undefined
      : flowFacts[key];
  const revenueInput = usable("revenue");
  const revenue = revenueInput === undefined ? undefined : factInput("Revenue", revenueInput);
  const netIncomeInput = usable("netIncome");
  const netIncome =
    netIncomeInput === undefined
      ? undefined
      : factInput("Net income", netIncomeInput, hasContinuing(incomeStatement.continuingIncome));
  const dilutedEpsInput = usable("dilutedEps");
  const dilutedEps =
    dilutedEpsInput === undefined
      ? undefined
      : factInput("Diluted EPS", dilutedEpsInput, hasContinuing(perShare.continuingDilutedEps));
  const directSharesInput = usable("dilutedShares");
  const directShares =
    directSharesInput === undefined
      ? undefined
      : factInput("Diluted weighted-average shares", directSharesInput);
  const operatingCashFlowInput = usable("operatingCashFlow");
  const operatingCashFlow =
    operatingCashFlowInput === undefined
      ? undefined
      : factInput("Operating cash flow", operatingCashFlowInput);
  const capitalExpenditureInput = usable("capitalExpenditure");
  const capitalExpenditure =
    capitalExpenditureInput === undefined
      ? undefined
      : factInput("Capital expenditure", capitalExpenditureInput);
  const publicAt =
    firstFiledAt ??
    latest(
      firstAnnualReportUnavailable
        ? Object.values(flowFacts).flatMap((fact) =>
            fact === undefined ? [] : [fact.firstPublicAt],
          )
        : [
            revenue,
            netIncome,
            dilutedEps,
            directShares,
            operatingCashFlow,
            capitalExpenditure,
          ].flatMap((input) => (input === undefined ? [] : [input.publicAt])),
    );
  const cashFact = latestFinancialStatementFact(
    financialStatementFacts(balanceSheet.cash).filter(
      (fact) => fact.periodEnd <= periodEnd && fact.firstPublicAt <= publicAt,
    ),
  );
  const debtFact = latestFinancialStatementFact(
    financialStatementFacts(balanceSheet.debt).filter(
      (fact) => fact.periodEnd <= periodEnd && fact.firstPublicAt <= publicAt,
    ),
  );
  // NI / rounded EPS never replaces a filed count withheld for restatement (JPM preferred, LTRX rounding).
  const dilutedShares =
    directShares ??
    (restatedAfterFirstFiling.includes("dilutedShares")
      ? undefined
      : deriveShares(
          netIncome,
          dilutedEps,
          netIncomeInput !== undefined && isParentIncome(netIncomeInput),
        ));
  const freeCashFlow = fcfInput(operatingCashFlow, capitalExpenditure);
  return {
    basis: "annual",
    periodEnd,
    periodKey,
    ...(revenue !== undefined ? { revenue } : {}),
    ...(netIncome !== undefined ? { netIncome } : {}),
    ...(dilutedEps !== undefined ? { dilutedEps } : {}),
    ...(dilutedShares !== undefined ? { dilutedShares } : {}),
    ...(operatingCashFlow !== undefined ? { operatingCashFlow } : {}),
    ...(capitalExpenditure !== undefined ? { capitalExpenditure } : {}),
    ...(freeCashFlow !== undefined ? { freeCashFlow } : {}),
    ...(earlierShareBasis.length > 0 ? { earlierShareBasis } : {}),
    ...(anchored ? { rowPublicAt: publicAt } : {}),
    ...(restatedAfterFirstFiling.length > 0 ? { restatedAfterFirstFiling } : {}),
    ...(firstAnnualReportUnavailable ? { firstAnnualReportUnavailable } : {}),
    ...(cashFact !== undefined ? { cash: factInput("Cash", cashFact) } : {}),
    ...debtInput(artifact, debtFact, cashFact, publicAt, {
      periodEnd,
      firstPublicAt: revenue?.publicAt ?? publicAt,
    }),
    ...bridgeInput(artifact, cashFact, publicAt),
  };
}

interface ValuationTtmInputs {
  readonly revenue: FinancialStatementTtm;
  readonly netIncome?: FinancialStatementTtm;
  readonly dilutedEps?: FinancialStatementTtm;
  readonly continuingIncome?: FinancialStatementTtm;
  readonly continuingDilutedEps?: FinancialStatementTtm;
  readonly operatingCashFlow?: FinancialStatementTtm;
  readonly capitalExpenditure?: FinancialStatementTtm;
}

function sharesTtmPeriod(
  total: FinancialStatementTtm,
  continuing: FinancialStatementTtm | undefined,
): boolean {
  return continuing !== undefined && financialStatementTtmsSharePeriod([total, continuing]);
}

function periodInputsFromTtm(
  artifact: FinancialStatementsArtifact,
  values: ValuationTtmInputs,
): ValuationPeriodInputs {
  if (values.revenue.formula === "FY") {
    // The fiscal year's own facts, including filed diluted shares rather than NI / rounded EPS.
    const annual = annualInputs(artifact, values.revenue.components.fiscalYear, false);
    return { ...annual, basis: "ttm", revenue: { ...annual.revenue!, derivation: "FY" } };
  }
  const { balanceSheet } = artifact.statements;
  const revenue = ttmInput("Revenue", values.revenue);
  const compatibleNetIncome =
    values.netIncome !== undefined &&
    financialStatementTtmsAreCompatible([values.revenue, values.netIncome])
      ? values.netIncome
      : undefined;
  const compatibleDilutedEps =
    values.dilutedEps !== undefined &&
    financialStatementTtmsSharePeriod([values.revenue, values.dilutedEps]) &&
    values.dilutedEps.currency === values.revenue.currency &&
    values.dilutedEps.unit === `${values.revenue.currency}/shares`
      ? values.dilutedEps
      : undefined;
  const compatibleOperatingCashFlow =
    values.operatingCashFlow !== undefined &&
    financialStatementTtmsAreCompatible([values.revenue, values.operatingCashFlow])
      ? values.operatingCashFlow
      : undefined;
  const compatibleCapitalExpenditure =
    values.capitalExpenditure !== undefined &&
    financialStatementTtmsAreCompatible([values.revenue, values.capitalExpenditure])
      ? values.capitalExpenditure
      : undefined;
  const netIncome =
    compatibleNetIncome === undefined
      ? undefined
      : ttmInput(
          "Net income",
          compatibleNetIncome,
          sharesTtmPeriod(compatibleNetIncome, values.continuingIncome),
        );
  const dilutedEps =
    compatibleDilutedEps === undefined
      ? undefined
      : ttmInput(
          "Diluted EPS",
          compatibleDilutedEps,
          sharesTtmPeriod(compatibleDilutedEps, values.continuingDilutedEps),
        );
  const operatingCashFlow =
    compatibleOperatingCashFlow === undefined
      ? undefined
      : ttmInput("Operating cash flow", compatibleOperatingCashFlow);
  const capitalExpenditure =
    compatibleCapitalExpenditure === undefined
      ? undefined
      : ttmInput("Capital expenditure", compatibleCapitalExpenditure);
  const dilutedShares = deriveShares(
    netIncome,
    dilutedEps,
    compatibleNetIncome !== undefined &&
      Object.values(compatibleNetIncome.components).every((fact) => isParentIncome(fact)),
  );
  const freeCashFlow = fcfInput(operatingCashFlow, capitalExpenditure);
  const publicAt = latest(
    [revenue, netIncome, dilutedEps, dilutedShares, freeCashFlow].flatMap((input) =>
      input === undefined ? [] : [input.publicAt],
    ),
  );
  const cashFact = latestFinancialStatementFact(
    financialStatementFacts(balanceSheet.cash).filter(
      (fact) => fact.periodEnd <= revenue.periodEnd && fact.firstPublicAt <= publicAt,
    ),
  );
  const debtFact = latestFinancialStatementFact(
    financialStatementFacts(balanceSheet.debt).filter(
      (fact) => fact.periodEnd <= revenue.periodEnd && fact.firstPublicAt <= publicAt,
    ),
  );
  return {
    basis: "ttm",
    periodEnd: revenue.periodEnd,
    revenue,
    ...(netIncome !== undefined ? { netIncome } : {}),
    ...(dilutedEps !== undefined ? { dilutedEps } : {}),
    ...(dilutedShares !== undefined ? { dilutedShares } : {}),
    ...(operatingCashFlow !== undefined ? { operatingCashFlow } : {}),
    ...(capitalExpenditure !== undefined ? { capitalExpenditure } : {}),
    ...(freeCashFlow !== undefined ? { freeCashFlow } : {}),
    ...(cashFact !== undefined ? { cash: factInput("Cash", cashFact) } : {}),
    ...debtInput(artifact, debtFact, cashFact, publicAt, {
      periodEnd: revenue.periodEnd,
      firstPublicAt: revenue.publicAt,
    }),
    ...bridgeInput(artifact, cashFact, publicAt),
  };
}

function ttmInputs(artifact: FinancialStatementsArtifact): ValuationPeriodInputs | undefined {
  const { incomeStatement, cashFlowStatement, perShare } = artifact.statements;
  const revenue = incomeStatement.revenue.ttm;
  if (revenue === undefined) {
    return undefined;
  }
  return periodInputsFromTtm(artifact, {
    revenue,
    ...(incomeStatement.netIncome.ttm !== undefined
      ? { netIncome: incomeStatement.netIncome.ttm }
      : {}),
    ...(perShare.dilutedEps.ttm !== undefined ? { dilutedEps: perShare.dilutedEps.ttm } : {}),
    ...(incomeStatement.continuingIncome.ttm !== undefined
      ? { continuingIncome: incomeStatement.continuingIncome.ttm }
      : {}),
    ...(perShare.continuingDilutedEps.ttm !== undefined
      ? { continuingDilutedEps: perShare.continuingDilutedEps.ttm }
      : {}),
    ...(cashFlowStatement.operatingCashFlow.ttm !== undefined
      ? { operatingCashFlow: cashFlowStatement.operatingCashFlow.ttm }
      : {}),
    ...(cashFlowStatement.capitalExpenditure.ttm !== undefined
      ? { capitalExpenditure: cashFlowStatement.capitalExpenditure.ttm }
      : {}),
  });
}

function derivedTtmAt(
  artifact: FinancialStatementsArtifact,
  series: FinancialStatementSeries,
  cutoff: string,
): FinancialStatementTtm | undefined {
  const definition = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
    (candidate) => candidate.key === series.key,
  );
  if (definition === undefined || artifact.reportingCurrency === undefined) {
    return undefined;
  }
  const { ttm } = deriveFinancialStatementTtm(
    definition,
    series.annual.filter((fact) => fact.firstPublicAt <= cutoff),
    series.interim.filter((fact) => fact.firstPublicAt <= cutoff),
    artifact.reportingCurrency,
  );
  return ttm === undefined ||
    touchesEarlierShareBasis(
      Object.values(ttm.components),
      earlierShareBasisPeriods(artifact.omissionNotes, series.key),
    )
    ? undefined
    : ttm;
}

function historicalTtmInputs(
  artifact: FinancialStatementsArtifact,
): readonly ValuationPeriodInputs[] {
  const { incomeStatement, cashFlowStatement, perShare } = artifact.statements;
  const cutoffs = [
    ...new Set(incomeStatement.revenue.interim.map((fact) => fact.firstPublicAt)),
  ].toSorted();
  return cutoffs.flatMap((cutoff) => {
    const revenue = derivedTtmAt(artifact, incomeStatement.revenue, cutoff);
    if (revenue === undefined) {
      return [];
    }
    const netIncome = derivedTtmAt(artifact, incomeStatement.netIncome, cutoff);
    const dilutedEps = derivedTtmAt(artifact, perShare.dilutedEps, cutoff);
    const continuingIncome = derivedTtmAt(artifact, incomeStatement.continuingIncome, cutoff);
    const continuingDilutedEps = derivedTtmAt(artifact, perShare.continuingDilutedEps, cutoff);
    const operatingCashFlow = derivedTtmAt(artifact, cashFlowStatement.operatingCashFlow, cutoff);
    const capitalExpenditure = derivedTtmAt(artifact, cashFlowStatement.capitalExpenditure, cutoff);
    return [
      periodInputsFromTtm(artifact, {
        revenue,
        ...(netIncome !== undefined ? { netIncome } : {}),
        ...(dilutedEps !== undefined ? { dilutedEps } : {}),
        ...(continuingIncome !== undefined ? { continuingIncome } : {}),
        ...(continuingDilutedEps !== undefined ? { continuingDilutedEps } : {}),
        ...(operatingCashFlow !== undefined ? { operatingCashFlow } : {}),
        ...(capitalExpenditure !== undefined ? { capitalExpenditure } : {}),
      }),
    ];
  });
}

function uniquePeriodInputs(
  values: readonly ValuationPeriodInputs[],
): readonly ValuationPeriodInputs[] {
  const byKey = new Map<string, ValuationPeriodInputs>();
  for (const value of values) {
    // A TTM ending at a fiscal-year end is that FY (formula "FY"); the TTM row stands for both.
    const coveredByTtm =
      value.basis === "annual" &&
      transitionMonths(value) === undefined &&
      values.some((other) => other.basis === "ttm" && other.periodEnd === value.periodEnd);
    if (!coveredByTtm) {
      byKey.set(
        `${value.basis}|${value.periodKey ?? value.periodEnd}|${periodPublicAt(value)}`,
        value,
      );
    }
  }
  return [...byKey.values()].toSorted(
    (left, right) =>
      left.periodEnd.localeCompare(right.periodEnd) ||
      periodPublicAt(left).localeCompare(periodPublicAt(right)),
  );
}

// A fiscal-year transition span shares its end date with the full year beside it.
export function transitionMonths(inputs: ValuationPeriodInputs): string | undefined {
  const months = /^duration:(\d+)\|/u.exec(inputs.periodKey ?? "")?.[1];
  return months === undefined || months === "12" ? undefined : months;
}

export function periodPublicAt(inputs: ValuationPeriodInputs): string {
  return (
    inputs.rowPublicAt ??
    latest(
      Object.entries(inputs)
        .filter(([key]) => key !== "operatingCashFlow" && key !== "capitalExpenditure")
        .flatMap(([, input]) =>
          typeof input === "object" && input !== null && "publicAt" in input
            ? [input.publicAt as string]
            : [],
        ),
    )
  );
}

// The reconciled TTM period is returned alongside the deduplicated series because the workbench
// Needs it twice: once as the trailing basis and once as the last entry of the observation set.
export function valuationPeriodInputs(artifact: FinancialStatementsArtifact): {
  readonly ttm: ValuationPeriodInputs | undefined;
  readonly periods: readonly ValuationPeriodInputs[];
} {
  const ttm = ttmInputs(artifact);
  return {
    ttm,
    periods: uniquePeriodInputs([
      ...artifact.statements.incomeStatement.revenue.annual.map((fact) =>
        annualInputs(artifact, fact),
      ),
      ...historicalTtmInputs(artifact),
      ...(ttm === undefined ? [] : [ttm]),
    ]),
  };
}
