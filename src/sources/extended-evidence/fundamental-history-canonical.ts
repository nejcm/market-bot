import {
  buildFundamentalHistorySeries,
  CONTINUING_INCOME_HISTORY,
  endsWithin,
  fundamentalHistoryCagr,
  negativeCapexTtmNote,
  totalOperationsScopes,
  type FundamentalHistoryArtifact,
  type FundamentalHistoryPoint,
  type FundamentalHistoryRawSeries,
  type FundamentalHistorySeries,
} from "./fundamental-history";
import {
  derivedFactDisclosure,
  isAnnualReportForm,
  type FinancialStatementFact,
  type FinancialStatementSeries,
  type FinancialStatementSeriesKey,
  type FinancialStatementsArtifact,
} from "./financial-statements-contract";
import {
  conceptScope,
  hasNegativeCapex,
  isContinuingScope,
} from "./financial-statement-definitions";
import {
  financialStatementFacts,
  financialStatementPeriodMonths,
  financialStatementSeriesByKey,
  latestFinancialStatementFact,
  earlierShareBasisPeriods,
  fiscalYearTtmLabel,
  touchesEarlierShareBasis,
} from "./financial-statement-selection";

const EPS_TTM_APPROXIMATION_NOTE =
  "ttm:eps-approximation: diluted EPS TTM adds per-share periods and does not reweight diluted shares";

interface CanonicalHistoryDefinition {
  readonly key: keyof FundamentalHistoryRawSeries;
  readonly canonicalKey: FinancialStatementSeriesKey;
  readonly label: string;
  readonly unit: "currency" | "per-share";
}

const DEFINITIONS: readonly CanonicalHistoryDefinition[] = [
  { key: "revenue", canonicalKey: "revenue", label: "Revenue", unit: "currency" },
  {
    key: "grossProfit",
    canonicalKey: "grossProfit",
    label: "Gross profit",
    unit: "currency",
  },
  {
    key: "operatingIncome",
    canonicalKey: "operatingIncome",
    label: "Operating income",
    unit: "currency",
  },
  { key: "netIncome", canonicalKey: "netIncome", label: "Net income", unit: "currency" },
  {
    key: "dilutedEps",
    canonicalKey: "dilutedEps",
    label: "Diluted EPS",
    unit: "per-share",
  },
  {
    key: "operatingCashFlow",
    canonicalKey: "operatingCashFlow",
    label: "Operating cash flow",
    unit: "currency",
  },
  {
    key: "capex",
    canonicalKey: "capitalExpenditure",
    label: "Capital expenditure",
    unit: "currency",
  },
];

function annualPoint(fact: FinancialStatementFact): FundamentalHistoryPoint | undefined {
  const months = financialStatementPeriodMonths(fact);
  if (
    fact.periodStart === undefined ||
    months === undefined ||
    months < 10 ||
    months > 14 ||
    !isAnnualReportForm(fact.canonicalForm)
  ) {
    return undefined;
  }
  return {
    value: fact.value,
    form: fact.canonicalForm,
    fy: fact.fiscalYear,
    fp: fact.fiscalPeriod,
    periodStart: fact.periodStart,
    periodEnd: fact.periodEnd,
    periodMonths: months,
    filedAt: fact.filedAt,
    currency: fact.unit,
    ...(fact.restatedFrom === undefined ? {} : { restatedFrom: fact.restatedFrom }),
  };
}

function ttmPoint(series: FinancialStatementSeries): FundamentalHistoryPoint | undefined {
  const { ttm } = series;
  if (ttm === undefined) {
    return undefined;
  }
  return {
    value: ttm.value,
    form: "TTM",
    fy: (ttm.formula === "FY" ? ttm.components.fiscalYear : ttm.components.latestYearToDate)
      .fiscalYear,
    fp: "TTM",
    periodStart: ttm.periodStart,
    periodEnd: ttm.periodEnd,
    periodMonths: 12,
    filedAt: Object.values(ttm.components)
      .map((fact) => fact.filedAt)
      .toSorted()
      .at(-1)!,
    currency: ttm.unit,
  };
}

function rawSeries(
  artifact: FinancialStatementsArtifact,
  definition: CanonicalHistoryDefinition,
): FundamentalHistorySeries {
  const series = financialStatementSeriesByKey(artifact, definition.canonicalKey);
  if (series === undefined) {
    throw new Error(`Canonical financial statements are missing ${definition.canonicalKey}`);
  }
  const notes: string[] = [];
  const annual = series.annual.flatMap((fact) => {
    const point = annualPoint(fact);
    return point === undefined ? [] : [point];
  });
  const negativeCapexTtm =
    definition.key === "capex" &&
    series.ttm !== undefined &&
    hasNegativeCapex([
      series.ttm.value,
      ...Object.values(series.ttm.components).map((fact) => fact.value),
    ]);
  const ttm = negativeCapexTtm ? undefined : ttmPoint(series);
  if (annual.length === 0) {
    notes.push("annual:missing-concept: no canonical annual facts found");
  }
  if (negativeCapexTtm) {
    notes.push(negativeCapexTtmNote(series.ttm!.periodEnd));
  } else if (ttm === undefined) {
    notes.push("ttm:unreconciled: canonical TTM is unavailable");
  }
  if (ttm !== undefined && series.ttm?.formula === "FY") {
    notes.push(`ttm:fiscal-year: ${fiscalYearTtmLabel(series.ttm.components.fiscalYear)}`);
  } else if (definition.key === "dilutedEps" && ttm !== undefined) {
    notes.push(EPS_TTM_APPROXIMATION_NOTE);
  }
  const derivation = [...series.annual, ...Object.values(series.ttm?.components ?? {})]
    .map((fact) => derivedFactDisclosure(definition.canonicalKey, fact))
    .find((disclosure) => disclosure !== undefined);
  if (derivation !== undefined) {
    notes.push(`derived: ${derivation}`);
  }
  const earlierShareBasis = earlierShareBasisPeriods(
    artifact.omissionNotes,
    definition.canonicalKey,
  );
  if (touchesEarlierShareBasis(series.annual, earlierShareBasis)) {
    notes.push(
      "share-basis:mixed: some annual points are on an earlier or unconfirmed share basis and are not adjusted",
    );
  }
  const cagr = fundamentalHistoryCagr(annual, notes);
  const mixedBasis =
    cagr !== undefined &&
    touchesEarlierShareBasis(
      series.annual.filter(
        (fact) => fact.periodEnd === cagr.periodStart || fact.periodEnd === cagr.periodEnd,
      ),
      earlierShareBasis,
    );
  if (mixedBasis) {
    notes.push(
      "cagr:mixed-share-basis: an annual endpoint is on an earlier or unconfirmed share basis",
    );
  }
  const growth = mixedBasis ? undefined : cagr;
  const facts = financialStatementFacts(series);
  const concept = (facts.find((fact) => isContinuingScope(conceptScope(fact.concept))) ?? facts[0])
    ?.concept;
  return {
    key: definition.key,
    label: definition.label,
    unit: definition.unit,
    ...(concept !== undefined ? { concept } : {}),
    annual,
    ...(ttm !== undefined ? { ttm } : {}),
    ...(growth !== undefined ? { cagr: growth } : {}),
    notes,
  };
}

// A TTM point is flagged when any of its FY, YTD, or prior-YTD components is.
function notedPeriods(
  artifact: FinancialStatementsArtifact,
  seriesKeys: readonly FinancialStatementSeriesKey[],
): (point: FundamentalHistoryPoint) => boolean {
  const noted = new Set(
    artifact.omissionNotes.flatMap((note) =>
      note.seriesKey !== undefined &&
      seriesKeys.includes(note.seriesKey) &&
      note.periodKey !== undefined
        ? [note.periodKey]
        : [],
    ),
  );
  const within = endsWithin([...noted].map((key) => key.split("|").at(-1)!));
  const components = Object.values(
    artifact.statements.incomeStatement.netIncome.ttm?.components ?? {},
  ).map((fact) => fact.periodKey);
  return (point) =>
    point.form === "TTM" ? components.some((key) => noted.has(key)) : within(point);
}

function noncontrollingPeriods(
  artifact: FinancialStatementsArtifact,
): (point: FundamentalHistoryPoint) => boolean {
  const noted = notedPeriods(artifact, ["consolidatedNetIncome", "consolidatedContinuingIncome"]);
  const { netIncome, consolidatedNetIncome } = artifact.statements.incomeStatement;
  const consolidated = new Map(
    financialStatementFacts(consolidatedNetIncome).map((fact) => [fact.periodKey, fact.value]),
  );
  const ttmDiverges = Object.values(netIncome.ttm?.components ?? {}).some((fact) => {
    const value = consolidated.get(fact.periodKey);
    return value !== undefined && value !== fact.value;
  });
  return (point) => noted(point) || (point.form === "TTM" && ttmDiverges);
}

export function deriveFundamentalHistoryFromFinancialStatements(
  artifact: FinancialStatementsArtifact,
): FundamentalHistoryArtifact {
  const raw = Object.fromEntries(
    DEFINITIONS.map((definition) => [definition.key, rawSeries(artifact, definition)]),
  ) as FundamentalHistoryRawSeries;
  return {
    version: 1,
    generatedAt: artifact.generatedAt,
    symbol: artifact.symbol,
    sourceId: artifact.sourceId,
    ...(artifact.sourceUrl !== undefined ? { sourceUrl: artifact.sourceUrl } : {}),
    series: buildFundamentalHistorySeries(
      raw,
      totalOperationsScopes(
        (key) =>
          latestFinancialStatementFact(
            financialStatementFacts(financialStatementSeriesByKey(artifact, key)!),
          )?.periodEnd,
      ),
      {
        continuing: rawSeries(artifact, {
          ...CONTINUING_INCOME_HISTORY,
          canonicalKey: "continuingIncome",
        }),
        consolidatedContinuing: rawSeries(artifact, {
          ...CONTINUING_INCOME_HISTORY,
          canonicalKey: "consolidatedContinuingIncome",
        }),
        consolidated: rawSeries(artifact, {
          ...CONTINUING_INCOME_HISTORY,
          canonicalKey: "consolidatedNetIncome",
        }),
        reportsDiscontinued: notedPeriods(artifact, ["continuingIncome"]),
        reportsNoncontrolling: noncontrollingPeriods(artifact),
      },
    ),
  };
}
