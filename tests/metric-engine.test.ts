import { describe, expect, test } from "bun:test";
import { violatesResearchOnly } from "../src/domain/research-language";
import {
  evaluateMetricSection,
  isCashFlowInput,
  type MetricDefinition,
} from "../src/sources/extended-evidence/metric-engine";

const CTX = { symbol: "test" };

function input(value: number, sourceIds: readonly string[]) {
  return { label: "input", value, artifact: "statements" as const, unit: "USD", sourceIds };
}

const valueMetric: MetricDefinition = {
  id: "amount",
  label: "Amount",
  unit: "currency",
  basis: "test basis",
  compute: () => ({
    status: "value",
    value: 3,
    inputs: [input(1, ["sec-a", "quote-b"]), input(2, ["sec-a"])],
  }),
};

const notMeaningfulMetric: MetricDefinition = {
  id: "ratio",
  label: "Ratio",
  unit: "ratio-percent",
  basis: "test basis",
  compute: () => ({ status: "not-meaningful", reason: "denominator is not positive" }),
};

const missingMetric: MetricDefinition = {
  id: "other",
  label: "Other",
  unit: "number",
  basis: "test basis",
  compute: () => ({ status: "missing", reason: "no input fact" }),
};

describe("evaluateMetricSection", () => {
  test("unions and dedupes input sourceIds onto the metric", () => {
    const { section } = evaluateMetricSection("s", "Section", [valueMetric], CTX);

    expect(section.metrics[0]).toMatchObject({ status: "value", value: 3 });
    expect(section.metrics[0]?.sourceIds).toEqual(["sec-a", "quote-b"]);
  });

  test("emits no gap when every metric has a value", () => {
    expect(evaluateMetricSection("s", "Section", [valueMetric], CTX).sourceGaps).toEqual([]);
  });

  test("one diagnostic no-cap gap when nothing is missing", () => {
    const { sourceGaps } = evaluateMetricSection(
      "s",
      "Section",
      [valueMetric, notMeaningfulMetric],
      CTX,
    );

    expect(sourceGaps).toEqual([
      {
        source: "s",
        message:
          "Section metrics for TEST not computed: Ratio not-meaningful (denominator is not positive)",
        symbol: "TEST",
        provider: "market-bot",
        capability: "extended-evidence",
        cause: "suppressed-by-design",
        evidenceQualityImpact: "no-cap",
        triage: "diagnostic",
      },
    ]);
  });

  test("one material gap listing every unresolved metric when one is missing", () => {
    const { sourceGaps } = evaluateMetricSection(
      "s",
      "Section",
      [notMeaningfulMetric, missingMetric, { ...missingMetric, id: "again", label: "Again" }],
      CTX,
    );

    expect(sourceGaps).toHaveLength(1);
    expect(sourceGaps[0]).toMatchObject({
      triage: "material",
      cause: "provider-data-missing",
      evidenceQualityImpact: "no-cap",
    });
    expect(sourceGaps[0]?.message).toBe(
      "Section metrics for TEST not computed: Ratio not-meaningful (denominator is not positive); Other, Again missing (no input fact)",
    );
    expect(violatesResearchOnly(sourceGaps[0]!.message)).toBeNull();
  });

  test("names a repeated label once with each period it is missing for", () => {
    const segmentOperatingIncome = (periodStart: string): MetricDefinition => ({
      ...missingMetric,
      id: `seg-oi-${periodStart}`,
      label: "Seg OI",
      compute: () => ({
        status: "missing",
        reason: "no input fact",
        periodEnd: "2026-09-30",
        inputs: [{ ...input(1, ["sec-a"]), periodStart, periodEnd: "2026-09-30" }],
      }),
    });
    const { sourceGaps } = evaluateMetricSection(
      "s",
      "Section",
      [
        segmentOperatingIncome("2026-07-01"),
        segmentOperatingIncome("2026-01-01"),
        segmentOperatingIncome("2026-01-01"),
        { ...missingMetric, id: "solo", label: "Solo" },
      ],
      CTX,
    );

    expect(sourceGaps[0]?.message).toBe(
      "Section metrics for TEST not computed: Seg OI (2026-07-01 to 2026-09-30, 2026-01-01 to 2026-09-30), Solo missing (no input fact)",
    );
    expect(violatesResearchOnly(sourceGaps[0]!.message)).toBeNull();
  });

  test("a repeated label keeps its period when every occurrence shares it", () => {
    const repeated: MetricDefinition = {
      ...missingMetric,
      label: "Repeated",
      compute: () => ({ status: "missing", reason: "absent", periodEnd: "2026-09-30" }),
    };
    const { sourceGaps } = evaluateMetricSection(
      "s",
      "Section",
      [repeated, { ...repeated, id: "again" }],
      CTX,
    );

    expect(sourceGaps[0]?.message).toBe(
      "Section metrics for TEST not computed: Repeated (2026-09-30) missing (absent)",
    );
  });

  test("diagnostic when every missing metric was never filed; any other missing keeps it material", () => {
    const notFiledMetric: MetricDefinition = {
      ...missingMetric,
      id: "dividends",
      label: "Dividends",
      compute: () => ({
        status: "missing",
        reason: "dividends paid not filed by the issuer",
        cause: "not-filed",
      }),
    };
    const onlyNotFiled = evaluateMetricSection(
      "s",
      "Section",
      [valueMetric, notMeaningfulMetric, notFiledMetric],
      CTX,
    );
    const mixed = evaluateMetricSection("s", "Section", [notFiledMetric, missingMetric], CTX);

    expect(onlyNotFiled.section.metrics[2]).toMatchObject({
      status: "missing",
      cause: "not-filed",
    });
    expect(onlyNotFiled.sourceGaps[0]).toMatchObject({
      cause: "provider-data-missing",
      triage: "diagnostic",
    });
    expect(onlyNotFiled.sourceGaps[0]?.message).toContain(
      "Dividends missing (dividends paid not filed by the issuer)",
    );
    expect(mixed.sourceGaps[0]?.triage).toBe("material");
  });

  test("suppressed-by-design only when every missing metric is outside the price history window", () => {
    const outsideWindowMetric: MetricDefinition = {
      ...missingMetric,
      id: "multiple",
      label: "Multiple",
      compute: () => ({
        status: "missing",
        reason: "price-history-unavailable",
        cause: "outside-price-history-window",
      }),
    };
    const gapFor = (definitions: readonly MetricDefinition[]) =>
      evaluateMetricSection("s", "Section", definitions, CTX).sourceGaps[0];

    expect(gapFor([valueMetric, notMeaningfulMetric, outsideWindowMetric])).toMatchObject({
      cause: "suppressed-by-design",
      triage: "diagnostic",
    });
    expect(gapFor([outsideWindowMetric, missingMetric])).toMatchObject({
      cause: "provider-data-missing",
      triage: "material",
    });
    expect(gapFor([missingMetric])?.cause).toBe("provider-data-missing");
  });

  test("applicable short-circuits compute into not-applicable with no inputs", () => {
    let computed = 0;
    const gated: MetricDefinition = {
      ...valueMetric,
      applicable: () => "economically inapplicable",
      compute: () => {
        computed += 1;
        return valueMetric.compute(CTX);
      },
    };

    const { section, sourceGaps } = evaluateMetricSection("s", "Section", [gated], CTX);

    expect(computed).toBe(0);
    expect(section.metrics[0]).toMatchObject({
      status: "not-applicable",
      reason: "economically inapplicable",
      inputs: [],
      sourceIds: [],
    });
    expect(section.metrics[0]?.value).toBeUndefined();
    expect(sourceGaps[0]?.triage).toBe("diagnostic");
  });
});

describe("depository cash-flow gate", () => {
  const CASH_FLOW_REASON =
    "depository issuer (SIC 6022): operating cash flow moves with deposits, loans and trading assets, so cash-flow metrics are not meaningful";
  // No cashFlowBased flag: the input alone must trip the gate.
  const unflagged: MetricDefinition = {
    id: "ocfRatio",
    label: "OCF ratio",
    unit: "ratio",
    basis: "test basis",
    compute: () => ({
      status: "value",
      value: 2,
      inputs: [{ ...input(10, ["sec-a"]), series: "operatingCashFlow" }],
    }),
  };
  const flagged: MetricDefinition = { ...missingMetric, cashFlowBased: true };
  const evaluate = (definitions: readonly MetricDefinition[], depositorySic?: string) =>
    evaluateMetricSection("section", "Section", definitions, {
      ...CTX,
      ...(depositorySic === undefined ? {} : { depositorySic }),
    }).section.metrics.map(({ status, reason, inputs }) => ({ status, reason, inputs }));

  test("withholds a row with a cash-flow input for a depository issuer", () => {
    expect(evaluate([unflagged, flagged, valueMetric], "6022")).toEqual([
      { status: "not-applicable", reason: CASH_FLOW_REASON, inputs: [] },
      { status: "not-applicable", reason: CASH_FLOW_REASON, inputs: [] },
      expect.objectContaining({ status: "value" }),
    ]);
  });

  test("leaves a non-bank's cash-flow rows untouched", () => {
    expect(evaluate([unflagged, flagged])).toEqual([
      expect.objectContaining({ status: "value" }),
      expect.objectContaining({ status: "missing", reason: "no input fact" }),
    ]);
  });

  test("detects summary evidence keys as cash-flow inputs", () => {
    expect(isCashFlowInput({ key: "capex" })).toBe(true);
    expect(isCashFlowInput({ key: "freeCashFlowProxy" })).toBe(true);
    expect(isCashFlowInput({ series: "netIncome" })).toBe(false);
    expect(isCashFlowInput({ key: "trailingPE" })).toBe(false);
  });
});
