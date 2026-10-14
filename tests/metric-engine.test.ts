import { describe, expect, test } from "bun:test";
import { violatesResearchOnly } from "../src/domain/research-language";
import {
  evaluateMetricSection,
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
