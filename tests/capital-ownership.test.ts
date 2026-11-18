import { describe, expect, test } from "bun:test";
import {
  deriveCapitalOwnershipArtifact,
  readCapitalOwnershipArtifact,
} from "../src/sources/extended-evidence/capital-ownership";
import { deriveEquityAnalysisCompleteness } from "../src/sources/extended-evidence/equity-analysis-completeness";
import { capitalReturnSection } from "../src/sources/extended-evidence/capital-return";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";

const SOURCE_ID = "extended-sec-edgar-test-fundamentals";
const GENERATED_AT = "2026-07-23T00:00:00.000Z";

function annual(value: number, year: number): Record<string, unknown> {
  return {
    start: `${String(year)}-01-01`,
    end: `${String(year)}-12-31`,
    val: value,
    accn: `test-${String(year)}`,
    fy: year,
    fp: "FY",
    form: "10-K",
    filed: `${String(year + 1)}-02-15`,
  };
}

function instant(value: number, end = "2025-12-31"): Record<string, unknown> {
  return {
    end,
    val: value,
    accn: `test-${end}`,
    fy: 2025,
    fp: "FY",
    form: "10-K",
    filed: "2026-02-15",
  };
}

function untagged(
  start: string,
  end: string,
  value: number,
  accn: string,
): Record<string, unknown> {
  return {
    start,
    end,
    val: value,
    accn,
    fy: 2024,
    form: "10-K",
    filed: "2026-02-15",
  };
}

function concept(unit: string, facts: readonly Record<string, unknown>[]): Record<string, unknown> {
  return { units: { [unit]: facts } };
}

function companyfacts(includeCapitalFacts = true): Record<string, unknown> {
  const years = [2023, 2024, 2025];
  return {
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: concept(
          "USD",
          years.map((year) => annual(100 + year, year)),
        ),
        ...(includeCapitalFacts
          ? {
              WeightedAverageNumberOfDilutedSharesOutstanding: concept(
                "shares",
                years.map((year) => annual(1_000_000 + year, year)),
              ),
              ShareBasedCompensation: concept(
                "USD",
                years.map((year) => annual(10 + year, year)),
              ),
              PaymentsForRepurchaseOfCommonStock: concept(
                "USD",
                years.map((year) => annual(year === 2024 ? 0 : 20 + year, year)),
              ),
              PaymentsOfDividends: concept(
                "USD",
                years.map((year) => annual(5 + year, year)),
              ),
              Assets: concept("USD", [instant(1)]),
              LongTermDebtCurrent: concept("USD", [instant(50)]),
              LongTermDebtNoncurrent: concept("USD", [instant(200)]),
              LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: concept("USD", [
                instant(50),
              ]),
              LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo: concept("USD", [instant(75)]),
            }
          : {}),
      },
    },
  };
}

function ladder(
  rows: readonly (readonly [string, number])[],
  filing: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    rows.map(([suffix, val]) => [
      `LongTermDebtMaturitiesRepaymentsOfPrincipal${suffix}`,
      concept("USD", [{ ...filing, val }]),
    ]),
  );
}

function merge(...groups: Record<string, unknown>[]): Record<string, unknown> {
  const merged: Record<string, { units: { USD: unknown[] } }> = {};
  for (const group of groups) {
    for (const [name, value] of Object.entries(group)) {
      const rows = (value as { units: { USD: unknown[] } }).units.USD;
      merged[name] = { units: { USD: [...(merged[name]?.units.USD ?? []), ...rows] } };
    }
  }
  return merged;
}

function statements(payload: unknown, asOf = GENERATED_AT) {
  return deriveFinancialStatements(payload, {
    symbol: "TEST",
    generatedAt: asOf,
    analysisAsOf: asOf,
    sourceId: SOURCE_ID,
  });
}

describe("capital ownership artifact", () => {
  test("drops malformed observations without throwing", () => {
    const artifact = {
      version: 1,
      generatedAt: GENERATED_AT,
      symbol: "TEST",
      stockBasedCompensation: [],
      omissions: [],
    };
    const malformedArtifacts = [
      [
        {
          ...artifact,
          stockBasedCompensation: [
            {
              value: "not-numeric",
              periodStart: "2025-01-01",
              periodEnd: "2025-12-31",
              filedAt: "2026-02-15",
              form: "10-K",
              taxonomy: "us-gaap",
              concept: "ShareBasedCompensation",
              unit: "USD",
              sourceIds: [SOURCE_ID],
            },
          ],
        },
        "capitalOwnership.stockBasedCompensation.invalid",
      ],
      [{ ...artifact, omissions: ["garbage"] }, "capitalOwnership.omissions.invalid"],
    ] as const;

    for (const [malformed, reason] of malformedArtifacts) {
      let result: ReturnType<typeof readCapitalOwnershipArtifact> | "not-called" = "not-called";
      expect(() => {
        result = readCapitalOwnershipArtifact(malformed);
      }).not.toThrow();
      expect(result).toMatchObject({
        readDiagnostics: {
          droppedObservationCount: 1,
          drops: [{ reason, count: 1 }],
        },
      });
    }
  });

  test("derives filed annual histories and debt maturity buckets", () => {
    const payload = companyfacts();

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.stockBasedCompensation).toHaveLength(3);
    for (const field of ["dilutedShares", "buybacks", "dividendsPaid"]) {
      expect(artifact).not.toHaveProperty(field);
      expect(readCapitalOwnershipArtifact(artifact)).not.toHaveProperty(field);
    }
    expect(readCapitalOwnershipArtifact(artifact)?.stockBasedCompensation).toEqual(
      artifact.stockBasedCompensation,
    );
    expect(
      deriveEquityAnalysisCompleteness({
        asOf: GENERATED_AT,
        assetClass: "equity",
        financialStatements: statements(payload),
        capitalOwnership: artifact,
      }).dimensions.capitalOwnership,
    ).toMatchObject({ status: "complete", sourceIds: [SOURCE_ID] });
    expect(artifact.debtPrincipal).toMatchObject({
      current: { value: 50, sourceIds: [SOURCE_ID] },
      noncurrent: { value: 200, sourceIds: [SOURCE_ID] },
      maturities: [
        { bucket: "next-twelve-months", value: 50 },
        { bucket: "year-two", value: 75 },
      ],
    });
    expect(readCapitalOwnershipArtifact(artifact)?.debtPrincipal?.maturities).toEqual(
      artifact.debtPrincipal?.maturities,
    );
    expect(artifact.omissions).toEqual([]);
  });

  test("maturity rows carry currency, period end, accession and source id", () => {
    const payload = companyfacts();
    const gaap = (payload.facts as Record<string, Record<string, unknown>>)["us-gaap"];
    gaap!.LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths = concept("USD", [
      {
        ...instant(7_210_000_000, "2026-05-31"),
        accn: "0001193125-26-277521",
        filed: "2026-06-20",
      },
    ]);

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.debtPrincipal?.maturities[0]).toEqual({
      bucket: "next-twelve-months",
      value: 7_210_000_000,
      periodEnd: "2026-05-31",
      filedAt: "2026-06-20",
      taxonomy: "us-gaap",
      concept: "LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths",
      unit: "USD",
      accessionNumber: "0001193125-26-277521",
      sourceIds: [SOURCE_ID],
    });
    const [row] = artifact.debtPrincipal!.maturities;
    const malformed = [
      { bucket: row!.bucket, value: row!.value },
      { ...row, unit: null },
      { ...row, filedAt: undefined },
      { ...row, taxonomy: "other" },
      { ...row, concept: "" },
      { ...row, accessionNumber: { wrong: true } },
    ];
    const read = readCapitalOwnershipArtifact({
      ...artifact,
      debtPrincipal: { ...artifact.debtPrincipal, maturities: [row, ...malformed] },
    });
    expect(read?.debtPrincipal?.maturities).toEqual([row!]);
    expect(read?.readDiagnostics?.drops).toEqual([
      { reason: "capitalOwnership.debtPrincipal.maturities.invalid", count: malformed.length },
    ]);
  });

  test.each([
    [350, "10-K", false],
    [380, "10-K", false],
    [349, "10-K", true],
    [381, "10-K", true],
    [90, "10-Q", true],
  ] as const)(
    "completeness uses only year-aligned statements: %s days, %s",
    (days, form, missing) => {
      const facts = [2023, 2024, 2025].map((year) => ({
        ...annual(0, year),
        end: new Date(Date.UTC(year, 0, 1) + days * 86_400_000).toISOString().slice(0, 10),
        form,
        fp: form === "10-Q" ? "Q1" : "FY",
      }));
      const financialStatements = statements({
        facts: {
          "us-gaap": {
            Revenues: concept(
              "USD",
              [2023, 2024, 2025].map((year) => annual(100, year)),
            ),
            WeightedAverageNumberOfDilutedSharesOutstanding: concept("shares", facts),
            PaymentsForRepurchaseOfCommonStock: concept("USD", facts),
            PaymentsOfDividends: concept("USD", facts),
          },
        },
      });
      const capitalPayload = companyfacts();
      const capitalOwnership = deriveCapitalOwnershipArtifact(capitalPayload, {
        ...statements(capitalPayload),
        sourceId: "capital-source",
      });
      const dimension = deriveEquityAnalysisCompleteness({
        asOf: GENERATED_AT,
        assetClass: "equity",
        financialStatements,
        capitalOwnership,
      }).dimensions.capitalOwnership;

      expect(dimension.reasonCodes).toEqual(
        missing ? ["diluted-share-history-missing", "payout-evidence-missing"] : [],
      );
      expect(dimension.sourceIds.includes(SOURCE_ID)).toBe(!missing);
      expect(dimension.sourceIds).toContain("capital-source");
    },
  );

  test("declares missing statement inputs even when capital ownership is present", () => {
    const payload = companyfacts();
    const capitalOwnership = deriveCapitalOwnershipArtifact(payload, statements(payload));
    const dimension = deriveEquityAnalysisCompleteness({
      asOf: GENERATED_AT,
      assetClass: "equity",
      capitalOwnership,
    }).dimensions.capitalOwnership;
    expect(dimension.reasonCodes).toEqual([
      "diluted-share-history-missing",
      "payout-evidence-missing",
    ]);
    const result = capitalReturnSection({ symbol: "TEST", capitalOwnership });
    expect(result.section.metrics.find(({ id }) => id === "dividendsLatestFy")).toMatchObject({
      status: "missing",
    });
    expect(result.sourceGaps.some(({ message }) => message.includes("dividends"))).toBe(true);
  });

  test("prefers the annual fact over a same-period-end Q4 fact filed in a 10-K", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          ShareBasedCompensation: concept("USD", [
            annual(42, 2025),
            {
              start: "2025-10-01",
              end: "2025-12-31",
              val: 999,
              accn: "test-q4",
              fy: 2025,
              fp: "Q4",
              form: "10-K",
              filed: "2026-02-15",
            },
          ]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.stockBasedCompensation).toEqual([
      expect.objectContaining({ value: 42, periodEnd: "2025-12-31" }),
    ]);
  });

  test("rejects a quarter-length SBC fact mis-tagged FY", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          ShareBasedCompensation: concept("USD", [
            annual(51_006_860, 2025),
            {
              start: "2025-10-01",
              end: "2025-12-31",
              val: 50_697_515,
              accn: "test-q4",
              fy: 2025,
              fp: "FY",
              form: "10-K",
              filed: "2026-02-15",
            },
          ]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.stockBasedCompensation).toEqual([
      expect.objectContaining({ value: 51_006_860, periodEnd: "2025-12-31" }),
    ]);
  });

  test("accepts 52/53-week durations and rejects an untagged quarter", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          ShareBasedCompensation: concept("USD", [
            untagged("2024-01-01", "2024-12-30", 364, "week-52"),
            untagged("2024-01-01", "2025-01-06", 371, "week-53"),
            untagged("2025-10-01", "2025-12-31", 90, "quarter"),
          ]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.stockBasedCompensation.map((fact) => fact.value).toSorted()).toEqual([
      364, 371,
    ]);
  });

  test("drops an undated fact and declares the missing annual history", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          ShareBasedCompensation: concept("USD", [
            {
              end: "2025-12-31",
              val: 999,
              accn: "test-undated",
              fy: 2025,
              form: "10-K",
              filed: "2026-02-15",
            },
          ]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.stockBasedCompensation).toEqual([]);
    expect(artifact.omissions).toContainEqual({
      code: "sbc-history-missing",
      message: "Annual stock-based compensation history is missing",
    });
  });

  test("a forward maturity row from an older 10-K is not the latest bucket (LLY year three at 2014-01-15)", () => {
    const fy2012 = {
      accn: "0000059478-13-000007",
      fy: 2012,
      fp: "FY",
      form: "10-K",
      filed: "2013-02-21",
    };
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2012)]),
          Assets: concept("USD", [{ ...fy2012, end: "2012-12-31", val: 1 }]),
          LongTermDebtNoncurrent: concept("USD", [{ ...fy2012, end: "2012-12-31", val: 1 }]),
          LongTermDebtMaturitiesRepaymentsOfPrincipalInYearThree: concept("USD", [
            { ...fy2012, end: "2012-12-31", val: 9_000_000 },
            {
              end: "2013-12-31",
              val: 15_500_000,
              accn: "0001193125-11-041620",
              fy: 2010,
              fp: "FY",
              form: "10-K",
              filed: "2011-02-22",
            },
          ]),
        },
      },
    };
    const asOf = "2014-01-15T00:00:00.000Z";

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload, asOf));

    expect(
      artifact.debtPrincipal?.maturities.find(({ bucket }) => bucket === "year-three"),
    ).toMatchObject({
      value: 9_000_000,
      periodEnd: "2012-12-31",
      accessionNumber: "0000059478-13-000007",
    });
  });

  test("a forward-only SBC row leaves the annual history missing", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2024)]),
          ShareBasedCompensation: concept("USD", [{ ...annual(42, 2025), filed: "2025-02-15" }]),
        },
      },
    };
    const asOf = "2026-01-20T00:00:00.000Z";

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload, asOf));

    expect(artifact.stockBasedCompensation).toEqual([]);
    expect(artifact.omissions.map(({ code }) => code)).toContain("sbc-history-missing");
  });

  test("an off-period SBC row from a later filing does not replace the standing value", () => {
    const shifted = { accn: "shifted", fy: 2026, fp: "FY", form: "10-K", filed: "2026-07-15" };
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2024)]),
          Assets: concept("USD", [{ ...shifted, end: "2026-03-31", val: 1 }]),
          OtherNonoperatingIncomeExpense: concept("USD", [
            { ...shifted, start: "2025-04-01", end: "2026-03-31", val: 1 },
          ]),
          ShareBasedCompensation: concept("USD", [
            annual(42, 2024),
            { ...annual(999, 2024), ...shifted },
          ]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.stockBasedCompensation).toEqual([
      expect.objectContaining({ value: 42, periodEnd: "2024-12-31" }),
    ]);
  });

  test("a later 10-K restating a prior year at its own statement date replaces the value", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          Assets: concept("USD", [{ ...instant(1), accn: "test-2025" }]),
          ShareBasedCompensation: concept("USD", [
            annual(42, 2024),
            { ...annual(50, 2024), accn: "test-2025", filed: "2026-02-15" },
            annual(60, 2025),
          ]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.stockBasedCompensation).toEqual([
      expect.objectContaining({ value: 60, periodEnd: "2025-12-31" }),
      expect.objectContaining({ value: 50, periodEnd: "2024-12-31", filedAt: "2026-02-15" }),
    ]);
  });

  test("keeps missing filed evidence explicit", () => {
    const payload = companyfacts(false);

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.stockBasedCompensation).toEqual([]);
    expect(artifact.omissions.map((omission) => omission.code)).toEqual(["sbc-history-missing"]);
    const result = capitalReturnSection({
      symbol: "TEST",
      statements: statements(payload),
      capitalOwnership: artifact,
    });
    expect(result.section.metrics.find(({ id }) => id === "sbcLatestFy")).toMatchObject({
      status: "missing",
    });
    expect(
      result.sourceGaps.some(({ message }) => message.includes("stock-based compensation")),
    ).toBe(true);
  });

  test("keeps subsequent financing separate from filed balances", () => {
    const payload = companyfacts();
    const financialStatements = statements(payload);

    const artifact = deriveCapitalOwnershipArtifact(payload, financialStatements, {
      version: 1,
      generatedAt: GENERATED_AT,
      symbol: "TEST",
      statementPeriodEnd: "2025-12-31",
      events: [
        {
          disclosureDate: "2026-03-01",
          eventDate: "2026-02-28",
          instrument: "debt",
          proceeds: { amount: 100, currency: "USD", basis: "gross" },
          costs: null,
          sourceIds: [SOURCE_ID],
          reconciled: false,
        },
      ],
      sourceIds: [SOURCE_ID],
    });

    expect(artifact.debtPrincipal?.noncurrent?.value).toBe(200);
    expect(artifact.subsequentFinancing).toEqual({
      eventCount: 1,
      reconciled: false,
      sourceIds: [SOURCE_ID],
    });
  });
});

describe("debt principal instants", () => {
  test("EQIX: the ladder is the FY2025 10-K schedule, never 10-Q buckets (0001101239-26-000032)", () => {
    const tenK = {
      end: "2025-12-31",
      accn: "0001101239-26-000032",
      fy: 2025,
      fp: "FY",
      form: "10-K",
      filed: "2026-02-11",
    };
    const q3 = {
      end: "2026-09-30",
      accn: "0001101239-26-000180",
      fy: 2026,
      fp: "Q3",
      form: "10-Q",
      filed: "2026-10-28",
    };
    const payload = {
      facts: {
        "us-gaap": merge(
          {
            RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [
              annual(100, 2025),
            ]),
            Assets: concept("USD", [{ ...tenK, val: 1 }]),
            LongTermDebtCurrent: concept("USD", [{ ...tenK, val: 1_299_000_000 }]),
          },
          ladder(
            [
              ["InNextTwelveMonths", 1_317_000_000],
              ["InYearTwo", 1_764_000_000],
              ["InYearThree", 1_433_000_000],
              ["InYearFour", 2_211_000_000],
              ["InYearFive", 2_739_000_000],
              ["AfterYearFive", 9_598_000_000],
            ],
            tenK,
          ),
          ladder(
            [
              ["RemainderOfFiscalYear", 601_000_000],
              ["InNextTwelveMonths", 1_072_000_000],
              ["InYearTwo", 1_414_000_000],
              ["InYearThree", 3_025_000_000],
              ["InYearFour", 3_199_000_000],
            ],
            q3,
          ),
        ),
      },
    };
    const asOf = "2026-11-18T00:00:00.000Z";

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload, asOf));

    expect(
      artifact.debtPrincipal?.maturities.map(({ bucket, value, periodEnd, accessionNumber }) => [
        bucket,
        value,
        periodEnd,
        accessionNumber,
      ]),
    ).toEqual(
      [
        ["next-twelve-months", 1_317_000_000],
        ["year-two", 1_764_000_000],
        ["year-three", 1_433_000_000],
        ["year-four", 2_211_000_000],
        ["year-five", 2_739_000_000],
        ["after-year-five", 9_598_000_000],
      ].map((row) => [...row, "2025-12-31", "0001101239-26-000032"]),
    );
    expect(artifact.debtPrincipal?.current).toMatchObject({
      value: 1_299_000_000,
      periodEnd: "2025-12-31",
    });
    expect(artifact.omissions).toEqual([
      expect.objectContaining({ code: "sbc-history-missing" }),
      {
        code: "debt-principal-leg-untagged",
        message: "LongTermDebtNoncurrent is not tagged at 2025-12-31",
      },
    ]);
  });

  test("INTC: a leg untagged at the newest instant is declared, not filled (0000050863-26-000157)", () => {
    const tenK = { fy: 2025, fp: "FY", form: "10-K", filed: "2026-01-23" };
    const q2 = { fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-07-24" };
    const fy2025 = { end: "2025-12-27", accn: "0000050863-26-000011", ...tenK };
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          Assets: concept("USD", [{ ...fy2025, val: 1 }]),
          LongTermDebtCurrent: concept("USD", [{ ...fy2025, val: 2_499_000_000 }]),
          LongTermDebtNoncurrent: concept("USD", [
            { ...fy2025, val: 44_086_000_000 },
            { end: "2026-06-27", accn: "0000050863-26-000157", ...q2, val: 48_549_000_000 },
          ]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(
      payload,
      statements(payload, "2026-10-28T00:00:00.000Z"),
    );

    expect(artifact.debtPrincipal?.noncurrent).toMatchObject({
      value: 48_549_000_000,
      periodEnd: "2026-06-27",
    });
    expect(artifact.debtPrincipal?.current).toBeUndefined();
    expect(artifact.omissions).toContainEqual({
      code: "debt-principal-leg-untagged",
      message: "LongTermDebtCurrent is not tagged at 2026-06-27",
    });
    expect(
      deriveEquityAnalysisCompleteness({
        asOf: GENERATED_AT,
        assetClass: "equity",
        financialStatements: statements(payload),
        capitalOwnership: artifact,
      }).dimensions.capitalOwnership.reasonCodes,
    ).toContain("debt-principal-leg-untagged");
  });

  test("both legs at one instant declare no untagged leg", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          Assets: concept("USD", [instant(1)]),
          LongTermDebtCurrent: concept("USD", [instant(50)]),
          LongTermDebtNoncurrent: concept("USD", [instant(200)]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.debtPrincipal).toMatchObject({
      current: { value: 50 },
      noncurrent: { value: 200 },
    });
    expect(artifact.omissions.map(({ code }) => code)).not.toContain("debt-principal-leg-untagged");
  });

  test("a ladder older than the latest annual balance sheet is withheld as stale (AMAT 2010 shape)", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          Assets: concept("USD", [instant(1)]),
          LongTermDebtNoncurrent: concept("USD", [instant(200)]),
          LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo: concept("USD", [
            { ...instant(75, "2023-12-31"), filed: "2024-02-15" },
          ]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.debtPrincipal).toEqual({
      noncurrent: expect.objectContaining({ value: 200 }),
      maturities: [],
    });
    expect(artifact.omissions).toContainEqual({
      code: "debt-maturity-stale",
      message:
        "Debt maturity schedule at 2023-12-31 predates the latest annual balance sheet 2025-12-31",
    });
    expect(artifact.omissions.map(({ code }) => code)).not.toContain("debt-maturity-untagged");
    expect(
      deriveEquityAnalysisCompleteness({
        asOf: GENERATED_AT,
        assetClass: "equity",
        financialStatements: statements(payload),
        capitalOwnership: artifact,
      }).dimensions.capitalOwnership.reasonCodes,
    ).toContain("debt-maturity-stale");
  });

  test("a 10-K/A re-tagging the instant wins over the original filing's ladder", () => {
    const amended = { accn: "amended", form: "10-K/A", filed: "2026-03-01" };
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          Assets: concept("USD", [instant(1)]),
          LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: concept("USD", [
            instant(50),
            { ...instant(55), ...amended },
          ]),
          LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo: concept("USD", [
            instant(75),
            { ...instant(80), ...amended },
          ]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload, "2026-04-01"));

    expect(
      artifact.debtPrincipal?.maturities.map(({ bucket, value, accessionNumber }) => [
        bucket,
        value,
        accessionNumber,
      ]),
    ).toEqual([
      ["next-twelve-months", 55, "amended"],
      ["year-two", 80, "amended"],
    ]);
  });

  test("debt with only a 10-Q maturity schedule declares no annual-report schedule (CIFR shape)", () => {
    const q3 = { ...instant(30, "2026-09-30"), form: "10-Q", fp: "Q3", filed: "2026-10-28" };
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          Assets: concept("USD", [instant(1)]),
          LongTermDebtNoncurrent: concept("USD", [{ ...q3, val: 5447 }]),
          LongTermDebtMaturitiesRepaymentsOfPrincipalInNextTwelveMonths: concept("USD", [q3]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(
      payload,
      statements(payload, "2026-11-18T00:00:00.000Z"),
    );

    expect(artifact.debtPrincipal).toEqual({
      noncurrent: expect.objectContaining({ value: 5447 }),
      maturities: [],
    });
    expect(artifact.omissions).toContainEqual({
      code: "debt-maturity-untagged",
      message: "No annual-report debt maturity schedule is tagged",
    });
  });

  test("a debt pair older than the latest annual balance sheet is withheld, not untagged", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          Assets: concept("USD", [instant(1)]),
          LongTermDebtCurrent: concept("USD", [
            { ...instant(50, "2013-12-31"), filed: "2014-02-15" },
          ]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.debtPrincipal).toEqual({ maturities: [] });
    expect(artifact.omissions.filter(({ code }) => code.startsWith("debt-"))).toEqual([
      {
        code: "debt-principal-stale",
        message: "Debt principal at 2013-12-31 predates the latest annual balance sheet 2025-12-31",
      },
    ]);
    expect(
      deriveEquityAnalysisCompleteness({
        asOf: GENERATED_AT,
        assetClass: "equity",
        financialStatements: statements(payload),
        capitalOwnership: artifact,
      }).dimensions.capitalOwnership.reasonCodes,
    ).toContain("debt-principal-stale");
  });

  test("without an annual balance sheet the ladder and pair are withheld", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          LongTermDebtCurrent: concept("USD", [instant(50)]),
          LongTermDebtMaturitiesRepaymentsOfPrincipalInYearTwo: concept("USD", [instant(75)]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.debtPrincipal).toEqual({ maturities: [] });
    expect(artifact.omissions.map(({ message }) => message)).toEqual(
      expect.arrayContaining([
        "Debt maturity schedule at 2025-12-31 has no annual balance sheet to date it against",
        "Debt principal at 2025-12-31 has no annual balance sheet to date it against",
      ]),
    );
  });
});
