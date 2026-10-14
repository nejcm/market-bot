import { describe, expect, test } from "bun:test";
import {
  deriveCapitalOwnershipArtifact,
  readCapitalOwnershipArtifact,
} from "../src/sources/extended-evidence/capital-ownership";
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
      dilutedShares: [],
      stockBasedCompensation: [],
      buybacks: [],
      dividendsPaid: [],
      omissions: [],
    };
    const malformedArtifacts = [
      [
        {
          ...artifact,
          dilutedShares: [
            {
              value: "not-numeric",
              periodStart: "2025-01-01",
              periodEnd: "2025-12-31",
              filedAt: "2026-02-15",
              form: "10-K",
              taxonomy: "us-gaap",
              concept: "WeightedAverageNumberOfDilutedSharesOutstanding",
              unit: "shares",
              sourceIds: [SOURCE_ID],
            },
          ],
        },
        "capitalOwnership.dilutedShares.invalid",
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

  test.each(["PaymentsOfDividendsCommonStock", "PaymentsOfOrdinaryDividends"])(
    "derives dividends paid from %s when the total is absent",
    (dividendConcept) => {
      const payload = {
        facts: {
          "us-gaap": {
            RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [
              annual(100, 2025),
            ]),
            [dividendConcept]: concept("USD", [annual(7, 2025)]),
          },
        },
      };
      const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

      expect(artifact.dividendsPaid).toEqual([
        expect.objectContaining({ value: 7, concept: dividendConcept, periodEnd: "2025-12-31" }),
      ]);
    },
  );

  test("derives filed annual histories and debt maturity buckets", () => {
    const payload = companyfacts();

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.dilutedShares).toHaveLength(3);
    expect(artifact.stockBasedCompensation).toHaveLength(3);
    expect(artifact.buybacks).toHaveLength(3);
    expect(artifact.dividendsPaid).toHaveLength(3);
    expect(artifact.buybacks.some((fact) => fact.value === 0)).toBe(true);
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

  test("prefers the annual fact over a same-period-end Q4 fact filed in a 10-K", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          PaymentsOfDividends: concept("USD", [
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

    expect(artifact.dividendsPaid).toEqual([
      expect.objectContaining({ value: 42, periodEnd: "2025-12-31" }),
    ]);
  });

  test("rejects a quarter-length fact mis-tagged FY in the MELI shape", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          WeightedAverageNumberOfDilutedSharesOutstanding: concept("shares", [
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

    expect(artifact.dilutedShares).toEqual([
      expect.objectContaining({ value: 51_006_860, periodEnd: "2025-12-31" }),
    ]);
  });

  test("accepts 52/53-week durations and rejects an untagged quarter", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          PaymentsForRepurchaseOfCommonStock: concept("USD", [
            untagged("2024-01-01", "2024-12-30", 364, "week-52"),
            untagged("2024-01-01", "2025-01-06", 371, "week-53"),
            untagged("2025-10-01", "2025-12-31", 90, "quarter"),
          ]),
        },
      },
    };

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.buybacks.map((fact) => fact.value).toSorted()).toEqual([364, 371]);
  });

  test("drops an undated fact and declares the missing annual history", () => {
    const payload = {
      facts: {
        "us-gaap": {
          RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", [annual(100, 2025)]),
          WeightedAverageNumberOfDilutedSharesOutstanding: concept("shares", [
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

    expect(artifact.dilutedShares).toEqual([]);
    expect(artifact.omissions).toContainEqual({
      code: "diluted-share-history-missing",
      message: "Annual diluted-share history is missing",
    });
  });

  test("keeps missing filed evidence explicit", () => {
    const payload = companyfacts(false);

    const artifact = deriveCapitalOwnershipArtifact(payload, statements(payload));

    expect(artifact.dilutedShares).toEqual([]);
    expect(artifact.stockBasedCompensation).toEqual([]);
    expect(artifact.buybacks).toEqual([]);
    expect(artifact.dividendsPaid).toEqual([]);
    expect(artifact.omissions.map((omission) => omission.code)).toEqual([
      "diluted-share-history-missing",
      "sbc-history-missing",
      "payout-evidence-missing",
    ]);
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
