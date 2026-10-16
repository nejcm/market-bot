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

function statements(payload: unknown) {
  return deriveFinancialStatements(payload, {
    symbol: "TEST",
    generatedAt: GENERATED_AT,
    analysisAsOf: GENERATED_AT,
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
    expect(artifact.omissions).toEqual([]);
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
