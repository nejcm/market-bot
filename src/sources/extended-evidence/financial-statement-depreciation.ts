import type { ExtendedEvidenceItem } from "../../domain/evidence";
import { DA_CASH_FLOW_FACT_PREFIX } from "../sec-segment-facts";
import { DA_CALC_PREFIX, DA_CALC_READ_KEY } from "../sec-calculation-linkbase";
import {
  CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES,
  DEPRECIATION_AND_AMORTIZATION_COMPONENTS,
  DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE,
  type FinancialStatementSeriesDefinition,
} from "./financial-statement-definitions";
import { compareFinancialStatementFacts } from "./financial-statement-selection";
import { type FinancialStatementNote } from "./financial-statements-contract";
import {
  type ParsedFact,
  taxonomyRoot,
  unitFacts,
  compositeFromContributors,
  withCompositeFirstPublicAt,
  periodType,
  periodKey,
} from "./financial-statement-facts";

function componentTolerance(value: number): number {
  return Math.abs(value) * DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE;
}

// `<accession>|<concept>|<start>|<end>` -> whether that filing's cash-flow table shows the fact beside intangible amortization.
function depreciationPresentation(
  filings: readonly ExtendedEvidenceItem[],
): ReadonlyMap<string, boolean> {
  return new Map(
    filings.flatMap(({ metrics }) =>
      Object.entries(metrics ?? {}).flatMap(([key, value]) =>
        key.startsWith(DA_CASH_FLOW_FACT_PREFIX)
          ? [
              [
                `${String(metrics?.accessionNumber)}|${key.slice(DA_CASH_FLOW_FACT_PREFIX.length)}`,
                value === 1,
              ] as const,
            ]
          : [],
      ),
    ),
  );
}

// Accession -> D&A-like descendants of operating cash flow in that filing's calculation linkbase, with weights.
function depreciationCalculation(
  filings: readonly ExtendedEvidenceItem[],
): ReadonlyMap<string, ReadonlyMap<string, number>> {
  return new Map(
    filings.flatMap(({ metrics }) =>
      metrics?.[DA_CALC_READ_KEY] === "true" || metrics?.[DA_CALC_READ_KEY] === "conflict"
        ? [
            [
              String(metrics.accessionNumber),
              new Map(
                Object.entries(metrics).flatMap(([key, value]) =>
                  key.startsWith(DA_CALC_PREFIX)
                    ? [[key.slice(DA_CALC_PREFIX.length), Number(value)] as const]
                    : [],
                ),
              ),
            ] as const,
          ]
        : [],
    ),
  );
}

export function factsForDepreciationAndAmortization(
  payload: unknown,
  definition: FinancialStatementSeriesDefinition,
  eligible: (fact: ParsedFact) => boolean,
  filings: readonly ExtendedEvidenceItem[],
): { readonly facts: readonly ParsedFact[]; readonly notes: readonly FinancialStatementNote[] } {
  const root = taxonomyRoot(payload, "us-gaap");
  if (root === undefined) {
    return { facts: [], notes: [] };
  }
  const presentation = depreciationPresentation(filings);
  const calculation = depreciationCalculation(filings);
  const calculationConflicts = new Set(
    filings.flatMap(({ metrics }) =>
      metrics?.[DA_CALC_READ_KEY] === "conflict" ? [String(metrics.accessionNumber)] : [],
    ),
  );
  const calculationFetchFailures = new Set(
    filings.flatMap(({ metrics }) =>
      metrics?.[DA_CALC_READ_KEY] === "fetch-failed" ? [String(metrics.accessionNumber)] : [],
    ),
  );
  const totals = definition.concepts["us-gaap"];
  const concepts = [
    ...totals,
    ...DEPRECIATION_AND_AMORTIZATION_COMPONENTS.flat(),
    ...CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES,
  ];
  const periods = new Map<string, ParsedFact[]>();
  for (const fact of concepts.flatMap((concept) => unitFacts("us-gaap", root, concept))) {
    const key = `${fact.periodStart ?? "instant"}|${fact.periodEnd}|${fact.unit}|${periodType(fact, definition)}`;
    periods.set(key, [...(periods.get(key) ?? []), fact]);
  }
  const [depreciationConcepts = [], amortizationConcepts = []] =
    DEPRECIATION_AND_AMORTIZATION_COMPONENTS;
  const filingColumns = (periodFacts: readonly ParsedFact[]) =>
    [...new Set(periodFacts.map((fact) => fact.accessionNumber))].map((accessionNumber) =>
      [...new Set(periodFacts.map((fact) => fact.concept))].flatMap((concept) => {
        const [fact] = periodFacts
          .filter(
            (candidate) =>
              candidate.accessionNumber === accessionNumber &&
              candidate.concept === concept &&
              eligible(candidate),
          )
          .toSorted(compareFinancialStatementFacts);
        return fact === undefined ? [] : [fact];
      }),
    );
  // DDA above same-column depreciation already carries amortization, so a larger amortization tag is a scope or tagging mismatch (GPN, ANET).
  const containsAmortization = (total: ParsedFact, column: readonly ParsedFact[]) =>
    column.some(
      (fact) =>
        depreciationConcepts.includes(fact.concept) &&
        total.value - fact.value > componentTolerance(total.value),
    );
  // Fallback without a parsed primary document: DDA below intangible amortization in any column of its filing (LTRX FY2025).
  const partialTotalFilings = new Set(
    [...periods.values()].flatMap((periodFacts) =>
      filingColumns(periodFacts).flatMap((column) =>
        column
          .filter(
            (total) =>
              totals.includes(total.concept) &&
              total.value !== 0 &&
              !containsAmortization(total, column) &&
              column.some(
                (component) =>
                  amortizationConcepts.includes(component.concept) &&
                  component.value - total.value > componentTolerance(component.value),
              ),
          )
          .map((total) => `${total.concept}|${total.accessionNumber}`),
      ),
    ),
  );
  const partialTotalNote = (total: ParsedFact, periodFacts: readonly ParsedFact[]) => {
    const sibling = presentation.get(
      `${String(total.accessionNumber)}|${total.concept}|${total.periodStart ?? "instant"}|${total.periodEnd}`,
    );
    if (sibling === true) {
      return `the cash-flow statement in filing ${String(total.accessionNumber)} tags ${total.concept} (${String(total.value)}) beside a separate AmortizationOfIntangibleAssets line, so it is not total D&A`;
    }
    if (
      sibling === false ||
      !partialTotalFilings.has(`${total.concept}|${total.accessionNumber}`)
    ) {
      return undefined;
    }
    const column = filingColumns(periodFacts).find((facts) => facts.includes(total)) ?? [];
    return containsAmortization(total, column)
      ? undefined
      : `${total.concept} (${String(total.value)}) in filing ${total.accessionNumber} is below a same-filing component in another period, so it is not proven total D&A (no parsed cash-flow statement in this filing shows the line)`;
  };
  const notes: FinancialStatementNote[] = [];
  const resolvedFacts = [...periods.values()].flatMap((periodFacts) => {
    // A zero combined caption is a reclassified line (PYPL 2018); a zero component is a real zero (HRMN, LTRX).
    const facts = periodFacts.filter((fact) => fact.value !== 0 || !totals.includes(fact.concept));
    const candidates = facts.filter((fact) => eligible(fact));
    const latest = (concept: string) =>
      candidates
        .filter((fact) => fact.concept === concept && fact.periodStart !== undefined)
        .toSorted(compareFinancialStatementFacts)[0];
    const totalFacts = totals.flatMap((concept) => {
      const fact = latest(concept);
      return fact === undefined ? [] : [fact];
    });
    const cashFlowLines = CASH_FLOW_DEPRECIATION_AND_AMORTIZATION_LINES.flatMap((concept) => {
      const fact = latest(concept);
      return fact === undefined ? [] : [fact];
    });
    const cashFlowSum = cashFlowLines.reduce((sum, fact) => sum + fact.value, 0);
    const contradicted = (value: number, period: ParsedFact): boolean => {
      if (cashFlowLines.length === 0 || cashFlowSum - value <= componentTolerance(cashFlowSum)) {
        return false;
      }
      notes.push({
        code: "incomplete-composite-series",
        seriesKey: definition.key,
        periodKey: periodKey(period),
        message: `SEC depreciation and amortization for ${period.periodStart ?? "instant"} to ${period.periodEnd} omitted: the selected value (${String(value)}) is below the filed cash-flow D&A lines (${String(cashFlowSum)})`,
      });
      return true;
    };
    // DDOG/CRM/EBAY tag PP&E-only DDA beside a higher DA total; the reverse split (AAPL, AMGN) is not proof.
    const belowOtherTotal = (period: ParsedFact): boolean => {
      const higher = totalFacts.find(
        (fact) =>
          fact.concept !== period.concept &&
          fact.value - period.value > componentTolerance(fact.value),
      );
      if (higher === undefined) {
        return false;
      }
      notes.push({
        code: "incomplete-composite-series",
        seriesKey: definition.key,
        periodKey: periodKey(period),
        message: `SEC depreciation and amortization for ${period.periodStart ?? "instant"} to ${period.periodEnd} omitted: ${period.concept} (${String(period.value)}) is below the same-period ${higher.concept} (${String(higher.value)})`,
      });
      return true;
    };
    // AMD FY2020-22, HLIT FY2025: a filed component or cash-flow line proves D&A exists, so a partial set is a gap, not "not filed".
    const incompleteComponentsNote = (
      present: readonly ParsedFact[],
      lines: readonly ParsedFact[],
    ): void => {
      const period = present[0] ?? lines[0];
      if (period === undefined || periodType(period, definition) !== "annual") {
        return;
      }
      const missing = DEPRECIATION_AND_AMORTIZATION_COMPONENTS.filter(
        (aliases) => !present.some((fact) => aliases.includes(fact.concept)),
      ).map((aliases) => aliases[0]);
      const filed = lines.map((fact) => `${fact.concept} ${String(fact.value)}`).join(", ");
      const reason =
        lines.length === 0
          ? "no filed fact proves the filed components are total D&A"
          : `the filed cash-flow line (${filed}) is not proven to be total D&A`;
      notes.push({
        code: "incomplete-composite-series",
        seriesKey: definition.key,
        periodKey: periodKey(period),
        message: `SEC depreciation and amortization for ${period.periodStart ?? "instant"} to ${period.periodEnd} omitted: no combined fact and no ${missing.join(", ")} component; ${reason}`,
      });
    };
    const totalConcept = totalFacts[0]?.concept;
    const [total] = candidates
      .filter((fact) => fact.concept === totalConcept)
      .toSorted(compareFinancialStatementFacts);
    const contributors = DEPRECIATION_AND_AMORTIZATION_COMPONENTS.flatMap((aliases) => {
      const concept = aliases.find((alias) => candidates.some((fact) => fact.concept === alias));
      const [selected] = candidates
        .filter((fact) => fact.concept === concept && fact.periodStart !== undefined)
        .toSorted(compareFinancialStatementFacts);
      return selected === undefined ? [] : [selected];
    });
    if (
      total !== undefined &&
      !contributors.some(
        (fact) =>
          fact.value - total.value >
          Math.abs(fact.value) * DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE,
      )
    ) {
      const partial = partialTotalNote(total, periodFacts);
      if (partial !== undefined) {
        notes.push({
          code: "incomplete-composite-series",
          seriesKey: definition.key,
          periodKey: periodKey(total),
          message: `SEC depreciation and amortization for ${total.periodStart ?? "instant"} to ${total.periodEnd} omitted: ${partial}`,
        });
        return [];
      }
      return contradicted(total.value, total) || belowOtherTotal(total)
        ? []
        : facts.filter((fact) => fact.concept === totalConcept);
    }
    if (contributors.length !== DEPRECIATION_AND_AMORTIZATION_COMPONENTS.length) {
      if (total !== undefined) {
        notes.push({
          code: "incomplete-composite-series",
          seriesKey: definition.key,
          periodKey: periodKey(total),
          message: `SEC depreciation and amortization for ${total.periodStart ?? "instant"} to ${total.periodEnd} omitted: the combined fact is more than ${String(DEPRECIATION_AND_AMORTIZATION_COMPONENT_TOLERANCE * 100)}% below a same-period component and the matching component set is incomplete`,
        });
      } else {
        incompleteComponentsNote(contributors, cashFlowLines);
      }
      return [];
    }
    const [depreciation, amortization] = contributors as [ParsedFact, ParsedFact];
    const sameFilingAmortization =
      cashFlowLines.length === 1 &&
      cashFlowLines[0]!.concept === "AdjustmentForAmortization" &&
      cashFlowLines[0]!.accessionNumber === amortization.accessionNumber
        ? cashFlowLines[0]
        : undefined;
    const amortizationGap =
      sameFilingAmortization === undefined ? 0 : sameFilingAmortization.value - amortization.value;
    // MRK FY2025: the note rounds intangible amortization (2.8B); the cash-flow line carries the filed 2,793M.
    const faceAmortization =
      Math.abs(amortizationGap) <= componentTolerance(sameFilingAmortization?.value ?? 0)
        ? sameFilingAmortization
        : undefined;
    const [faceDepreciation, faceAdjustment] = cashFlowLines;
    // AMD FY2023-25: the face D&A line plus a same-filing intangible add-back is total D&A; a higher add-back may be contract costs (DDOG).
    const facePair =
      cashFlowLines.length === 2 &&
      faceDepreciation!.accessionNumber === faceAdjustment!.accessionNumber &&
      depreciation.value + amortization.value - cashFlowSum <= componentTolerance(cashFlowSum) &&
      faceAdjustment!.value - amortization.value <= componentTolerance(amortization.value) &&
      !cashFlowLines.some((line) =>
        candidates.some(
          (fact) =>
            fact.concept === line.concept &&
            fact.accessionNumber === line.accessionNumber &&
            fact.value !== line.value,
        ),
      )
        ? cashFlowLines
        : undefined;
    const selected =
      facePair ??
      (faceAmortization === undefined ? contributors : [depreciation, faceAmortization]);
    if (
      contradicted(
        selected.reduce((sum, fact) => sum + fact.value, 0),
        selected[0]!,
      )
    ) {
      return [];
    }
    const accession = String(selected[0]!.accessionNumber);
    const calcChildren = selected.every((fact) => String(fact.accessionNumber) === accession)
      ? calculation.get(accession)
      : undefined;
    // ORCL, ABBV, GLW, AMD FY2025: the cash-flow calculation adds exactly these two concepts into operating cash flow, so their sum is the face D&A.
    const calcProven =
      calcChildren?.size === 2 && selected.every((fact) => calcChildren.get(fact.concept) === 1);
    if (!calcProven) {
      const reason =
        calcChildren === undefined
          ? calculationFetchFailures.has(accession)
            ? `filing ${accession}'s calculation linkbase could not be fetched`
            : "no same-filing calculation linkbase was read"
          : calcChildren.size === 0 && calculationConflicts.has(accession)
            ? `filing ${accession}'s operating cash-flow calculation roles disagree`
            : `filing ${accession}'s cash-flow calculation adds ${[...calcChildren.keys()].join(", ") || "no D&A line"} into operating cash flow`;
      const [first] = selected;
      notes.push({
        code: "unchecked-component-sum",
        seriesKey: definition.key,
        periodKey: periodKey(first!),
        message: `SEC depreciation and amortization for ${String(first!.periodStart)} to ${first!.periodEnd} is ${facePair !== undefined ? "cash-flow OtherDepreciationAndAmortization + AdjustmentForAmortization" : selected === contributors ? "depreciation + intangible amortization" : "depreciation + cash-flow AdjustmentForAmortization"}, not checked against the filed cash-flow statement: ${reason}`,
      });
    }
    if (amortizationGap > componentTolerance(sameFilingAmortization?.value ?? 0)) {
      notes.push({
        code: "unreconciled-component",
        seriesKey: definition.key,
        periodKey: periodKey(amortization),
        message: `SEC depreciation and amortization for ${amortization.periodStart ?? "instant"} to ${amortization.periodEnd} uses AmortizationOfIntangibleAssets (${String(amortization.value)}); the same-filing cash-flow AdjustmentForAmortization (${String(sameFilingAmortization!.value)}) is higher and is not proven to be intangible amortization`,
      });
    }
    return [
      withCompositeFirstPublicAt(
        compositeFromContributors(selected),
        definition,
        candidates,
        new Set(),
      ),
    ];
  });
  return { facts: resolvedFacts, notes };
}
