import { describe, expect, test } from "bun:test";
import type { ExtendedEvidence } from "../src/domain/types";
import { readSubsequentFinancingBridgeArtifact } from "../src/run-artifacts";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  deriveSubsequentFinancingBridge,
  withSubsequentFinancingEvidence,
} from "../src/sources/extended-evidence/subsequent-financing";
import { marketSnapshot, verifiedMarketSnapshot } from "./support/fixtures";

const command = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "TEST",
  depth: "deep",
} as const;
const sourceId = "extended-sec-edgar-test-fundamentals";

function companyFacts(includePostPeriodStatement = false): unknown {
  const annual = {
    val: 400,
    form: "10-K",
    fp: "FY",
    fy: 2024,
    filed: "2025-02-15",
    start: "2024-01-01",
    end: "2024-12-31",
  };
  const quarter = {
    form: "10-Q",
    fp: "Q1",
    fy: 2025,
    filed: "2025-05-01",
    end: "2025-03-31",
  };
  const laterQuarter = {
    form: "10-Q",
    fp: "Q2",
    fy: 2025,
    filed: "2025-08-01",
    end: "2025-06-30",
  };
  return {
    facts: {
      "us-gaap": {
        Revenues: { units: { USD: [annual] } },
        CashAndCashEquivalentsAtCarryingValue: {
          units: {
            USD: [
              { ...quarter, val: 50 },
              ...(includePostPeriodStatement ? [{ ...laterQuarter, val: 140 }] : []),
            ],
          },
        },
        LongTermDebt: {
          units: {
            USD: [
              { ...quarter, val: 20 },
              ...(includePostPeriodStatement ? [{ ...laterQuarter, val: 110 }] : []),
            ],
          },
        },
        ProceedsFromIssuanceOfLongTermDebt: {
          units: {
            USD: [
              {
                val: 100,
                form: "8-K",
                filed: "2025-05-16",
                start: "2025-05-15",
                end: "2025-05-15",
                accn: "0001-financing",
              },
            ],
          },
        },
        PaymentsOfDebtIssuanceFees: {
          units: {
            USD: [
              {
                val: 4,
                form: "8-K",
                filed: "2025-05-16",
                start: "2025-05-15",
                end: "2025-05-15",
                accn: "0001-financing",
              },
            ],
          },
        },
      },
    },
  };
}

function statements(payload: unknown, analysisAsOf = "2025-06-01T00:00:00.000Z") {
  return deriveFinancialStatements(payload, {
    symbol: "TEST",
    generatedAt: analysisAsOf,
    analysisAsOf,
    sourceId,
  });
}

function evidence(): ExtendedEvidence {
  return {
    instrument: { symbol: "TEST", assetClass: "equity" },
    items: [
      {
        category: "sec-edgar",
        title: "TEST SEC Fundamental Evidence",
        summary: "Filed balances.",
        sourceIds: [sourceId],
        observedAt: "2025-05-01T00:00:00.000Z",
        metrics: {
          revenue: 400,
          revenuePeriodMonths: 12,
          cash: 50,
          cashPeriodEnd: "2025-03-31",
          debt: 20,
          debtPeriodEnd: "2025-03-31",
        },
      },
    ],
    gaps: [],
  };
}

function strength(result: ReturnType<typeof addFinancialLensEvidence>) {
  return result.artifact?.lenses.find((lens) => lens.name === "Financial Strength");
}

describe("subsequent financing bridge", () => {
  test("keeps filed balances unchanged and marks current strength partial", () => {
    const payload = companyFacts();
    const bridge = deriveSubsequentFinancingBridge(payload, statements(payload));
    expect(bridge).toMatchObject({
      version: 1,
      statementPeriodEnd: "2025-03-31",
      events: [
        {
          disclosureDate: "2025-05-16",
          eventDate: "2025-05-15",
          instrument: "debt",
          proceeds: { amount: 100, currency: "USD", basis: "gross" },
          costs: { amount: 4, currency: "USD", basis: "cost" },
          sourceIds: [sourceId],
          reconciled: false,
        },
      ],
    });
    expect(readSubsequentFinancingBridgeArtifact(bridge)).toEqual(bridge);

    const baseline = addFinancialLensEvidence(
      command,
      [marketSnapshot({ symbol: "TEST", marketCap: 1000 })],
      evidence(),
      verifiedMarketSnapshot({ symbol: "TEST" }),
      "2025-06-01T00:00:00.000Z",
    );
    const bridgedEvidence = withSubsequentFinancingEvidence(evidence(), bridge);
    const bridged = addFinancialLensEvidence(
      command,
      [marketSnapshot({ symbol: "TEST", marketCap: 1000 })],
      bridgedEvidence,
      verifiedMarketSnapshot({ symbol: "TEST" }),
      "2025-06-01T00:00:00.000Z",
      bridge,
    );

    expect(strength(bridged)).toMatchObject({
      currentStatus: "partial",
      currentStatusReasonCodes: ["unreconciled-post-period-financing"],
    });
    for (const key of ["cash", "debt", "netDebt"]) {
      expect(strength(bridged)?.metrics.find((metric) => metric.key === key)).toEqual(
        strength(baseline)?.metrics.find((metric) => metric.key === key),
      );
    }
    expect(
      bridgedEvidence?.items.find((item) => item.category === "subsequent-events")?.summary,
    ).toContain("Filed cash and debt remain unchanged");
    expect(JSON.stringify(bridge)).not.toContain("proFormaCash");
  });

  test("does not retain an event already covered by a later statement period", () => {
    const payload = companyFacts(true);

    expect(
      deriveSubsequentFinancingBridge(payload, statements(payload, "2025-09-01T00:00:00.000Z")),
    ).toBeUndefined();
  });
});
