import { describe, expect, test } from "bun:test";
import { violatesResearchOnly } from "../src/domain/research-language";
import { sourceGap, sourceGapReportText } from "../src/domain/source-gaps";
import type { Source } from "../src/domain/sources";
import { renderMarkdownReport } from "../src/report/markdown";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { financialLensMetrics } from "../src/sources/extended-evidence/financial-lens-sections";
import type { MetricContext } from "../src/sources/extended-evidence/metric-engine";
import { operatingRatiosSection } from "../src/sources/extended-evidence/operating-ratios";
import { collectedSources, researchReport } from "./support/fixtures";
import { assertOperatingRatioInvariants } from "./support/run-fixtures/assertions";

const SOURCE_ID = "extended-sec-edgar-test-fundamentals";
const AS_OF = "2026-07-23T00:00:00.000Z";
const YEARS = [2023, 2024, 2025];

type Fact = Record<string, unknown>;
type Concepts = Record<string, Fact | undefined>;

function fact(value: number, year: number, overrides: Fact = {}): Fact {
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

function flow(valueFor: (year: number) => number | undefined, unit = "USD"): Fact {
  return {
    units: {
      [unit]: YEARS.flatMap((year) => {
        const value = valueFor(year);
        return value === undefined ? [] : [fact(value, year)];
      }),
    },
  };
}

function instant(valueFor: (year: number) => number | undefined, unit = "USD"): Fact {
  return {
    units: {
      [unit]: YEARS.flatMap((year) => {
        const value = valueFor(year);
        return value === undefined ? [] : [fact(value, year, { start: undefined })];
      }),
    },
  };
}

function usGaap(overrides: Concepts = {}): Concepts {
  return {
    Revenues: flow(() => 1000),
    NetCashProvidedByUsedInOperatingActivities: flow(() => 300),
    PaymentsToAcquirePropertyPlantAndEquipment: flow(() => 100),
    OperatingIncomeLoss: flow(() => 200),
    InterestExpense: flow(() => 40),
    DepreciationDepletionAndAmortization: flow(() => 50),
    IncomeTaxExpenseBenefit: flow(() => 32),
    IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
      flow(() => 160),
    StockholdersEquity: instant(() => 700),
    LongTermDebt: instant(() => 400),
    CashAndCashEquivalentsAtCarryingValue: instant(() => 100),
    ...overrides,
  };
}

function context(
  concepts: Concepts,
  overrides: Partial<MetricContext> = {},
  taxonomy = "us-gaap",
  analysisAsOf = AS_OF,
): MetricContext {
  const facts = Object.fromEntries(
    Object.entries(concepts).filter((entry): entry is [string, Fact] => entry[1] !== undefined),
  );
  return {
    symbol: "TEST",
    statements: deriveFinancialStatements(
      { facts: { [taxonomy]: facts } },
      { symbol: "TEST", generatedAt: analysisAsOf, analysisAsOf, sourceId: SOURCE_ID },
    ),
    ...overrides,
  };
}

const evaluated: ReturnType<typeof operatingRatiosSection>[] = [];

function evaluate(ctx: MetricContext) {
  const result = operatingRatiosSection(ctx);
  evaluated.push(result);
  return {
    ...result,
    ctx,
    metric: (id: string) => {
      const metric = result.section.metrics.find((candidate) => candidate.id === id);
      if (metric === undefined) {
        throw new Error(`no metric ${id}`);
      }
      return metric;
    },
  };
}

function evidenceSource(id: string): Source {
  return { id, title: id, fetchedAt: AS_OF, kind: "extended-evidence", assetClass: "equity" };
}

// Gaps follow the given metrics, so a forged status trips its own assertion, not the gap check.
function invariantRun(ctx: MetricContext, metrics: readonly unknown[], rawPayload?: Fact) {
  const { section } = operatingRatiosSection(ctx);
  const rows = metrics as readonly Record<string, unknown>[];
  const missing = rows.filter(({ status }) => status === "missing");
  const sourceGaps = rows.some(({ status }) => status !== "value")
    ? [
        sourceGap({
          source: "operating-ratios",
          message: "Operating Ratios metrics for TEST not computed",
          symbol: "TEST",
          provider: "market-bot",
          capability: "extended-evidence",
          cause: "provider-data-missing",
          evidenceQualityImpact: "no-cap",
          triage: missing.every(({ cause }) => cause === "not-filed") ? "diagnostic" : "material",
        }),
      ]
    : [];
  const report = researchReport({
    jobType: "equity",
    symbol: "TEST",
    sources: [evidenceSource(SOURCE_ID)],
    dataGaps: sourceGaps.map((gap) => sourceGapReportText(gap)),
    extras: { metricSections: [{ ...section, metrics }] },
  });
  return () =>
    assertOperatingRatioInvariants(
      {
        collectedSources: collectedSources({
          financialStatements:
            rawPayload === undefined
              ? ctx.statements!
              : {
                  ...ctx.statements!,
                  sourceUrl: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json",
                },
          ...(rawPayload === undefined
            ? {}
            : {
                rawSnapshots: [
                  {
                    id: SOURCE_ID,
                    adapter: "sec-companyfacts",
                    fetchedAt: AS_OF,
                    payload: rawPayload,
                  },
                ],
              }),
          sourceGaps,
        }),
        markdown: renderMarkdownReport(report),
      },
      report,
    );
}

describe("operatingRatiosSection", () => {
  test("derives every ratio from one fiscal year and that year-end's balance sheet", () => {
    const result = evaluate(context(usGaap()));

    expect(result.section).toMatchObject({ id: "operating-ratios", title: "Operating Ratios" });
    expect(result.metric("freeCashFlowMargin")).toMatchObject({
      status: "value",
      value: 0.2,
      periodEnd: "2025-12-31",
      sourceIds: [SOURCE_ID],
    });
    expect(result.metric("interestCoverage")).toMatchObject({ status: "value", value: 5 });
    expect(result.metric("ebitdaProxy")).toMatchObject({
      status: "value",
      value: 250,
      currency: "USD",
    });
    expect(result.metric("effectiveTaxRate")).toMatchObject({ status: "value", value: 0.2 });
    expect(result.metric("roic").value).toBeCloseTo((200 * 0.8) / 1000, 12);
    expect(
      result.metric("roic").inputs.map(({ series, periodKey }) => [series, periodKey]),
    ).toEqual([
      ["operatingIncome", "duration:12|2025-12-31"],
      ["incomeTaxExpense", "duration:12|2025-12-31"],
      ["pretaxIncome", "duration:12|2025-12-31"],
      ["stockholdersEquity", "instant|2025-12-31"],
      ["debt", "instant|2025-12-31"],
      ["cash", "instant|2025-12-31"],
    ]);
    expect(result.sourceGaps).toEqual([]);
    expect(invariantRun(context(usGaap()), result.section.metrics)).not.toThrow();
  });

  test("labels an IFRS figure with its filed currency, never a quote currency", () => {
    const result = evaluate(
      context(
        {
          ProfitLossFromOperatingActivities: flow(() => 200, "EUR"),
          DepreciationAndAmortisationExpense: flow(() => 50, "EUR"),
          IncomeTaxExpenseContinuingOperations: flow(() => 30, "EUR"),
          ProfitLossBeforeTax: flow(() => 150, "EUR"),
          InterestExpense: flow(() => 25, "EUR"),
          Revenue: flow(() => 900, "EUR"),
        },
        {},
        "ifrs-full",
      ),
    );

    expect(result.metric("ebitdaProxy")).toMatchObject({ value: 250, currency: "EUR" });
    expect(result.metric("effectiveTaxRate")).toMatchObject({ value: 0.2 });
    expect(result.metric("interestCoverage")).toMatchObject({ value: 8 });
  });

  test("R1: a 13-month fact never anchors and an older same-period fact is never used", () => {
    const longYear = evaluate(
      context(
        usGaap({
          IncomeTaxExpenseBenefit: {
            units: { USD: [fact(32, 2025, { start: "2024-12-01" })] },
          },
        }),
      ),
    );
    const olderPretax = evaluate(
      context(
        usGaap({
          IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
            flow((year) => (year === 2025 ? undefined : 160)),
        }),
      ),
    );

    expect(longYear.metric("effectiveTaxRate")).toMatchObject({
      status: "missing",
      reason: "no year-aligned annual income tax expense fact",
    });
    expect(olderPretax.metric("effectiveTaxRate")).toMatchObject({
      status: "missing",
      reason: "no same-period pretax income for the fiscal year ending 2025-12-31",
    });
    expect(olderPretax.sourceGaps[0]?.triage).toBe("material");
  });

  test("R1b: an instant at any other date than the flow's period end gives a material missing", () => {
    const result = evaluate(
      context(
        usGaap({
          StockholdersEquity: {
            units: {
              USD: [
                fact(700, 2025, { start: undefined, end: "2025-12-30" }),
                fact(650, 2024, { start: undefined }),
              ],
            },
          },
        }),
      ),
    );

    expect(result.metric("roic")).toMatchObject({
      status: "missing",
      reason: "no stockholders' equity at the fiscal year end 2025-12-31",
      periodEnd: "2025-12-31",
    });
    expect(result.metric("roic").cause).toBeUndefined();
    expect(result.sourceGaps[0]?.triage).toBe("material");
  });

  test("R2: zero or negative denominators are not meaningful; nothing is clamped", () => {
    const negative = evaluate(
      context(
        usGaap({
          Revenues: flow(() => -5),
          InterestExpense: flow(() => 0),
          DepreciationDepletionAndAmortization: flow(() => -1),
          IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
            flow(() => -10),
        }),
      ),
    );
    const unclamped = evaluate(
      context(
        usGaap({
          IncomeTaxExpenseBenefit: flow(() => 200),
          OperatingIncomeLoss: flow(() => -80),
        }),
      ),
    );
    const benefit = evaluate(context(usGaap({ IncomeTaxExpenseBenefit: flow(() => -16) })));
    const noCapital = evaluate(
      context(usGaap({ CashAndCashEquivalentsAtCarryingValue: instant(() => 1100) })),
    );

    for (const [id, reason] of [
      ["freeCashFlowMargin", "revenue is zero or negative"],
      ["interestCoverage", "interest expense is zero or negative"],
      ["ebitdaProxy", "depreciation and amortization is negative"],
      ["effectiveTaxRate", "pretax income is zero or negative"],
      ["roic", "pretax income is zero or negative"],
    ] as const) {
      expect(negative.metric(id)).toMatchObject({
        status: "not-meaningful",
        reason: `${reason} for the fiscal year ending 2025-12-31`,
      });
    }
    expect(negative.sourceGaps[0]?.triage).toBe("diagnostic");
    expect(unclamped.metric("effectiveTaxRate")).toMatchObject({ status: "value", value: 1.25 });
    expect(unclamped.metric("interestCoverage")).toMatchObject({ status: "value", value: -2 });
    expect(unclamped.metric("roic")).toMatchObject({
      status: "not-meaningful",
      reason: "effective tax rate is outside 0-100% for the fiscal year ending 2025-12-31",
    });
    expect(benefit.metric("effectiveTaxRate")).toMatchObject({ status: "value", value: -0.1 });
    expect(benefit.metric("roic")).toMatchObject({ status: "not-meaningful" });
    expect(noCapital.metric("roic")).toMatchObject({
      status: "not-meaningful",
      reason: "invested capital is zero or negative at the fiscal year end 2025-12-31",
    });
    for (const result of [negative, unclamped, benefit, noCapital]) {
      expect(invariantRun(result.ctx, result.section.metrics)).not.toThrow();
    }
    const happy = context(usGaap());
    for (const metric of operatingRatiosSection(happy).section.metrics) {
      const forged = operatingRatiosSection(happy).section.metrics.map((candidate) =>
        candidate.id === metric.id
          ? { ...candidate, status: "not-meaningful", value: undefined, reason: "forged" }
          : candidate,
      );
      expect(invariantRun(happy, forged), metric.id).toThrow("not-meaningful hits a bound");
    }
  });

  test("R3: a depository issuer has no FCF margin, interest coverage or ROIC", () => {
    const result = evaluate(context(usGaap(), { depositorySic: "6022" }));

    for (const id of ["freeCashFlowMargin", "interestCoverage", "roic"]) {
      expect(result.metric(id)).toMatchObject({ status: "not-applicable", inputs: [] });
      expect(result.metric(id).reason).toContain("depository issuer (SIC 6022)");
    }
    expect(result.metric("ebitdaProxy").status).toBe("value");
    expect(result.metric("effectiveTaxRate").status).toBe("value");
    expect(result.sourceGaps[0]?.triage).toBe("diagnostic");
  });

  test("R8: a stale fiscal year is missing, never an old value", () => {
    const result = evaluate(context(usGaap(), {}, "us-gaap", "2028-07-01T00:00:00.000Z"));

    expect(result.metric("effectiveTaxRate")).toMatchObject({
      status: "missing",
      reason: "stale income tax expense as of 2025-12-31",
    });
    expect(result.metric("roic").reason).toBe("stale operating income as of 2025-12-31");
  });

  test("never-filed inputs, debt included, are diagnostic; a filed instant missing at the year end stays material", () => {
    const unfiled = evaluate(
      context(
        usGaap({
          InterestExpense: undefined,
          DepreciationDepletionAndAmortization: undefined,
          CashAndCashEquivalentsAtCarryingValue: undefined,
        }),
      ),
    );
    const noDebt = evaluate(context(usGaap({ LongTermDebt: undefined })));
    const mixed = evaluate(
      context(
        usGaap({
          CashAndCashEquivalentsAtCarryingValue: undefined,
          StockholdersEquity: instant((year) => (year === 2025 ? undefined : 700)),
        }),
      ),
    );

    expect(unfiled.metric("interestCoverage")).toMatchObject({
      status: "missing",
      reason: "interest expense not filed by the issuer",
      cause: "not-filed",
      periodEnd: "2025-12-31",
    });
    expect(unfiled.metric("ebitdaProxy").cause).toBe("not-filed");
    expect(unfiled.metric("roic")).toMatchObject({
      status: "missing",
      reason: "cash and cash equivalents not filed by the issuer",
      cause: "not-filed",
    });
    expect(unfiled.sourceGaps[0]?.triage).toBe("diagnostic");
    expect(
      invariantRun(
        context(
          usGaap({
            InterestExpense: undefined,
            DepreciationDepletionAndAmortization: undefined,
            CashAndCashEquivalentsAtCarryingValue: undefined,
          }),
        ),
        unfiled.section.metrics,
      ),
    ).not.toThrow();
    expect(noDebt.ctx.statements?.unfiledSeries).toContain("debt");
    expect(noDebt.metric("roic")).toMatchObject({
      status: "missing",
      reason: "debt not filed by the issuer",
      cause: "not-filed",
    });
    expect(noDebt.sourceGaps[0]?.triage).toBe("diagnostic");
    expect(invariantRun(noDebt.ctx, noDebt.section.metrics)).not.toThrow();
    const otherYearDebt = evaluate(
      context(
        usGaap({
          LongTermDebt: undefined,
          NotesPayableCurrent: instant((year) => (year === 2024 ? 400 : undefined)),
        }),
      ),
    );
    expect(otherYearDebt.ctx.statements?.unfiledSeries).not.toContain("debt");
    expect(otherYearDebt.metric("roic")).toMatchObject({
      status: "missing",
      reason: "no debt at the fiscal year end 2025-12-31",
    });
    expect(otherYearDebt.metric("roic").cause).toBeUndefined();
    expect(otherYearDebt.sourceGaps[0]?.triage).toBe("material");
    const zeroDebt = evaluate(context(usGaap({ LongTermDebt: instant(() => 0) })));
    expect(zeroDebt.metric("roic")).toMatchObject({ status: "value", value: 160 / 600 });
    expect(mixed.metric("roic")).toMatchObject({
      status: "missing",
      reason: "no stockholders' equity at the fiscal year end 2025-12-31",
    });
    expect(mixed.metric("roic").cause).toBeUndefined();
  });

  test("unselected IFRS debt stays filed and makes ROIC and Financial Strength gaps material", () => {
    for (const [concept, debt] of [
      ["BondsIssued", instant(() => 400, "EUR")],
      [
        "CurrentPortionOfLongtermBorrowings",
        { units: { shares: [fact(400, 2010, { form: "6-K" })] } },
      ],
      ["BondsIssued", { units: { shares: [null] } }],
      ["BondsIssued", { units: { shares: [{ filed: "invalid" }] } }],
    ] as const) {
      const concepts = {
        Revenue: flow(() => 1000, "EUR"),
        CashFlowsFromUsedInOperatingActivities: flow(() => 300, "EUR"),
        PurchaseOfPropertyPlantAndEquipment: flow(() => 100, "EUR"),
        ProfitLossFromOperatingActivities: flow(() => 200, "EUR"),
        InterestExpense: flow(() => 40, "EUR"),
        DepreciationAndAmortisationExpense: flow(() => 50, "EUR"),
        IncomeTaxExpenseContinuingOperations: flow(() => 32, "EUR"),
        ProfitLossBeforeTax: flow(() => 160, "EUR"),
        Equity: instant(() => 700, "EUR"),
        CashAndCashEquivalents: instant(() => 100, "EUR"),
        [concept]: debt,
      };
      const ctx = context(concepts, {}, "ifrs-full");
      const result = evaluate(ctx);
      const payload = { cik: 1, facts: { "ifrs-full": concepts } };

      expect(result.metric("roic")).toMatchObject({
        status: "missing",
        reason: "no debt at the fiscal year end 2025-12-31",
      });
      expect(result.metric("roic").cause).toBeUndefined();
      expect(result.sourceGaps[0]?.triage).toBe("material");
      expect(ctx.statements?.unfiledSeries).not.toContain("debt");
      expect(ctx.statements?.statements.balanceSheet.debt.annual).toEqual([]);
      expect(ctx.statements?.statements.balanceSheet.debt.interim).toEqual([]);
      expect(invariantRun(ctx, result.section.metrics, payload)).not.toThrow();

      const lens = financialLensMetrics(ctx);
      for (const id of [
        "debt",
        "netDebt",
        "debtToEquity",
        "debtToMarketCap",
        "netDebtToMarketCap",
      ]) {
        const metric = lens.lensMetrics["Financial Strength"].find((row) => row.id === id);
        expect(metric, id).toMatchObject({ status: "missing" });
        expect(metric?.cause, id).toBeUndefined();
      }
      expect(
        lens.sourceGaps.find((gap) => gap.source === "financial-lens-financial-strength")?.triage,
      ).toBe("material");

      const forgedCtx = {
        ...ctx,
        statements: {
          ...ctx.statements!,
          unfiledSeries: [...(ctx.statements?.unfiledSeries ?? []), "debt" as const],
        },
      };
      const forged = operatingRatiosSection(forgedCtx);
      expect(invariantRun(forgedCtx, forged.section.metrics, payload)).toThrow(
        `debt unfiled but ifrs-full:${concept} has facts`,
      );
    }
  });

  test("the fixture invariant re-derives values and rejects forged lineage or causes", () => {
    const ctx = context(usGaap());
    const { section } = operatingRatiosSection(ctx);
    const forged = (id: string, change: (metric: Record<string, unknown>) => unknown) =>
      section.metrics.map((metric) =>
        metric.id === id ? change(metric as unknown as Record<string, unknown>) : metric,
      );
    const forgedInput = (id: string, index: number, patch: Record<string, unknown>) =>
      forged(id, (metric) => ({
        ...metric,
        inputs: (metric.inputs as readonly Record<string, unknown>[]).map((input, at) =>
          at === index ? { ...input, ...patch } : input,
        ),
      }));

    expect(invariantRun(ctx, section.metrics)).not.toThrow();
    for (const id of section.metrics.map((metric) => metric.id)) {
      expect(
        invariantRun(
          ctx,
          forged(id, (metric) => ({ ...metric, value: 0.123 })),
        ),
        id,
      ).toThrow(`operating-ratios.${id}`);
    }
    expect(
      invariantRun(
        ctx,
        forgedInput("roic", 3, {
          periodKey: "instant|2024-12-31",
          periodEnd: "2024-12-31",
          value: 700,
        }),
      ),
    ).toThrow("instants sit at the flow period end");
    expect(
      invariantRun(
        ctx,
        forgedInput("interestCoverage", 1, {
          periodKey: "duration:12|2024-12-31",
          periodStart: "2024-01-01",
          periodEnd: "2024-12-31",
        }),
      ),
    ).toThrow("flow inputs join one period");
    expect(
      invariantRun(
        ctx,
        forged("interestCoverage", (metric) => ({
          ...metric,
          status: "missing",
          value: undefined,
          cause: "not-filed",
          reason: "interest expense not filed by the issuer",
        })),
      ),
    ).toThrow("not-filed needs one of its own inputs unfiled");
    expect(
      invariantRun(
        ctx,
        forged("roic", (metric) => ({
          ...metric,
          status: "not-applicable",
          inputs: [],
          sourceIds: [],
        })),
      ),
    ).toThrow("not-applicable iff the issuer is a depository");
    for (const id of section.metrics.map((metric) => metric.id)) {
      expect(
        invariantRun(
          ctx,
          forged(id, (metric) => ({
            ...metric,
            status: "missing",
            value: undefined,
            reason: "no same-period input",
          })),
        ),
        id,
      ).toThrow(`operating-ratios.${id} missing has a filed input that fails to resolve`);
    }
    expect(
      invariantRun(
        ctx,
        section.metrics.filter((metric) => metric.id !== "ebitdaProxy"),
      ),
    ).toThrow("operating-ratios carries every metric in order");
  });

  test("renders coverage as a multiple and the EBITDA proxy in currency", () => {
    const { section } = operatingRatiosSection(context(usGaap()));
    const markdown = renderMarkdownReport(
      researchReport({
        jobType: "equity",
        symbol: "TEST",
        sources: [evidenceSource(SOURCE_ID)],
        extras: { metricSections: [section] },
      }),
    );

    expect(markdown).toContain("### Operating Ratios\n");
    expect(markdown).toContain(
      String.raw`- Interest coverage \(operating income / interest expense\): 5.00x`,
    );
    expect(markdown).toContain(String.raw`- Operating income + D&A \(EBITDA proxy\): $250`);
    expect(markdown).toContain("- Free cash flow margin: 20.0%");
  });

  test("qualifies ETR and ROIC when pretax income falls back to the pre-equity-method concept", () => {
    const fallback = usGaap({
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest:
        undefined,
      IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments:
        flow(() => 160),
    });
    const scoped = evaluate(context(fallback));
    const plain = evaluate(context(usGaap()));
    const scope =
      "pretax income is pretax income (continuing operations, before equity-method income)";

    for (const id of ["effectiveTaxRate", "roic"]) {
      expect(scoped.metric(id).status, id).toBe("value");
      expect(scoped.metric(id).basis, id).toEndWith(scope);
      expect(plain.metric(id).basis, id).not.toContain("equity-method");
    }
    expect(invariantRun(scoped.ctx, scoped.section.metrics)).not.toThrow();
    expect(
      invariantRun(
        scoped.ctx,
        scoped.section.metrics.map((metric) =>
          metric.id === "roic" ? { ...metric, basis: plain.metric("roic").basis } : metric,
        ),
      ),
    ).toThrow("operating-ratios.roic basis names the pretax scope");
    const markdown = renderMarkdownReport(
      researchReport({
        jobType: "equity",
        symbol: "TEST",
        sources: [evidenceSource(SOURCE_ID)],
        extras: { metricSections: [scoped.section] },
      }),
    );
    expect(markdown).toContain(String.raw`before equity-method income\)`);
  });

  test("every label, basis, reason and gap passes the research-only gate", () => {
    expect(evaluated.length).toBeGreaterThan(8);
    const texts = evaluated.flatMap(({ section, sourceGaps }) => [
      section.title,
      ...section.metrics.flatMap((metric) => [
        metric.label,
        metric.basis,
        metric.reason ?? "",
        ...metric.inputs.map((input) => input.label),
      ]),
      ...sourceGaps.map((gap) => gap.message),
    ]);

    expect(texts.filter((text) => violatesResearchOnly(text) !== null)).toEqual([]);
  });
});
