import { describe, expect, test } from "bun:test";
import { violatesResearchOnly } from "../src/domain/research-language";
import { sourceGapReportText } from "../src/domain/source-gaps";
import type { Source } from "../src/domain/sources";
import { renderMarkdownReport } from "../src/report/markdown";
import { validateResearchReport } from "../src/report/schema";
import { projectExtendedEvidenceReportExtras } from "../src/research/extended-evidence-projections";
import { deriveCapitalOwnershipArtifact } from "../src/sources/extended-evidence/capital-ownership";
import { resolveMetricReferences } from "../src/research/metric-references";
import { capitalReturnSection } from "../src/sources/extended-evidence/capital-return";
import { NEGATIVE_CAPEX_REASON } from "../src/sources/extended-evidence/financial-statement-definitions";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import type { FinancialStatementsArtifact } from "../src/sources/extended-evidence/financial-statements-contract";
import type { MetricContext, MetricInput } from "../src/sources/extended-evidence/metric-engine";
import { resolveMarketSnapshotPriceAsOf } from "../src/domain/market-data";
import { collectedSources, marketSnapshot, researchReport } from "./support/fixtures";
import { assertMetricSectionInvariants } from "./support/run-fixtures/assertions";

const SOURCE_ID = "extended-sec-edgar-test-fundamentals";
const QUOTE_SOURCE_ID = "yahoo-quote-test";
const AS_OF = "2026-07-23T00:00:00.000Z";
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024, 2025];

type Fact = Record<string, unknown>;
type MetricRecord = Record<string, unknown>;

function fy(value: number, year: number, overrides: Fact = {}): Fact {
  return {
    start: `${String(year)}-01-01`,
    end: `${String(year)}-12-31`,
    val: value,
    accn: `test-${String(year)}`,
    fy: year,
    fp: "FY",
    form: "10-K",
    filed: `${String(year + 1)}-02-15`,
    ...overrides,
  };
}

function series(unit: string, valueFor: (year: number) => number | undefined): Fact {
  return {
    units: {
      [unit]: YEARS.flatMap((year) => {
        const value = valueFor(year);
        return value === undefined ? [] : [fy(value, year)];
      }),
    },
  };
}

function dps(year: number): number {
  return 0.4 + 0.04 * (year - 2019);
}

function usGaap(overrides: Record<string, Fact | undefined> = {}): Record<string, Fact> {
  const concepts: Record<string, Fact | undefined> = {
    Revenues: series("USD", (year) => 1000 + year),
    NetCashProvidedByUsedInOperatingActivities: series("USD", () => 400),
    PaymentsToAcquirePropertyPlantAndEquipment: series("USD", () => 100),
    PaymentsOfDividends: series("USD", () => 60),
    PaymentsForRepurchaseOfCommonStock: series("USD", () => 90),
    WeightedAverageNumberOfDilutedSharesOutstanding: series(
      "shares",
      (year) => 20_000 - 400 * (year - 2019),
    ),
    ShareBasedCompensation: series("USD", () => 25),
    CommonStockDividendsPerShareDeclared: series("USD/shares", (year) => dps(year)),
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(concepts).filter((entry): entry is [string, Fact] => entry[1] !== undefined),
  );
}

function context(
  concepts: Record<string, Fact>,
  overrides: Partial<MetricContext> = {},
): MetricContext {
  const payload = { facts: { "us-gaap": concepts } };
  const statements = deriveFinancialStatements(payload, {
    symbol: "TEST",
    generatedAt: AS_OF,
    analysisAsOf: AS_OF,
    sourceId: SOURCE_ID,
  });
  return {
    symbol: "TEST",
    statements,
    capitalOwnership: deriveCapitalOwnershipArtifact(payload, statements),
    quote: { marketCap: 10_000, currency: "USD", asOf: AS_OF, sourceId: QUOTE_SOURCE_ID },
    ...overrides,
  };
}

function quoteless({ quote: _quote, ...rest }: MetricContext): MetricContext {
  return rest;
}

const evaluated: ReturnType<typeof capitalReturnSection>[] = [];

function evaluate(ctx: MetricContext) {
  const result = capitalReturnSection(ctx);
  evaluated.push(result);
  return {
    ...result,
    metric: (id: string) => {
      const metric = result.section.metrics.find((candidate) => candidate.id === id);
      if (metric === undefined) {
        throw new Error(`no metric ${id}`);
      }
      return metric;
    },
  };
}

function renderMaterialGaps(ctx: MetricContext): string {
  const { sourceGaps } = capitalReturnSection(ctx);
  const markdown = renderMarkdownReport(
    researchReport({
      jobType: "equity",
      symbol: "TEST",
      dataGaps: sourceGaps.map((gap) => sourceGapReportText(gap)),
    }),
    undefined,
    { sourceGaps },
  );
  return markdown.slice(markdown.indexOf("## Material Data Gaps"), markdown.indexOf("## Appendix"));
}

describe("capitalReturnSection", () => {
  test("AAPL-shaped payer: amounts, yields, payout ratios and share-count change", () => {
    const result = evaluate(context(usGaap()));

    expect(result.section).toMatchObject({ id: "capital-return", title: "Capital Return" });
    expect(result.metric("buybacksLatestFy")).toMatchObject({
      status: "value",
      value: 90,
      currency: "USD",
      periodEnd: "2025-12-31",
      sourceIds: [SOURCE_ID],
    });
    expect(result.metric("dividendsLatestFy")).toMatchObject({ status: "value", value: 60 });
    expect(result.metric("buybackYield").value).toBeCloseTo(0.009, 12);
    expect(result.metric("dividendYieldFiled").value).toBeCloseTo(0.006, 12);
    expect(result.metric("shareholderYield")).toMatchObject({
      status: "value",
      sourceIds: [SOURCE_ID, QUOTE_SOURCE_ID],
    });
    expect(result.metric("shareholderYield").value).toBeCloseTo(0.015, 12);
    expect(result.metric("fcfPayoutRatio").value).toBeCloseTo(60 / 300, 12);
    expect(result.metric("totalPayoutToFcf").value).toBeCloseTo(150 / 300, 12);
    expect(result.metric("shareCountChange1y").value).toBeCloseTo(17_600 / 18_000 - 1, 12);
    expect(result.metric("shareCountChange5y").value).toBeCloseTo(17_600 / 19_600 - 1, 12);
    expect(result.metric("shareCountChange5y").inputs.map((input) => input.periodEnd)).toEqual([
      "2020-12-31",
      "2025-12-31",
    ]);
    expect(result.metric("shareCountTrend")).toMatchObject({
      status: "value",
      value: "declining",
    });
    expect(result.metric("sbcLatestFy")).toMatchObject({
      status: "value",
      value: 25,
      currency: "USD",
      inputs: [{ artifact: "capitalOwnership", series: "stockBasedCompensation" }],
    });
    expect(result.metric("totalPayoutToFcf").inputs.map((input) => input.series)).toEqual([
      "dividendsPaid",
      "shareRepurchases",
      "operatingCashFlow",
      "capitalExpenditure",
    ]);
    expect(result.metric("dpsLatestFy")).toMatchObject({
      status: "value",
      unit: "currency-per-share",
      currency: "USD",
      periodEnd: "2025-12-31",
      inputs: [{ series: "dividendsPerShare", unit: "USD/shares" }],
    });
    expect(result.metric("dpsLatestFy").value).toBeCloseTo(dps(2025), 12);
    expect(result.metric("dpsCagr3y").value).toBeCloseTo(
      (dps(2025) / dps(2022)) ** (1 / 3) - 1,
      12,
    );
    expect(result.metric("dpsCagr5y").value).toBeCloseTo(
      (dps(2025) / dps(2020)) ** (1 / 5) - 1,
      12,
    );
    expect(
      resolveMetricReferences(
        researchReport({
          keyFindings: [{ text: "DPS grew <<metric:capital-return.dpsCagr3y>>.", sourceIds: [] }],
        }),
        [{ id: "capital-return", title: "Capital return", metrics: [result.metric("dpsCagr3y")] }],
      ).keyFindings[0]!.text,
    ).toMatch(/^DPS grew \+\d+\.\d% CAGR over 3y\.$/u);
    expect(result.metric("earliestDividendFyInHistory")).toMatchObject({
      status: "value",
      value: "FY2019",
      periodEnd: "2019-12-31",
    });
    expect(result.sourceGaps).toEqual([]);
  });

  test("GOOG-shaped dividend initiation: the latest FY anchors, earlier years do not matter", () => {
    const result = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: series("USD", (year) => (year >= 2024 ? 30 : undefined)),
          CommonStockDividendsPerShareDeclared: series("USD/shares", (year) =>
            year >= 2024 ? 0.2 : undefined,
          ),
        }),
      ),
    );

    expect(result.metric("dividendsLatestFy")).toMatchObject({ status: "value", value: 30 });
    expect(result.metric("shareholderYield").value).toBeCloseTo(0.012, 12);
    expect(result.metric("dpsLatestFy")).toMatchObject({ status: "value", value: 0.2 });
    expect(result.metric("earliestDividendFyInHistory").value).toBe("FY2024");
    expect(result.metric("dpsCagr3y")).toMatchObject({
      status: "missing",
      reason: "no annual dividends per share fact 3y before the fiscal year ending 2025-12-31",
    });
    expect(
      result.section.metrics.filter(({ status }) => status !== "value").map(({ id }) => id),
    ).toEqual(["dpsCagr3y", "dpsCagr5y"]);
  });

  test("buybacks-only issuer: never-filed dividends stay missing, never zero, gap diagnostic", () => {
    const result = evaluate(context(usGaap({ PaymentsOfDividends: undefined })));

    expect(result.metric("buybackYield").status).toBe("value");
    for (const id of [
      "dividendsLatestFy",
      "dividendYieldFiled",
      "shareholderYield",
      "fcfPayoutRatio",
      "totalPayoutToFcf",
    ]) {
      expect(result.metric(id)).toMatchObject({
        status: "missing",
        reason: "dividends paid not filed by the issuer",
        cause: "not-filed",
      });
      expect(result.metric(id).value).toBeUndefined();
    }
    expect(result.sourceGaps[0]).toMatchObject({
      source: "capital-return",
      cause: "provider-data-missing",
      triage: "diagnostic",
      evidenceQualityImpact: "no-cap",
    });
  });

  test("never-filed beside a stale series keeps the gap material", () => {
    const result = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: undefined,
          PaymentsForRepurchaseOfCommonStock: series("USD", (year) =>
            year <= 2020 ? 90 : undefined,
          ),
        }),
      ),
    );

    expect(result.metric("dividendsLatestFy").cause).toBe("not-filed");
    expect(result.metric("buybacksLatestFy")).toMatchObject({
      status: "missing",
      reason: "stale share repurchases as of 2020-12-31",
    });
    expect(result.metric("buybacksLatestFy").cause).toBeUndefined();
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("a concept filed only as interim or wrong-span facts is not not-filed", () => {
    const interimOnly = {
      units: {
        USD: [
          fy(30, 2025, { start: "2025-01-01", end: "2025-06-30", fp: "Q2", form: "10-Q" }),
          fy(60, 2025, { start: "2024-01-01", end: "2025-02-28" }),
        ],
      },
    };
    const result = evaluate(context(usGaap({ PaymentsOfDividends: interimOnly })));

    expect(result.metric("dividendsLatestFy")).toMatchObject({ status: "missing" });
    expect(result.metric("dividendsLatestFy").cause).toBeUndefined();
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("a never-filed numerator never hides a filed-but-filtered denominator", () => {
    const interimOcf = {
      units: {
        USD: YEARS.map((year) =>
          fy(400, year, { end: `${String(year)}-06-30`, fp: "Q2", form: "10-Q" }),
        ),
      },
    };
    const result = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: undefined,
          NetCashProvidedByUsedInOperatingActivities: interimOcf,
        }),
      ),
    );

    expect(result.metric("dividendsLatestFy").cause).toBe("not-filed");
    expect(result.metric("fcfPayoutRatio")).toMatchObject({
      status: "missing",
      reason: "no year-aligned annual operating cash flow fact",
    });
    expect(result.metric("totalPayoutToFcf")).toMatchObject({
      status: "missing",
      reason: "no same-period operating cash flow for the fiscal year ending 2025-12-31",
    });
    for (const id of ["fcfPayoutRatio", "totalPayoutToFcf"]) {
      expect(result.metric(id).cause).toBeUndefined();
    }
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("unfiled dividends: the filed FCF inputs must still join, fresh, in one fiscal year", () => {
    const fcf = (overrides: Record<string, Fact | undefined>) =>
      evaluate(context(usGaap({ PaymentsOfDividends: undefined, ...overrides }))).metric(
        "fcfPayoutRatio",
      );
    const unjoined = fcf({
      NetCashProvidedByUsedInOperatingActivities: series("USD", (year) =>
        year === 2025 ? 400 : undefined,
      ),
      PaymentsToAcquirePropertyPlantAndEquipment: series("USD", (year) =>
        year === 2024 ? 100 : undefined,
      ),
    });
    const stale = fcf({
      NetCashProvidedByUsedInOperatingActivities: series("USD", (year) =>
        year <= 2020 ? 400 : undefined,
      ),
      PaymentsToAcquirePropertyPlantAndEquipment: series("USD", (year) =>
        year <= 2020 ? 100 : undefined,
      ),
    });
    const joined = fcf({});

    expect(unjoined).toMatchObject({
      status: "missing",
      reason: "no same-period capital expenditure for the fiscal year ending 2025-12-31",
    });
    expect(unjoined.cause).toBeUndefined();
    expect(stale).toMatchObject({
      status: "missing",
      reason: "stale operating cash flow as of 2020-12-31",
    });
    expect(stale.cause).toBeUndefined();
    expect(joined).toMatchObject({
      status: "missing",
      reason: "dividends paid not filed by the issuer",
      cause: "not-filed",
      periodEnd: "2025-12-31",
    });
    expect(joined.inputs.map(({ series: key }) => key)).toEqual([
      "operatingCashFlow",
      "capitalExpenditure",
    ]);
  });

  test("a never-filed yield numerator never hides an absent quote", () => {
    const { quote: _quote, ...withoutQuote } = context(usGaap({ PaymentsOfDividends: undefined }));
    const result = evaluate(withoutQuote);

    expect(result.metric("dividendYieldFiled").cause).toBeUndefined();
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("a concept whose only rows are malformed is filed, not not-filed", () => {
    for (const val of [null, "60", {}]) {
      const ctx = context(
        usGaap({ PaymentsOfDividends: { units: { USD: [fy(0, 2025, { val })] } } }),
      );

      expect(ctx.statements?.unfiledSeries).not.toContain("dividendsPaid");
      expect(evaluate(ctx).metric("dividendsLatestFy").cause).toBeUndefined();
    }
  });

  test("an artifact without unfiled-series evidence never claims not-filed", () => {
    const ctx = context(usGaap({ PaymentsOfDividends: undefined }));
    expect(ctx.statements?.unfiledSeries).toContain("dividendsPaid");
    const { unfiledSeries: _unrecorded, ...preFlag } = ctx.statements!;
    const historical = evaluate({ ...ctx, statements: preFlag });

    expect(historical.metric("dividendsLatestFy")).toMatchObject({
      status: "missing",
      reason: "no year-aligned annual dividends paid fact",
    });
    expect(historical.metric("dividendsLatestFy").cause).toBeUndefined();
    expect(historical.sourceGaps[0]?.triage).toBe("material");
  });

  test("a filing dated after analysisAsOf does not count as filed", () => {
    const ctx = context(
      usGaap({ PaymentsOfDividends: { units: { USD: [fy(60, 2026, { filed: "2027-02-15" })] } } }),
    );

    expect(ctx.statements?.unfiledSeries).toContain("dividendsPaid");
  });

  test("filed zero dividends are a value of 0, never not-applicable", () => {
    const result = evaluate(context(usGaap({ PaymentsOfDividends: series("USD", () => 0) })));

    expect(result.metric("dividendsLatestFy")).toMatchObject({ status: "value", value: 0 });
    expect(result.metric("dividendYieldFiled")).toMatchObject({ status: "value", value: 0 });
    expect(result.section.metrics.some((metric) => metric.status === "not-applicable")).toBe(false);
  });

  test("R7(b): zero dividends paid never gates positive declared dividends per share", () => {
    const result = evaluate(context(usGaap({ PaymentsOfDividends: series("USD", () => 0) })));

    expect(result.metric("dividendsLatestFy")).toMatchObject({ status: "value", value: 0 });
    for (const id of ["dpsLatestFy", "dpsCagr3y", "dpsCagr5y", "earliestDividendFyInHistory"]) {
      expect(result.metric(id).status).toBe("value");
    }
  });

  test("R7: zero paid after earlier positive payments is never not-applicable", () => {
    const paidThenStopped = series("USD", (year) => (year <= 2022 ? 50 : 0));
    const withoutPerShare = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: paidThenStopped,
          CommonStockDividendsPerShareDeclared: undefined,
        }),
      ),
    );
    const withPerShare = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: paidThenStopped,
          CommonStockDividendsPerShareDeclared: series("USD/shares", (year) =>
            year <= 2022 ? 0.5 : 0,
          ),
        }),
      ),
    );

    for (const id of ["dpsLatestFy", "dpsCagr3y", "dpsCagr5y", "earliestDividendFyInHistory"]) {
      expect(withoutPerShare.metric(id)).toMatchObject({
        status: "missing",
        reason: "dividends per share not filed by the issuer",
        cause: "not-filed",
      });
    }
    expect(withPerShare.metric("dpsLatestFy")).toMatchObject({ status: "value", value: 0 });
    expect(withPerShare.metric("dpsCagr3y")).toMatchObject({ status: "value", value: -1 });
    expect(withPerShare.metric("earliestDividendFyInHistory").value).toBe("FY2019");
    for (const result of [withoutPerShare, withPerShare]) {
      expect(result.section.metrics.some(({ status }) => status === "not-applicable")).toBe(false);
    }
  });

  test("only an affirmed non-payer gets not-applicable dividend history", () => {
    const zeroPaid = series("USD", () => 0);
    const zeroPerShare = series("USD/shares", () => 0);
    const history = ["dpsCagr3y", "dpsCagr5y", "earliestDividendFyInHistory"];
    const nonPayer = evaluate(
      context(
        usGaap({
          PaymentsOfDividends: zeroPaid,
          CommonStockDividendsPerShareDeclared: zeroPerShare,
        }),
      ),
    );
    const statusesWith = (overrides: Record<string, Fact | undefined>) => {
      const result = evaluate(
        context(
          usGaap({
            PaymentsOfDividends: zeroPaid,
            CommonStockDividendsPerShareDeclared: zeroPerShare,
            ...overrides,
          }),
        ),
      );
      return history.map((id) => result.metric(id).status);
    };

    for (const id of history) {
      expect(nonPayer.metric(id)).toMatchObject({
        status: "not-applicable",
        reason: "no dividend history in filed data",
        inputs: [],
      });
    }
    expect(nonPayer.metric("dpsLatestFy")).toMatchObject({ status: "value", value: 0 });
    expect(nonPayer.metric("dividendsLatestFy")).toMatchObject({ status: "value", value: 0 });
    expect(statusesWith({ CommonStockDividendsPerShareDeclared: undefined })).toEqual([
      "missing",
      "missing",
      "missing",
    ]);
    expect(statusesWith({ PaymentsOfDividends: undefined })).toEqual([
      "not-meaningful",
      "not-meaningful",
      "missing",
    ]);
    expect(
      statusesWith({
        PaymentsOfDividends: {
          units: {
            USD: [
              ...YEARS.map((year) => fy(0, year)),
              fy(15, 2026, {
                start: "2026-01-01",
                end: "2026-03-31",
                fp: "Q1",
                form: "10-Q",
                filed: "2026-05-01",
              }),
            ],
          },
        },
      }),
    ).toEqual(["not-meaningful", "not-meaningful", "missing"]);
    for (const paid of [40, -40]) {
      expect(
        statusesWith({
          PaymentsOfDividends: series("USD", (year) => (year === 2019 ? paid : 0)),
        }),
      ).toEqual(["not-meaningful", "not-meaningful", "missing"]);
    }
    expect(
      statusesWith({
        PaymentsOfDividends: series("USD", (year) => (year <= 2020 ? 0 : undefined)),
      }),
    ).toEqual(["not-meaningful", "not-meaningful", "missing"]);
    expect(
      statusesWith({
        CommonStockDividendsPerShareDeclared: series("USD/shares", (year) =>
          year <= 2020 ? 0 : undefined,
        ),
      }),
    ).toEqual(["missing", "missing", "missing"]);
    expect(
      statusesWith({
        CommonStockDividendsPerShareDeclared: {
          units: {
            "USD/shares": [
              ...YEARS.map((year) => fy(0, year)),
              fy(0.25, 2025, { start: "2025-12-01", end: "2025-12-31" }),
            ],
          },
        },
      }),
    ).toEqual(["not-meaningful", "not-meaningful", "missing"]);
    expect(
      statusesWith({
        PaymentsOfDividends: {
          units: {
            USD: YEARS.map((year) =>
              fy(0, year, { start: `${String(year - 1)}-07-01`, end: `${String(year)}-06-30` }),
            ),
          },
        },
      }),
    ).toEqual(["not-meaningful", "not-meaningful", "missing"]);
  });

  test("Non-payer classification rests on raw dividend evidence, not on the selected per-share series", () => {
    const history = ["dpsCagr3y", "dpsCagr5y", "earliestDividendFyInHistory"];
    const zeroPaid = series("USD", () => 0);
    const stub = fy(0.8, 2025, { start: "2025-03-01" });
    const statuses = (overrides: Record<string, Fact | undefined>) => {
      const ctx = context(usGaap({ PaymentsOfDividends: zeroPaid, ...overrides }));
      return history.map((id) => evaluate(ctx).metric(id).status);
    };

    expect(
      statuses({
        CommonStockDividendsPerShareDeclared: { units: { "USD/shares": [stub] } },
        CommonStockDividendsPerShareCashPaid: series("USD/shares", () => 0),
      }),
    ).toEqual(["not-meaningful", "not-meaningful", "missing"]);
    expect(
      statuses({ CommonStockDividendsPerShareDeclared: { units: { "USD/shares": [stub] } } }),
    ).not.toContain("not-applicable");

    const nonPayer = context(
      usGaap({
        PaymentsOfDividends: zeroPaid,
        CommonStockDividendsPerShareDeclared: series("USD/shares", () => 0),
      }),
    );
    expect(nonPayer.statements?.dividendPaymentFiled).toBe(false);
    const zeroDps = series("USD/shares", () => 0).units as Record<string, Fact[]>;
    const withRawDps = (extra: Fact) =>
      context(
        usGaap({
          PaymentsOfDividends: zeroPaid,
          CommonStockDividendsPerShareDeclared: {
            units: { "USD/shares": [...zeroDps["USD/shares"]!, extra] },
          },
        }),
      );
    const eightK = fy(0.5, 2025, { form: "8-K", start: "2025-11-01", end: "2025-11-30" });
    const { fp: _fp, ...noFp } = fy(0.5, 2024, { start: "2024-12-01" });
    for (const raw of [
      eightK,
      noFp,
      { ...eightK, filed: "unknown" },
      { ...eightK, filed: "2027-02-30" },
      { ...eightK, filed: "2026-13-45" },
    ]) {
      const ctx = withRawDps(raw);
      expect(ctx.statements?.dividendPaymentFiled).toBe(true);
      expect(history.map((id) => evaluate(ctx).metric(id).status)).not.toContain("not-applicable");
    }
    expect(withRawDps({ ...eightK, filed: "2026-08-01" }).statements?.dividendPaymentFiled).toBe(
      false,
    );
    const { dividendPaymentFiled: _unrecorded, ...preFlag } = nonPayer.statements!;
    const historical = evaluate({ ...nonPayer, statements: preFlag });
    for (const id of history) {
      expect(historical.metric(id)).toMatchObject({
        status: "missing",
        reason: "dividend payment evidence is not recorded in this artifact",
      });
    }
    const payer = context(usGaap());
    const { dividendPaymentFiled: _payerFlag, ...payerPreFlag } = payer.statements!;
    expect(evaluate({ ...payer, statements: payerPreFlag }).metric("dpsCagr3y").status).toBe(
      "value",
    );
  });

  test("a negative filed dividend per share is refused, never shown as its absolute value", () => {
    const result = evaluate(
      context(
        usGaap({
          CommonStockDividendsPerShareDeclared: series("USD/shares", (year) =>
            year === 2025 ? -0.5 : dps(year),
          ),
        }),
      ),
    );

    expect(result.metric("dpsLatestFy")).toMatchObject({
      status: "not-meaningful",
      reason: "latest dividends per share is negative",
      periodEnd: "2025-12-31",
      inputs: [{ value: -0.5 }],
    });
    expect(result.metric("dpsLatestFy").value).toBeUndefined();
    expect(result.metric("dpsCagr3y")).toMatchObject({
      status: "not-meaningful",
      reason: "latest dividends per share is negative",
      periodEnd: "2025-12-31",
    });
  });

  test("no taxonomy: every metric is missing and the section still exists", () => {
    const result = evaluate(context({}));

    expect(result.section.metrics.every((metric) => metric.status === "missing")).toBe(true);
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("a 13-month annual fact never anchors; the latest year-aligned FY does", () => {
    const ctx = context(
      usGaap({
        PaymentsForRepurchaseOfCommonStock: {
          units: {
            USD: [fy(80, 2024), fy(130, 2025, { start: "2024-12-01" })],
          },
        },
      }),
    );
    const annual = ctx.statements?.statements.cashFlowStatement.shareRepurchases.annual ?? [];

    const result = evaluate(ctx);

    expect(annual.map((fact) => fact.periodKey)).toContain("duration:13|2025-12-31");
    expect(result.metric("buybacksLatestFy")).toMatchObject({
      status: "missing",
      reason: "stale share repurchases as of 2024-12-31",
      periodEnd: "2024-12-31",
      inputs: [{ value: 80, periodKey: "duration:12|2024-12-31" }],
    });
    expect(result.metric("shareholderYield")).toMatchObject({
      status: "missing",
      reason: "no same-period share repurchases for the fiscal year ending 2025-12-31",
    });
  });

  test("an interim 12-month fact never anchors", () => {
    const ctx = context(
      usGaap({
        PaymentsForRepurchaseOfCommonStock: {
          units: {
            USD: [
              fy(90, 2025),
              fy(500, 2026, {
                start: "2025-04-01",
                end: "2026-03-31",
                fp: "Q1",
                form: "10-Q",
                filed: "2026-05-01",
              }),
            ],
          },
        },
      }),
    );
    const interim = ctx.statements?.statements.cashFlowStatement.shareRepurchases.interim ?? [];

    const result = evaluate(ctx);

    expect(interim.some((fact) => fact.periodEnd === "2026-03-31")).toBe(true);
    expect(result.metric("buybacksLatestFy")).toMatchObject({
      value: 90,
      periodEnd: "2025-12-31",
    });
  });

  test("a denominator only in an older FY is missing, not an older-period value", () => {
    const result = evaluate(
      context(
        usGaap({
          NetCashProvidedByUsedInOperatingActivities: series("USD", (year) =>
            year <= 2024 ? 400 : undefined,
          ),
        }),
      ),
    );

    expect(result.metric("fcfPayoutRatio")).toMatchObject({
      status: "missing",
      reason: "no same-period operating cash flow for the fiscal year ending 2025-12-31",
      periodEnd: "2025-12-31",
      inputs: [{ series: "dividendsPaid", periodEnd: "2025-12-31" }],
      sourceIds: [SOURCE_ID],
    });
    expect(result.metric("fcfPayoutRatio").value).toBeUndefined();
  });

  test("a stale anchor is missing with its lineage; a current FY is a value", () => {
    const stale = evaluate(
      context(
        usGaap({
          PaymentsForRepurchaseOfCommonStock: series("USD", (year) =>
            year <= 2020 ? 90 : undefined,
          ),
          WeightedAverageNumberOfDilutedSharesOutstanding: series("shares", (year) =>
            year <= 2020 ? 1000 : undefined,
          ),
        }),
      ),
    );
    const current = evaluate(context(usGaap()));

    expect(stale.metric("buybackYield")).toMatchObject({
      status: "missing",
      reason: "stale share repurchases as of 2020-12-31",
      periodEnd: "2020-12-31",
      sourceIds: [SOURCE_ID],
    });
    expect(stale.metric("shareCountChange1y")).toMatchObject({
      status: "missing",
      reason: "stale diluted shares as of 2020-12-31",
    });
    expect(stale.sourceGaps[0]?.triage).toBe("material");
    expect(current.metric("buybackYield")).toMatchObject({
      status: "value",
      periodEnd: "2025-12-31",
    });
  });

  test("Annual filing cutoff is calendar-aware: FY end + 16 months (month-end kept) + 7 days", () => {
    const ctx = context(
      usGaap({
        PaymentsForRepurchaseOfCommonStock: {
          units: {
            USD: [
              fy(90, 2024, { start: "2023-07-01", end: "2024-06-30", filed: "2024-08-15" }),
              fy(70, 2023, { start: "2023-10-02", end: "2024-09-28", filed: "2024-11-01" }),
            ],
          },
        },
      }),
    );
    const buybacksAsOf = (analysisAsOf: string, periodEnd: string) => {
      const { statements } = ctx;
      const repurchases = statements!.statements.cashFlowStatement.shareRepurchases;
      return evaluate({
        ...ctx,
        statements: {
          ...statements!,
          analysisAsOf,
          statements: {
            ...statements!.statements,
            cashFlowStatement: {
              ...statements!.statements.cashFlowStatement,
              shareRepurchases: {
                ...repurchases,
                annual: repurchases.annual.filter((fact) => fact.periodEnd === periodEnd),
              },
            },
          },
        },
      }).metric("buybacksLatestFy").status;
    };

    expect(buybacksAsOf("2025-10-29T00:00:00.000Z", "2024-06-30")).toBe("value");
    expect(buybacksAsOf("2025-10-31T00:00:00.000Z", "2024-06-30")).toBe("value");
    expect(buybacksAsOf("2025-11-07T23:00:00.000Z", "2024-06-30")).toBe("value");
    expect(buybacksAsOf("2025-11-08T00:00:00.000Z", "2024-06-30")).toBe("missing");
    // 52/53-week FYE: a 53-week FY ending 2025-10-04 has its 20-F due 2026-02-04.
    expect(buybacksAsOf("2026-02-04T00:00:00.000Z", "2024-09-28")).toBe("value");
    expect(buybacksAsOf("2026-02-05T00:00:00.000Z", "2024-09-28")).toBe("missing");
  });

  test("an undated FY stock-based compensation fact is missing, not a value", () => {
    const ctx = context(
      usGaap({
        ShareBasedCompensation: { units: { USD: [{ ...fy(25, 2025), start: undefined }] } },
      }),
    );

    const result = evaluate(ctx);

    expect(ctx.capitalOwnership?.stockBasedCompensation).toMatchObject([
      { value: 25, periodEnd: "2025-12-31" },
    ]);
    expect(result.metric("sbcLatestFy")).toMatchObject({
      status: "missing",
      reason: "no year-aligned annual stock-based compensation fact",
    });
  });

  test("zero or negative free cash flow is not-meaningful with its inputs kept", () => {
    const result = evaluate(
      context(usGaap({ PaymentsToAcquirePropertyPlantAndEquipment: series("USD", () => 400) })),
    );

    expect(result.metric("fcfPayoutRatio")).toMatchObject({
      status: "not-meaningful",
      reason: "free cash flow is zero or negative for the fiscal year ending 2025-12-31",
      periodEnd: "2025-12-31",
      sourceIds: [SOURCE_ID],
    });
    expect(result.sourceGaps[0]?.triage).toBe("diagnostic");
  });

  test("an earlier-share-basis period inside the window makes the change not-meaningful", () => {
    const ctx = context(usGaap());
    const statements = ctx.statements!;
    const fact2023 = statements.statements.perShare.dilutedShares.annual.find(
      (fact) => fact.periodEnd === "2023-12-31",
    )!;
    const split: FinancialStatementsArtifact = {
      ...statements,
      omissionNotes: [
        ...statements.omissionNotes,
        {
          code: "earlier-share-basis",
          seriesKey: "dilutedShares",
          periodKey: fact2023.periodKey,
          message: "test split",
        },
        {
          code: "earlier-share-basis",
          seriesKey: "dividendsPerShare",
          periodKey: fact2023.periodKey,
          message: "test split",
        },
      ],
    };

    const result = evaluate({ ...ctx, statements: split });

    expect(result.metric("shareCountChange1y").status).toBe("value");
    expect(result.metric("shareCountChange3y")).toMatchObject({
      status: "not-meaningful",
      reason: "diluted shares inside the window are on an earlier share basis",
      periodEnd: "2025-12-31",
    });
    expect(result.metric("shareCountTrend").status).toBe("not-meaningful");
    expect(result.metric("dpsLatestFy").status).toBe("value");
    expect(result.metric("dpsCagr3y")).toMatchObject({
      status: "not-meaningful",
      reason: "dividends per share inside the window are on an earlier share basis",
      periodEnd: "2025-12-31",
      inputs: [{ periodEnd: "2022-12-31" }, { periodEnd: "2025-12-31" }],
    });
    expect(result.metric("earliestDividendFyInHistory").status).toBe("value");
  });

  test("currency mismatch: yields are missing, filed amounts keep their values", () => {
    const result = evaluate(
      context(usGaap(), {
        quote: { marketCap: 10_000, currency: "EUR", asOf: AS_OF, sourceId: QUOTE_SOURCE_ID },
      }),
    );

    for (const id of ["buybackYield", "dividendYieldFiled", "shareholderYield"]) {
      expect(result.metric(id)).toMatchObject({
        status: "missing",
        reason: "reporting currency USD differs from quote currency EUR",
      });
    }
    expect(result.metric("buybacksLatestFy").status).toBe("value");
    expect(result.metric("dividendYieldFiled")).toMatchObject({
      periodEnd: "2025-12-31",
      inputs: [{ series: "dividendsPaid" }, { artifact: "quote", currency: "EUR" }],
      sourceIds: [SOURCE_ID, QUOTE_SOURCE_ID],
    });
  });

  test("not-meaningful share and payout rows retain the known fiscal year", () => {
    const result = evaluate(
      context(
        usGaap({
          WeightedAverageNumberOfDilutedSharesOutstanding: series("shares", (year) =>
            year < 2025 ? 0 : 100,
          ),
          CommonStockDividendsPerShareDeclared: series("USD/shares", (year) =>
            year < 2025 ? 0 : 0.5,
          ),
        }),
        { quote: { marketCap: 0, currency: "USD", asOf: AS_OF, sourceId: QUOTE_SOURCE_ID } },
      ),
    );
    for (const id of [
      "shareCountChange1y",
      "shareCountChange3y",
      "shareCountChange5y",
      "dpsCagr3y",
      "dpsCagr5y",
      "buybackYield",
      "dividendYieldFiled",
      "shareholderYield",
    ]) {
      expect(result.metric(id)).toMatchObject({
        status: "not-meaningful",
        periodEnd: "2025-12-31",
      });
    }
  });

  test("no quote market cap: yields are missing", () => {
    const { quote: _quote, ...withoutQuote } = context(usGaap());

    const result = evaluate(withoutQuote);

    expect(result.metric("buybackYield")).toMatchObject({
      status: "missing",
      reason: "no quote market cap",
    });
  });

  test("R3: depository issuers get not-applicable FCF ratios without computing them", () => {
    const result = evaluate(context(usGaap(), { depositorySic: "6022" }));

    for (const id of ["fcfPayoutRatio", "totalPayoutToFcf"]) {
      expect(result.metric(id)).toMatchObject({ status: "not-applicable", inputs: [] });
    }
    expect(result.metric("dividendYieldFiled").status).toBe("value");
    expect(result.sourceGaps[0]).toMatchObject({ triage: "diagnostic" });
    expect(result.sourceGaps[0]?.message).toContain("depository issuer (SIC 6022)");
  });

  test("report.md lists a missing-metric gap as material and a diagnostic-only gap apart", () => {
    const base = context(usGaap());
    const material = renderMaterialGaps(
      context(usGaap(), { quote: { ...base.quote!, currency: "EUR" } }),
    );
    const diagnostic = renderMaterialGaps(context(usGaap(), { depositorySic: "6022" }));
    const notFiled = renderMaterialGaps(context(usGaap({ PaymentsOfDividends: undefined })));

    expect(material).toContain("capital-return: Capital Return metrics for TEST not computed");
    expect(diagnostic).not.toContain("capital-return");
    expect(notFiled).not.toContain("capital-return");
  });

  test("every label, basis, reason, text value and gap passes the research-only gate", () => {
    expect(evaluated.length).toBeGreaterThan(10);
    const texts = evaluated.flatMap(({ section, sourceGaps }) => [
      section.title,
      ...section.metrics.flatMap((metric) => [
        metric.label,
        metric.basis,
        metric.reason ?? "",
        typeof metric.value === "string" ? metric.value : "",
        ...metric.inputs.map((input) => input.label),
      ]),
      ...sourceGaps.map((gap) => gap.message),
    ]);

    expect(texts.filter((text) => violatesResearchOnly(text) !== null)).toEqual([]);
  });
});

function evidenceSource(id: string): Source {
  return { id, title: id, fetchedAt: AS_OF, kind: "extended-evidence", assetClass: "equity" };
}

function reportWith(ctx: MetricContext, sourceIds: readonly string[]) {
  const extras = projectExtendedEvidenceReportExtras({
    modelExtras: {},
    collectedSources: collectedSources({ metricSections: [capitalReturnSection(ctx).section] }),
  });
  return researchReport({
    jobType: "equity",
    symbol: "TEST",
    sources: sourceIds.map((id) => evidenceSource(id)),
    extras,
  });
}

describe("Capital Return in report.json and report.md", () => {
  test("every metric and input cites only statements, capital-ownership or quote ids", () => {
    const base = context(usGaap());
    const ids = [
      base,
      context(usGaap({ PaymentsOfDividends: undefined })),
      context(usGaap(), { depositorySic: "6022" }),
      context(usGaap(), { quote: { ...base.quote!, currency: "EUR" } }),
    ].flatMap((ctx) =>
      capitalReturnSection(ctx).section.metrics.flatMap((metric) => [
        ...metric.sourceIds,
        ...metric.inputs.flatMap((input) => input.sourceIds),
      ]),
    );
    expect(ids).toContain(SOURCE_ID);
    expect(ids).toContain(QUOTE_SOURCE_ID);
    expect(ids.filter((id) => id !== SOURCE_ID && id !== QUOTE_SOURCE_ID)).toEqual([]);
  });

  test("the fixture lineage invariant passes a real section and rejects forged lineage", () => {
    const snapshot = marketSnapshot({
      sourceId: QUOTE_SOURCE_ID,
      symbol: "TEST",
      marketCap: 10_000,
      observedAt: AS_OF,
    });
    const ctx = context(usGaap(), {
      quote: {
        marketCap: 10_000,
        currency: "USD",
        asOf: resolveMarketSnapshotPriceAsOf(snapshot).instant,
        sourceId: QUOTE_SOURCE_ID,
      },
    });
    const { section } = capitalReturnSection(ctx);
    const run = (metrics: readonly unknown[]) => {
      const report = researchReport({
        jobType: "equity",
        symbol: "TEST",
        sources: [evidenceSource(SOURCE_ID), evidenceSource(QUOTE_SOURCE_ID)],
        extras: { metricSections: [{ ...section, metrics }] },
      });
      return () =>
        assertMetricSectionInvariants(
          {
            collectedSources: collectedSources({
              financialStatements: ctx.statements!,
              capitalOwnership: ctx.capitalOwnership!,
              marketSnapshots: [snapshot],
              resolvedInstrumentIdentity: { quoteCurrency: "USD" } as never,
            }),
            markdown: renderMarkdownReport(report),
          },
          report,
        );
    };
    const forged = (id: string, change: (metric: Record<string, unknown>) => unknown) =>
      section.metrics.map((metric) =>
        metric.id === id ? change(metric as unknown as Record<string, unknown>) : metric,
      );
    const forgedInput = (patch: Record<string, unknown>) =>
      forged("buybackYield", (metric) => ({
        ...metric,
        inputs: (metric.inputs as readonly MetricInput[]).map((input, index) =>
          index === 0 ? { ...input, ...patch } : input,
        ),
      }));

    expect(section.metrics.every((metric) => metric.status === "value")).toBe(true);
    expect(run(section.metrics)).not.toThrow();
    expect(run(forgedInput({ periodStart: "2029-01-01", periodEnd: "2029-12-31" }))).toThrow(
      "lineage matches its artifact",
    );
    expect(run(forgedInput({ currency: "CAD" }))).toThrow("lineage matches its artifact");
    expect(
      run(forged("buybackYield", (metric) => ({ ...metric, periodEnd: "2030-12-31" }))),
    ).toThrow("ends at its anchor FY");
    expect(run(forged("buybacksLatestFy", ({ value: _value, ...metric }) => metric))).toThrow(
      "finite number or non-empty text",
    );
    expect(run(forged("dpsCagr3y", (metric) => ({ ...metric, value: 0.5 })))).toThrow(
      "capital-return.dpsCagr3y",
    );
    expect(
      run(forged("earliestDividendFyInHistory", (metric) => ({ ...metric, value: "FY2020" }))),
    ).toThrow("names the earliest positive FY");
  });

  test("the fixture invariant checks each not-filed cause against the metric's own inputs", () => {
    const snapshot = marketSnapshot({
      sourceId: QUOTE_SOURCE_ID,
      symbol: "TEST",
      marketCap: 10_000,
      observedAt: AS_OF,
    });
    const quoted = (ctx: MetricContext, currency = "USD"): MetricContext => ({
      ...ctx,
      quote: {
        marketCap: 10_000,
        currency,
        asOf: resolveMarketSnapshotPriceAsOf(snapshot).instant,
        sourceId: QUOTE_SOURCE_ID,
      },
    });
    const runWith = (ctx: MetricContext, change: (metric: MetricRecord) => MetricRecord) => {
      const { section, sourceGaps } = capitalReturnSection(ctx);
      const metrics = section.metrics.map((metric) => change(metric as unknown as MetricRecord));
      const allNotFiled = metrics
        .filter(({ status }) => status === "missing")
        .every(({ cause }) => cause === "not-filed");
      const report = researchReport({
        jobType: "equity",
        symbol: "TEST",
        sources: [evidenceSource(SOURCE_ID), evidenceSource(QUOTE_SOURCE_ID)],
        dataGaps: sourceGaps.map((gap) => sourceGapReportText(gap)),
        extras: { metricSections: [{ ...section, metrics }] },
      });
      return () =>
        assertMetricSectionInvariants(
          {
            collectedSources: collectedSources({
              financialStatements: ctx.statements!,
              capitalOwnership: ctx.capitalOwnership!,
              ...(ctx.quote === undefined
                ? {}
                : {
                    marketSnapshots: [snapshot],
                    resolvedInstrumentIdentity: { quoteCurrency: ctx.quote.currency } as never,
                  }),
              sourceGaps: sourceGaps.map((gap) => ({
                ...gap,
                triage: allNotFiled ? "diagnostic" : "material",
              })),
            }),
            markdown: renderMarkdownReport(report),
          },
          report,
        );
    };
    const tag =
      (...ids: string[]) =>
      (metric: MetricRecord): MetricRecord =>
        ids.includes(String(metric.id))
          ? {
              ...metric,
              status: "missing",
              cause: "not-filed",
              value: undefined,
              periodEnd: (metric.inputs as readonly MetricInput[]).find(
                ({ artifact }) => artifact === "statements",
              )?.periodEnd,
            }
          : metric;
    const unfiledDividends = quoteless(context(usGaap({ PaymentsOfDividends: undefined })));
    const filteredOcf = quoteless(
      context(
        usGaap({
          PaymentsOfDividends: undefined,
          NetCashProvidedByUsedInOperatingActivities: {
            units: { USD: [fy(400, 2025, { end: "2025-06-30", fp: "Q2", form: "10-Q" })] },
          },
        }),
      ),
    );

    expect(runWith(unfiledDividends, (metric) => metric)).not.toThrow();
    expect(runWith(unfiledDividends, tag("buybacksLatestFy"))).toThrow(
      "capital-return.buybacksLatestFy not-filed needs one of its own inputs unfiled",
    );
    const withFcf = (
      ocf: (year: number) => number | undefined,
      capex: (year: number) => number | undefined,
    ) =>
      quoteless(
        context(
          usGaap({
            PaymentsOfDividends: undefined,
            NetCashProvidedByUsedInOperatingActivities: series("USD", ocf),
            PaymentsToAcquirePropertyPlantAndEquipment: series("USD", capex),
          }),
        ),
      );
    const staleOcf = withFcf(
      (year) => (year <= 2020 ? 400 : undefined),
      (year) => (year <= 2020 ? 100 : undefined),
    );
    const unjoined = withFcf(
      (year) => (year === 2025 ? 400 : undefined),
      (year) => (year === 2024 ? 100 : undefined),
    );

    expect(
      capitalReturnSection(unfiledDividends).section.metrics.find(
        ({ id }) => id === "fcfPayoutRatio",
      )?.cause,
    ).toBe("not-filed");
    const negativeFcf = withFcf(
      () => 50,
      () => 100,
    );
    expect(
      capitalReturnSection(negativeFcf).section.metrics.find(({ id }) => id === "fcfPayoutRatio")
        ?.status,
    ).toBe("not-meaningful");
    const quotedDividends = quoted(unfiledDividends);
    const yieldCauses = capitalReturnSection(quotedDividends).section.metrics.flatMap(
      ({ id, cause }) => (id === "dividendYieldFiled" || id === "shareholderYield" ? [cause] : []),
    );
    expect(yieldCauses).toEqual(["not-filed", "not-filed"]);
    expect(runWith(quotedDividends, (metric) => metric)).not.toThrow();
    for (const ctx of [unfiledDividends, quoted(unfiledDividends, "EUR")]) {
      expect(runWith(ctx, (metric) => metric)).not.toThrow();
      expect(runWith(ctx, tag("dividendYieldFiled"))).toThrow(
        "capital-return.dividendYieldFiled not-filed but filed inputs fail",
      );
    }
    for (const ctx of [filteredOcf, staleOcf, unjoined, negativeFcf]) {
      expect(runWith(ctx, (metric) => metric)).not.toThrow();
      expect(runWith(ctx, tag("fcfPayoutRatio"))).toThrow(
        "capital-return.fcfPayoutRatio not-filed but filed inputs fail",
      );
    }
  });

  test("validates against report sources and rejects an unknown metric source id", () => {
    const ctx = context(usGaap());
    expect(() =>
      validateResearchReport(reportWith(ctx, [SOURCE_ID, QUOTE_SOURCE_ID])),
    ).not.toThrow();
    expect(() => validateResearchReport(reportWith(ctx, [SOURCE_ID]))).toThrow(
      `Metric Sections [0].metrics[6] (capital-return.buybackYield) cites unknown source ID: ${QUOTE_SOURCE_ID}`,
    );
  });

  test("structural causes validate on missing metrics only", () => {
    const report = reportWith(context(usGaap({ PaymentsOfDividends: undefined })), [
      SOURCE_ID,
      QUOTE_SOURCE_ID,
    ]);
    const sections = report.extras?.metricSections as readonly Record<string, unknown>[];
    const forged = (cause: string, status: string) => ({
      ...report,
      extras: {
        ...report.extras,
        metricSections: sections.map((section) => ({
          ...section,
          metrics: (section.metrics as readonly Record<string, unknown>[]).map((metric) =>
            metric.id === "buybacksLatestFy" ? { ...metric, cause, status } : metric,
          ),
        })),
      },
    });

    expect(() => validateResearchReport(report)).not.toThrow();
    for (const cause of ["not-filed", "insufficient-history", "outside-price-history-window"]) {
      expect(() => validateResearchReport(forged(cause, "missing"))).not.toThrow();
      expect(() => validateResearchReport(forged(cause, "value"))).toThrow(
        `buybacksLatestFy has cause "${cause}" on a value metric`,
      );
    }
    expect(() => validateResearchReport(forged("stale", "missing"))).toThrow(
      'has cause "stale" on a missing metric',
    );
    for (const [cause, text] of [
      [42, "42"],
      [null, "null"],
      [{}, "{}"],
    ] as const) {
      expect(() => validateResearchReport(forged(cause as never, "missing"))).toThrow(
        `has cause ${text} on a missing metric`,
      );
    }
  });

  test("renders a not-applicable metric as not applicable with its reason", () => {
    const markdown = renderMarkdownReport(
      reportWith(context(usGaap(), { depositorySic: "6022" }), [SOURCE_ID, QUOTE_SOURCE_ID]),
    );

    expect(markdown).toContain(
      String.raw`- Dividends / free cash flow: not applicable, depository issuer \(SIC 6022\)`,
    );
    expect(markdown).not.toMatch(/not available, depository issuer/u);
  });

  test("renders values with period, basis and citations, and reasons for the rest", () => {
    const markdown = renderMarkdownReport(
      reportWith(context(usGaap(), { quote: { ...context(usGaap()).quote!, currency: "EUR" } }), [
        SOURCE_ID,
        QUOTE_SOURCE_ID,
      ]),
    );

    expect(markdown).toContain(
      `### Capital Return\n\n- Share repurchases \\(latest FY\\): $90 (FY ending 2025-12-31; cash paid for share repurchases in the latest year-aligned fiscal year) [${SOURCE_ID}]`,
    );
    expect(markdown).toContain(
      "- Buyback yield: not available, reporting currency USD differs from quote currency EUR",
    );
    expect(markdown).toContain(
      `- Dividends per share \\(latest FY\\): $0.64 (FY ending 2025-12-31; dividends declared per share, else cash paid per share, in the latest year-aligned fiscal year) [${SOURCE_ID}]`,
    );
    expect(markdown).toContain(`- [${SOURCE_ID}] ${SOURCE_ID}`);
    // The quote is cited only by the missing yields, which render a reason and no reference.
    expect(markdown).not.toContain(`- [${QUOTE_SOURCE_ID}]`);
  });

  test("no Metric Section renders no Capital Return heading", () => {
    const markdown = renderMarkdownReport(researchReport({ jobType: "equity", symbol: "TEST" }));
    expect(markdown).not.toContain("Capital Return");
  });
});

describe("capitalReturnSection — capex sign", () => {
  test.each([
    [100, { status: "value", value: 60 / 300 }],
    [0, { status: "value", value: 60 / 400 }],
    [
      -100,
      {
        status: "not-meaningful",
        reason: `${NEGATIVE_CAPEX_REASON} for the fiscal year ending 2025-12-31`,
      },
    ],
  ])("FCF payout ratios with capex %d", (capex, expected) => {
    const result = evaluate(
      context(usGaap({ PaymentsToAcquirePropertyPlantAndEquipment: series("USD", () => capex) })),
    );
    expect(result.metric("fcfPayoutRatio")).toMatchObject(expected);
    expect(result.metric("totalPayoutToFcf")).toMatchObject({ status: expected.status });
    expect(result.metric("fcfPayoutRatio").inputs.map((input) => input.series)).toEqual([
      "dividendsPaid",
      "operatingCashFlow",
      "capitalExpenditure",
    ]);
  });
});
