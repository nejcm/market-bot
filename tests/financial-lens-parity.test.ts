import { afterAll, describe, expect, test } from "bun:test";
import { parseArgs, type InstrumentCommand } from "../src/cli/args";
import type { ExtendedEvidence } from "../src/domain/evidence";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { addValuationEvidence } from "../src/sources/extended-evidence/valuation";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  financialLensParityDiffs,
  expectFinancialLensParity,
  waiverPreconditionHolds,
  type ParityDiff,
  type ParityInput,
  type Waiver,
} from "./support/financial-lens-parity";
import { marketSnapshot, verifiedMarketSnapshot } from "./support/fixtures";
import {
  EQUITY_RUN_FIXTURES,
  loadFixture,
  runFixture,
  type RunFixtureResult,
} from "./support/run-fixtures";

const AAPL_SEC = ["extended-sec-edgar-aapl-filings", "extended-sec-edgar-aapl-fundamentals"];
const AAPL_FUNDAMENTALS = ["extended-sec-edgar-aapl-fundamentals"];
const AAPL_PEERS = [
  ...AAPL_SEC,
  "market-yahoo-equity-aapl",
  "market-yahoo-equity-msft",
  "extended-sec-edgar-msft-fundamentals",
  "extended-sec-edgar-msft-filings",
  "market-yahoo-equity-googl",
  "extended-sec-edgar-googl-fundamentals",
  "extended-sec-edgar-googl-filings",
  "market-yahoo-equity-amzn",
  "extended-sec-edgar-amzn-fundamentals",
  "extended-sec-edgar-amzn-filings",
  "market-yahoo-equity-meta",
  "extended-sec-edgar-meta-fundamentals",
  "extended-sec-edgar-meta-filings",
  "market-yahoo-equity-dell",
  "extended-sec-edgar-dell-fundamentals",
  "extended-sec-edgar-dell-filings",
];
const AAPL_PCF = ["market-yahoo-equity-aapl", "extended-sec-edgar-aapl-fundamentals"];
const AAPL_PCF_REBUILT = ["extended-sec-edgar-aapl-fundamentals", "market-yahoo-equity-aapl"];
const AAPL_QUALITY_GROWTH_IDS = [
  "lens.Quality.grossMargin.sourceIds",
  "lens.Quality.operatingMargin.sourceIds",
  "lens.Quality.netMargin.sourceIds",
  "lens.Quality.freeCashFlowProxy.sourceIds",
  "lens.Quality.cashConversion.sourceIds",
  "lens.Growth.revenueDeltaPercent.sourceIds",
  "lens.Growth.grossProfitDeltaPercent.sourceIds",
  "lens.Growth.operatingIncomeDeltaPercent.sourceIds",
  "lens.Growth.netIncomeDeltaPercent.sourceIds",
  "lens.Growth.dilutedEpsDeltaPercent.sourceIds",
  "lens.Growth.operatingCashFlowDeltaPercent.sourceIds",
];

function narrowed(
  fixture: string,
  oldIds: readonly string[],
  newIds: readonly string[],
  keys: readonly string[],
): readonly Waiver[] {
  return keys.map((key) => ({ fixture, key, old: [...oldIds], new: [...newIds], class: "D7" }));
}

function currency(fixture: string, key: string, value: string): readonly Waiver[] {
  return [{ fixture, key, old: undefined, new: value, class: "D6" }];
}

function aaplWaivers(fixture: string): readonly Waiver[] {
  return [
    ...narrowed(fixture, AAPL_SEC, AAPL_FUNDAMENTALS, [
      ...AAPL_QUALITY_GROWTH_IDS,
      "lens.Financial Strength.cash.sourceIds",
      "lens.Financial Strength.debt.sourceIds",
    ]),
    ...currency(fixture, "lens.Quality.freeCashFlowProxy.currency", "USD"),
    ...currency(fixture, "lens.Financial Strength.cash.currency", "USD"),
    ...currency(fixture, "lens.Financial Strength.debt.currency", "USD"),
    ...currency(fixture, "lens.Financial Strength.netDebt.currency", "USD"),
    ...narrowed(fixture, AAPL_PEERS, AAPL_FUNDAMENTALS, [
      "lens.Financial Strength.netDebt.sourceIds",
    ]),
    ...narrowed(fixture, AAPL_PEERS, AAPL_PCF, [
      "lens.Financial Strength.debtToMarketCap.sourceIds",
      "lens.Financial Strength.netDebtToMarketCap.sourceIds",
    ]),
    ...narrowed(fixture, [...AAPL_SEC, "market-yahoo-equity-aapl"], AAPL_PCF_REBUILT, [
      "lens.Value.pcfRatio.sourceIds",
    ]),
  ];
}

const WAIVERS: readonly Waiver[] = [
  ...aaplWaivers("equity-aapl-deep"),
  ...narrowed("equity-earnings-release-deep", AAPL_SEC, AAPL_FUNDAMENTALS, [
    ...AAPL_QUALITY_GROWTH_IDS,
    "lens.Quality.roe.sourceIds",
    "lens.Quality.roa.sourceIds",
    "lens.Financial Strength.cash.sourceIds",
    "lens.Financial Strength.debt.sourceIds",
    "lens.Financial Strength.netDebt.sourceIds",
    "lens.Financial Strength.currentRatio.sourceIds",
    "lens.Financial Strength.debtToEquity.sourceIds",
    "lens.Financial Strength.payoutRatio.sourceIds",
  ]),
  ...currency("equity-earnings-release-deep", "lens.Quality.freeCashFlowProxy.currency", "USD"),
  ...currency("equity-earnings-release-deep", "lens.Financial Strength.cash.currency", "USD"),
  ...currency("equity-earnings-release-deep", "lens.Financial Strength.debt.currency", "USD"),
  ...currency("equity-earnings-release-deep", "lens.Financial Strength.netDebt.currency", "USD"),
  ...aaplWaivers("equity-analysis-comprehensive"),
  ...aaplWaivers("equity-analysis-estimated-suppressed"),
  ...aaplWaivers("equity-web-fallback-deep"),
  {
    fixture: "equity-nbis-deep",
    key: "item.summary",
    old: "Financial Lens Evidence: Quality criteria-mixed (Operating margin -115.5%, Net margin 15.6%, FCF proxy $-3.7B, Cash conversion 4.66x); Growth criteria-mixed (Revenue YoY 479.0%, Operating income YoY -53.1%, Net loss (attrib.) YoY change (total operations) 112.9%, Diluted EPS YoY (total operations) 114.5%); Financial Strength insufficient-data (Cash $3.7B, Debt $4.1B, Net debt $425.1M, Current ratio 3.08x); Value insufficient-data (Valuation caveat Revenue multiples are not a valid basis for this issuer; the peer set is size/sector-comparable only., EV date basis EV mixes market cap (quote 2026-07-22) with cash/debt (balance sheet 2025-12-31), Enterprise value $57.6B, Annualized revenue $529.8M); Momentum criteria-mixed (Latest close $217, SMA50 225.23, SMA200 138.71, RSI14 50.25).",
    new: "Financial Lens Evidence: Quality criteria-mixed (Operating margin -115.5%, Net margin 15.6%, FCF proxy $-3.7B, Cash conversion 4.66x); Growth criteria-mixed (Revenue YoY 479.0%, Operating income YoY -53.1%, Net loss (attrib.) YoY change (total operations) 112.9%, Diluted EPS YoY (total operations) 114.5%); Financial Strength insufficient-data (Cash $3.7B, Debt $4.1B, Payout ratio 0.0%); Value insufficient-data (Valuation caveat Revenue multiples are not a valid basis for this issuer; the peer set is size/sector-comparable only., EV date basis EV mixes market cap (quote 2026-07-22) with cash/debt (balance sheet 2025-12-31), Enterprise value $57.6B, Annualized revenue $529.8M); Momentum criteria-mixed (Latest close $217, SMA50 225.23, SMA200 138.71, RSI14 50.25).",
    class: "D5",
  },
  {
    fixture: "equity-nbis-deep",
    key: "item.metrics.netDebt",
    old: 425_100_000,
    new: undefined,
    class: "D4",
  },
  {
    fixture: "equity-nbis-deep",
    key: "item.metrics.netDebtPeriodEnd",
    old: "2025-12-31",
    new: undefined,
    class: "D4",
  },
  {
    fixture: "equity-nbis-deep",
    key: "item.metrics.currentRatio",
    old: 3.083_780_599_554_915_5,
    new: undefined,
    class: "D4",
  },
  {
    fixture: "equity-nbis-deep",
    key: "item.metrics.currentRatioPeriodEnd",
    old: "2025-12-31",
    new: undefined,
    class: "D4",
  },
  {
    fixture: "equity-nbis-deep",
    key: "lens.Financial Strength.netDebt",
    old: 425_100_000,
    new: undefined,
    class: "D4",
  },
  {
    fixture: "equity-nbis-deep",
    key: "lens.Financial Strength.currentRatio",
    old: 3.083_780_599_554_915_5,
    new: undefined,
    class: "D4",
  },
  {
    fixture: "equity-nbis-deep",
    key: "lens.Financial Strength.order",
    old: ["cash", "debt", "netDebt", "currentRatio", "payoutRatio"],
    new: ["cash", "debt", "payoutRatio"],
    class: "D5",
  },
  ...currency("equity-nbis-deep", "lens.Quality.freeCashFlowProxy.currency", "USD"),
  ...currency("equity-nbis-deep", "lens.Financial Strength.cash.currency", "USD"),
  ...currency("equity-nbis-deep", "lens.Financial Strength.debt.currency", "USD"),
  ...["equity-fpi-quarterly", "equity-fpi-ifrs-semiannual"].flatMap((fixture) => {
    const sec = fixture === "equity-fpi-quarterly" ? "fpiq" : "ifrssa";
    const fundamentals = `extended-sec-edgar-${sec}-fundamentals`;
    const quote = `market-yahoo-equity-${sec}`;
    return [
      ...currency(fixture, "lens.Financial Strength.cash.currency", "USD"),
      ...currency(fixture, "lens.Financial Strength.debt.currency", "USD"),
      ...currency(fixture, "lens.Financial Strength.netDebt.currency", "USD"),
      ...narrowed(
        fixture,
        [fundamentals, quote],
        [fundamentals],
        ["lens.Financial Strength.netDebt.sourceIds"],
      ),
      ...narrowed(
        fixture,
        [fundamentals, quote],
        [quote, fundamentals],
        [
          "lens.Financial Strength.debtToMarketCap.sourceIds",
          "lens.Financial Strength.netDebtToMarketCap.sourceIds",
        ],
      ),
    ];
  }),
  {
    fixture: "equity-depository-deep",
    key: "item.summary",
    old: "Financial Lens Evidence: Quality criteria-supported (Net margin 23.8%, Cash conversion 5.60x, ROE 10.3%, ROA 0.6%); Growth criteria-supported (Revenue YoY 2.9%, Net income (attrib.) YoY 131.5%, Diluted EPS YoY 162.1%, Operating cash flow YoY 172.0%); Financial Strength insufficient-data (Cash $8.7B, Payout ratio 84.6%, Dividend yield 3.6%); Value insufficient-data (PE 17.60x, Forward PE 13.76x, Price/book 1.81x, PCF 2.17x); Momentum criteria-supported (Latest close $92, SMA50 86.71, SMA200 76.49, RSI14 66.28).",
    new: "Financial Lens Evidence: Quality criteria-supported (Net margin 23.8%, Cash conversion 5.60x, ROE 10.3%, ROA 0.6%); Growth criteria-supported (Revenue YoY 2.9%, Net income (attrib.) YoY 131.5%, Diluted EPS YoY 162.1%, Operating cash flow YoY 172.0%); Financial Strength insufficient-data (Cash CAD 8.7B, Payout ratio 84.6%, Dividend yield 3.6%); Value insufficient-data (PE 17.60x, Forward PE 13.76x, Price/book 1.81x, PCF 2.17x); Momentum criteria-supported (Latest close $92, SMA50 86.71, SMA200 76.49, RSI14 66.28).",
    class: "D6",
  },
  ...currency("equity-depository-deep", "lens.Financial Strength.cash.currency", "CAD"),
];

const results: RunFixtureResult[] = [];

afterAll(async () => {
  await Promise.all(results.splice(0).map((result) => result.cleanup()));
});

function instrumentCommand(argv: readonly string[]): InstrumentCommand {
  const command = parseArgs(argv);
  if (command.jobType !== "equity") {
    throw new Error(`not an instrument command: ${argv.join(" ")}`);
  }
  return command;
}

describe("Financial Lens accepted-difference gate", () => {
  for (const name of EQUITY_RUN_FIXTURES) {
    test(`${name} differs from the legacy builder only by waived classes`, async () => {
      const fixture = await loadFixture(name);
      const result = await runFixture(name, { llm: "replay" });
      results.push(result);
      const command = instrumentCommand(fixture.meta.argv);
      expectFinancialLensParity(name, command, result.collectedSources, WAIVERS);
    });
  }
});

const AS_OF = "2026-06-22T00:00:00.000Z";
const command = instrumentCommand(["equity", "AAPL", "--deep"]);

function annualFact(value: number, start: string, end: string) {
  return {
    val: value,
    form: "10-K",
    fp: "FY",
    fy: Number(end.slice(0, 4)),
    filed: "2026-05-01",
    start,
    end,
  };
}

function instantFact(value: number, end: string) {
  return {
    val: value,
    form: "10-Q",
    fp: "Q2",
    fy: Number(end.slice(0, 4)),
    filed: "2026-05-01",
    end,
  };
}

function statements(concepts: Record<string, unknown>, analysisAsOf = AS_OF) {
  return deriveFinancialStatements(
    { facts: { "us-gaap": concepts } },
    {
      symbol: "AAPL",
      generatedAt: analysisAsOf,
      analysisAsOf,
      sourceId: "extended-sec-edgar-aapl-fundamentals",
    },
  );
}

const VALUATION_ITEM: ExtendedEvidence["items"][number] = {
  category: "valuation",
  title: "AAPL Valuation Evidence",
  summary: "Valuation Evidence.",
  sourceIds: ["market-yahoo-equity-aapl"],
  observedAt: AS_OF,
  metrics: {
    enterpriseValue: 985,
    annualizedRevenue: 400,
    evToAnnualizedRevenue: 2.46,
    marketCapToAnnualizedRevenue: 2.5,
    valuationSupportability: "supported",
    revenuePeriodEnd: "2025-12-31",
    revenuePeriodMonths: 12,
  },
};

function evidence(): ExtendedEvidence {
  return {
    instrument: { symbol: "AAPL", assetClass: "equity" },
    items: [
      {
        category: "sec-edgar",
        title: "AAPL SEC Fundamental Evidence",
        summary: "SEC Fundamental Evidence.",
        sourceIds: ["extended-sec-edgar-aapl-filings", "extended-sec-edgar-aapl-fundamentals"],
        observedAt: AS_OF,
        metrics: { revenue: 999, revenuePeriodEnd: "2025-12-31", revenuePeriodMonths: 12 },
      },
      VALUATION_ITEM,
    ],
    gaps: [],
  };
}

function synthetic(concepts: Record<string, unknown>, analysisAsOf = AS_OF) {
  const statementsArtifact = statements(concepts, analysisAsOf);
  const result = addFinancialLensEvidence(
    command,
    [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
    withCanonicalFinancialLensInputs(evidence(), statementsArtifact),
    verifiedMarketSnapshot(),
    analysisAsOf,
    undefined,
    undefined,
    statementsArtifact,
  );
  const input: ParityInput = {
    marketSnapshots: [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })],
    verifiedMarketSnapshot: verifiedMarketSnapshot(),
    financialStatements: statementsArtifact,
    ...(result.extendedEvidence !== undefined ? { extendedEvidence: result.extendedEvidence } : {}),
    ...(result.artifact !== undefined ? { financialLenses: result.artifact } : {}),
    ...(result.metricSections !== undefined ? { metricSections: result.metricSections } : {}),
    sourceGaps: result.metricSectionGaps ?? [],
  };
  return { input, diffs: financialLensParityDiffs(command, input) };
}

function diffOf(diffs: readonly ParityDiff[], key: string) {
  return diffs.find((diff) => diff.key === key);
}

function classified(diffs: readonly ParityDiff[], valueClass: Waiver["class"]): readonly Waiver[] {
  const onlyCurrencyAndCitations = diffs.every(
    (diff) =>
      diff.key === "item.summary" ||
      diff.key.endsWith(".currency") ||
      diff.key.endsWith("sourceIds"),
  );
  return diffs.map((diff) => ({
    ...diff,
    fixture: "synthetic",
    class: diff.key.endsWith("sourceIds")
      ? ("D7" as const)
      : diff.key.endsWith(".currency")
        ? ("D6" as const)
        : diff.key === "item.summary"
          ? onlyCurrencyAndCitations
            ? ("D6" as const)
            : ("D5" as const)
          : /posture$/iu.test(diff.key) ||
              diff.key.endsWith(".order") ||
              diff.key.endsWith(".label") ||
              diff.key.endsWith(".unit")
            ? ("D5" as const)
            : valueClass,
  }));
}

const REVENUE: Record<string, unknown> = {
  Revenues: {
    units: {
      USD: [annualFact(100, "2025-01-01", "2025-12-31")],
    },
  },
};
const MISALIGNED_REVENUE: Record<string, unknown> = {
  Revenues: { units: { USD: [annualFact(100, "2024-10-01", "2025-10-31")] } },
  GrossProfit: {
    units: {
      USD: [annualFact(10, "2024-10-01", "2025-10-31"), annualFact(20, "2024-11-01", "2025-10-31")],
    },
  },
};
const MARGIN_OVER_OLD_PERIOD: Record<string, unknown> = {
  Revenues: { units: { USD: [annualFact(100, "2024-01-01", "2024-12-31")] } },
  GrossProfit: {
    units: {
      USD: [annualFact(30, "2024-01-01", "2024-12-31"), annualFact(35, "2025-01-01", "2025-12-31")],
    },
  },
};

const D7_ALIGNED_MARGIN: Record<string, unknown> = {
  Revenues: { units: { USD: [annualFact(100, "2025-01-01", "2025-12-31")] } },
  GrossProfit: { units: { USD: [annualFact(30, "2025-01-01", "2025-12-31")] } },
};

describe("waiver classes", () => {
  test("D1: a 13-month annual fact gives way to the year-aligned fact", () => {
    const { input, diffs } = synthetic(MISALIGNED_REVENUE);

    expect(diffOf(diffs, "lens.Quality.grossMargin")).toEqual({
      key: "lens.Quality.grossMargin",
      old: 0.1,
      new: undefined,
    });
    expectFinancialLensParity("synthetic", command, input, classified(diffs, "D1"));
  });

  test("D1 and D5: a misaligned input moves a margin and its posture", () => {
    const { input, diffs } = synthetic({
      ...MISALIGNED_REVENUE,
      OperatingIncomeLoss: { units: { USD: [annualFact(5, "2024-10-01", "2025-10-31")] } },
    });

    expect(diffOf(diffs, "lens.Quality.posture")).toEqual({
      key: "lens.Quality.posture",
      old: "criteria-supported",
      new: "insufficient-data",
    });
    expectFinancialLensParity("synthetic", command, input, classified(diffs, "D1"));
  });

  test("D2: no same-period denominator is missing, not an older common period", () => {
    const { input, diffs } = synthetic(MARGIN_OVER_OLD_PERIOD);

    expect(diffOf(diffs, "lens.Quality.grossMargin")).toEqual({
      key: "lens.Quality.grossMargin",
      old: 0.3,
      new: undefined,
    });
    expectFinancialLensParity("synthetic", command, input, classified(diffs, "D2"));
  });

  test("D4: a stale balance sheet is missing instead of a historical value", () => {
    const { input, diffs } = synthetic({
      ...REVENUE,
      CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instantFact(10, "2025-06-30")] } },
      LongTermDebt: { units: { USD: [instantFact(50, "2025-06-30")] } },
    });

    expect(diffOf(diffs, "lens.Financial Strength.netDebt")).toEqual({
      key: "lens.Financial Strength.netDebt",
      old: 40,
      new: undefined,
    });
    expectFinancialLensParity("synthetic", command, input, classified(diffs, "D4"));
  });

  test("D6: an amount carries its filed currency, not the quote currency", () => {
    const { input, diffs } = synthetic({
      Revenues: {
        units: { CAD: [annualFact(100, "2025-01-01", "2025-12-31")] },
      },
      CashAndCashEquivalentsAtCarryingValue: { units: { CAD: [instantFact(80, "2025-12-31")] } },
    });

    expect(diffOf(diffs, "lens.Financial Strength.cash.currency")).toEqual({
      key: "lens.Financial Strength.cash.currency",
      old: undefined,
      new: "CAD",
    });
    expectFinancialLensParity("synthetic", command, input, classified(diffs, "D6"));
    expect(
      waiverPreconditionHolds(
        command,
        input,
        {
          fixture: "synthetic",
          class: "D6",
          key: "lens.Financial Strength.cash.currency",
          old: undefined,
          new: "EUR",
        },
        [],
      ),
    ).toBe(false);
  });

  test("D8: debt/market cap does not require the legacy cash partner", () => {
    for (const cash of [undefined, instantFact(10, "2025-12-31")]) {
      const { input, diffs } = synthetic({
        ...REVENUE,
        LongTermDebt: { units: { USD: [instantFact(40, "2026-03-31")] } },
        ...(cash === undefined
          ? {}
          : {
              CashAndCashEquivalentsAtCarryingValue: { units: { USD: [cash] } },
            }),
      });
      expect(diffOf(diffs, "item.metrics.debtToMarketCap")).toEqual({
        key: "item.metrics.debtToMarketCap",
        old: undefined,
        new: 0.04,
      });
      expectFinancialLensParity("synthetic", command, input, classified(diffs, "D8"));
    }
  });

  test("D8 rejects a missing, stale or paired debt basis, missing quote, and forged ratio", () => {
    const waiver: Waiver = {
      fixture: "synthetic",
      class: "D8",
      key: "item.metrics.debtToMarketCap",
      old: undefined,
      new: 0.04,
    };
    const { input } = synthetic({
      ...REVENUE,
      LongTermDebt: { units: { USD: [instantFact(40, "2026-03-31")] } },
    });
    expect(waiverPreconditionHolds(command, input, waiver, [])).toBe(true);
    const { financialLenses: _artifact, ...withoutRebuiltArtifact } = input;
    expect(
      waiverPreconditionHolds(
        command,
        { ...withoutRebuiltArtifact, metricSections: [] },
        waiver,
        [],
      ),
    ).toBe(true);
    expect(waiverPreconditionHolds(command, input, { ...waiver, new: 0.5 }, [])).toBe(false);
    expect(waiverPreconditionHolds(command, { ...input, marketSnapshots: [] }, waiver, [])).toBe(
      false,
    );
    for (const concepts of [
      REVENUE,
      { ...REVENUE, LongTermDebt: { units: { USD: [instantFact(40, "2025-06-30")] } } },
      {
        Revenues: { units: { CAD: [annualFact(100, "2025-01-01", "2025-12-31")] } },
        LongTermDebt: { units: { CAD: [instantFact(40, "2026-03-31")] } },
      },
      {
        ...REVENUE,
        LongTermDebt: { units: { USD: [instantFact(40, "2026-03-31")] } },
        CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instantFact(10, "2026-03-31")] } },
      },
    ]) {
      expect(
        waiverPreconditionHolds(
          command,
          { ...input, financialStatements: statements(concepts) },
          waiver,
          [],
        ),
      ).toBe(false);
    }
  });

  test("D6 rejects a currency carried only by another period", () => {
    const { input } = synthetic({
      Revenues: { units: { CAD: [annualFact(100, "2025-01-01", "2025-12-31")] } },
      CashAndCashEquivalentsAtCarryingValue: {
        units: { CAD: [instantFact(70, "2025-12-31"), instantFact(80, "2026-03-31")] },
      },
    });
    const artifact = input.financialStatements!;
    const { cash } = artifact.statements.balanceSheet;
    const forged: ParityInput = {
      ...input,
      financialStatements: {
        ...artifact,
        statements: {
          ...artifact.statements,
          balanceSheet: {
            ...artifact.statements.balanceSheet,
            cash: {
              ...cash,
              interim: cash.interim.map((fact) =>
                fact.periodEnd === "2025-12-31" ? { ...fact, currency: "USD" } : fact,
              ),
            },
          },
        },
      },
    };
    expect(forged.financialStatements?.statements.balanceSheet.cash.interim).toContainEqual(
      expect.objectContaining({ periodEnd: "2025-12-31", currency: "USD" }),
    );
    expect(
      waiverPreconditionHolds(
        command,
        forged,
        {
          fixture: "synthetic",
          class: "D6",
          key: "lens.Financial Strength.cash.currency",
          old: undefined,
          new: "USD",
        },
        [],
      ),
    ).toBe(false);
  });

  test("D7: a citation list narrower than the frozen lens union, with no new ids", () => {
    const { input, diffs } = synthetic(D7_ALIGNED_MARGIN);
    const narrow = diffOf(diffs, "lens.Quality.grossMargin.sourceIds");

    expect(narrow).toEqual({
      key: "lens.Quality.grossMargin.sourceIds",
      old: ["extended-sec-edgar-aapl-filings", "extended-sec-edgar-aapl-fundamentals"],
      new: ["extended-sec-edgar-aapl-fundamentals"],
    });
    expectFinancialLensParity("synthetic", command, input, classified(diffs, "D2"));
    expect(
      waiverPreconditionHolds(
        command,
        input,
        {
          ...(narrow as ParityDiff),
          fixture: "synthetic",
          class: "D7",
          new: ["extended-sec-edgar-aapl-fundamentals", "invented-source"],
        },
        [],
      ),
    ).toBe(false);
    expect(
      waiverPreconditionHolds(
        command,
        input,
        {
          ...(narrow as ParityDiff),
          fixture: "synthetic",
          class: "D7",
          old: ["extended-sec-edgar-aapl-fundamentals"],
          new: ["extended-sec-edgar-aapl-fundamentals"],
        },
        [],
      ),
    ).toBe(true);
  });

  test("an unwaived difference or a waiver whose precondition fails is rejected", () => {
    const { input, diffs } = synthetic(MARGIN_OVER_OLD_PERIOD);

    expect(() => expectFinancialLensParity("synthetic", command, input, [])).toThrow();
    expect(() =>
      expectFinancialLensParity("synthetic", command, input, classified(diffs, "D1")),
    ).toThrow();
    expect(() =>
      expectFinancialLensParity("synthetic", command, input, classified(diffs, "D4")),
    ).toThrow();
  });

  test("a missing lens item, artifact or section fails instead of passing vacuously", () => {
    const { input } = synthetic(D7_ALIGNED_MARGIN);
    const { financialLenses: _artifact, ...noArtifact } = input;
    const { extendedEvidence: _evidence, ...noEvidence } = input;
    const { metricSections: _sections, ...noSections } = input;
    const item = input.extendedEvidence?.items.find((entry) => entry.category === "financial-lens");
    const withoutRow: ParityInput = {
      ...input,
      extendedEvidence: {
        ...(input.extendedEvidence as NonNullable<ParityInput["extendedEvidence"]>),
        items: [
          ...(input.extendedEvidence?.items ?? []).filter(
            (entry) => entry.category !== "financial-lens",
          ),
          {
            ...(item as NonNullable<typeof item>),
            metrics: Object.fromEntries(
              Object.entries(item?.metrics ?? {}).filter(([key]) => key !== "grossMargin"),
            ),
          },
        ],
      },
    };

    expect(() => financialLensParityDiffs(command, noArtifact)).toThrow();
    expect(() => financialLensParityDiffs(command, noEvidence)).toThrow();
    expect(() => financialLensParityDiffs(command, { ...input, metricSections: [] })).toThrow();
    expect(() => financialLensParityDiffs(command, noSections)).toThrow();
    expect(() =>
      financialLensParityDiffs(command, {
        ...input,
        metricSections: (input.metricSections ?? []).map((section) => ({
          ...section,
          metrics: [],
        })),
      }),
    ).toThrow();
    expect(() => financialLensParityDiffs(command, withoutRow)).toThrow();
  });

  test("a forged old value, rebuilt value or severed lineage is not trusted", () => {
    const { input, diffs } = synthetic(MARGIN_OVER_OLD_PERIOD);
    const waived = classified(diffs, "D2");
    const margin = {
      fixture: "synthetic",
      class: "D2",
      key: "lens.Quality.grossMargin",
      old: 0.3,
      new: undefined,
    } as const;

    expect(waiverPreconditionHolds(command, input, margin, [])).toBe(true);
    expect(waiverPreconditionHolds(command, input, margin, waived)).toBe(true);
    expect(waiverPreconditionHolds(command, input, { ...margin, old: 0.35 }, waived)).toBe(false);
    expect(waiverPreconditionHolds(command, input, { ...margin, new: 0.2 }, waived)).toBe(false);
  });

  test("a rebuilt value that diverges from the frozen rows is caught", () => {
    const { input, diffs } = synthetic(D7_ALIGNED_MARGIN);
    const waived = classified(diffs, "D2");

    expect(() =>
      expectFinancialLensParity(
        "synthetic",
        command,
        {
          ...input,
          financialLenses: {
            ...(input.financialLenses as NonNullable<ParityInput["financialLenses"]>),
            lenses: (input.financialLenses?.lenses ?? []).map((lens) => ({
              ...lens,
              metrics: lens.metrics.map((metric) =>
                metric.key === "grossMargin" ? { ...metric, value: 0.99 } : metric,
              ),
            })),
          },
        },
        waived,
      ),
    ).toThrow();
  });

  test("D5 covers only derived values the waived metrics reproduce", () => {
    const { input, diffs } = synthetic(MISALIGNED_REVENUE);
    const posture = diffOf(diffs, "lens.Quality.posture");
    const tampered: ParityInput = {
      ...input,
      financialLenses: {
        ...(input.financialLenses as NonNullable<ParityInput["financialLenses"]>),
        lenses: (input.financialLenses?.lenses ?? []).map((lens) =>
          lens.name === "Quality" ? { ...lens, posture: "criteria-not-supported" } : lens,
        ),
      },
    };
    const postureWaiver: Waiver = {
      ...(posture as ParityDiff),
      fixture: "synthetic",
      class: "D5",
    };

    expect(posture?.old).toBe("criteria-supported");
    expect(waiverPreconditionHolds(command, tampered, postureWaiver, [postureWaiver])).toBe(false);
    expect(() =>
      expectFinancialLensParity("synthetic", command, tampered, [postureWaiver]),
    ).toThrow();
  });
});

describe("Phase 7a review regressions", () => {
  test("D7 rejects removing the filed debt citation from both rebuilt projections", () => {
    const { input } = synthetic({
      ...REVENUE,
      LongTermDebt: { units: { USD: [instantFact(40, "2026-03-31")] } },
      CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instantFact(10, "2026-03-31")] } },
    });
    const tampered = {
      ...input,
      financialLenses: {
        ...input.financialLenses!,
        lenses: input.financialLenses!.lenses.map((lens) => ({
          ...lens,
          metrics: lens.metrics.map((row) =>
            row.key === "debtToMarketCap"
              ? { ...row, sourceIds: ["market-yahoo-equity-aapl"] }
              : row,
          ),
        })),
      },
      metricSections: (input.metricSections ?? []).map((section) => ({
        ...section,
        metrics: section.metrics.map((row) =>
          row.id === "debtToMarketCap" ? { ...row, sourceIds: ["market-yahoo-equity-aapl"] } : row,
        ),
      })),
    };
    expect(
      waiverPreconditionHolds(
        command,
        tampered,
        {
          fixture: "synthetic",
          class: "D7",
          key: "lens.Financial Strength.debtToMarketCap.sourceIds",
          old: ["market-yahoo-equity-aapl", "extended-sec-edgar-aapl-fundamentals"],
          new: ["market-yahoo-equity-aapl"],
        },
        [],
      ),
    ).toBe(false);
  });

  test("D4 cannot waive a stale margin or missing stale rows and Source Gaps", () => {
    const margin = synthetic(D7_ALIGNED_MARGIN, "2027-06-22T00:00:00.000Z");
    const waiver: Waiver = {
      fixture: "synthetic",
      class: "D4",
      key: "lens.Quality.grossMargin",
      old: 0.3,
      new: undefined,
    };
    expect(waiverPreconditionHolds(command, margin.input, waiver, [])).toBe(false);
    const { input, diffs } = synthetic({
      ...REVENUE,
      CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instantFact(10, "2025-06-30")] } },
      LongTermDebt: { units: { USD: [instantFact(50, "2025-06-30")] } },
    });
    const debtWaiver: Waiver = {
      fixture: "synthetic",
      class: "D4",
      key: "lens.Financial Strength.netDebt",
      old: 40,
      new: undefined,
    };
    expect(waiverPreconditionHolds(command, input, debtWaiver, [])).toBe(true);
    expect(waiverPreconditionHolds(command, { ...input, sourceGaps: [] }, debtWaiver, [])).toBe(
      false,
    );
    expect(() =>
      expectFinancialLensParity(
        "synthetic",
        command,
        {
          ...input,
          metricSections: (input.metricSections ?? []).map((section) => ({
            ...section,
            metrics: section.metrics.filter((row) => row.id !== "netDebt"),
          })),
        },
        classified(diffs, "D4"),
      ),
    ).toThrow();
  });

  test("market leverage withholds mismatched currencies and retains quote currency in lineage", () => {
    const { input } = synthetic({
      Revenues: { units: { CAD: [annualFact(100, "2025-01-01", "2025-12-31")] } },
      LongTermDebt: { units: { CAD: [instantFact(40, "2026-03-31")] } },
      CashAndCashEquivalentsAtCarryingValue: { units: { CAD: [instantFact(10, "2026-03-31")] } },
    });
    for (const id of ["debtToMarketCap", "netDebtToMarketCap"]) {
      const row = input.metricSections
        ?.flatMap((section) => section.metrics)
        .find((metric) => metric.id === id);
      expect(row).toMatchObject({ status: "missing", reason: expect.stringContaining("currency") });
      expect(row?.inputs.find((candidate) => candidate.artifact === "quote")?.currency).toBe("USD");
    }
    expect(
      input.sourceGaps?.find((gap) => gap.source === "financial-lens-financial-strength")?.message,
    ).toContain("currency");
  });

  test("market leverage permits unknown filed and quote currencies", () => {
    const artifact = statements({
      ...REVENUE,
      LongTermDebt: { units: { USD: [instantFact(40, "2026-03-31")] } },
      CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instantFact(10, "2026-03-31")] } },
    });
    const unknownCurrency = (key: "cash" | "debt") => ({
      ...artifact.statements.balanceSheet[key],
      interim: artifact.statements.balanceSheet[key].interim.map((fact) => ({
        ...fact,
        currency: null,
      })),
    });
    const unknownStatements = {
      ...artifact,
      statements: {
        ...artifact.statements,
        balanceSheet: {
          ...artifact.statements.balanceSheet,
          debt: unknownCurrency("debt"),
          cash: unknownCurrency("cash"),
        },
      },
    };
    const result = addFinancialLensEvidence(
      command,
      [],
      {
        ...evidence(),
        items: evidence().items.map((item) =>
          item.category === "valuation"
            ? { ...item, metrics: { ...item.metrics, marketCap: 1000 } }
            : item,
        ),
      },
      undefined,
      AS_OF,
      undefined,
      undefined,
      unknownStatements,
    );
    for (const [id, value] of [
      ["debtToMarketCap", 0.04],
      ["netDebtToMarketCap", 0.03],
    ] as const) {
      expect(
        result.metricSections?.flatMap((section) => section.metrics).find((row) => row.id === id),
      ).toMatchObject({ status: "value", value });
    }
  });

  test("missing partners preserve independently established not-filed causes", () => {
    const { input } = synthetic({
      ...D7_ALIGNED_MARGIN,
      OperatingIncomeLoss: { units: { USD: [annualFact(20, "2025-01-01", "2025-12-31")] } },
      NetIncomeLoss: { units: { USD: [annualFact(10, "2025-01-01", "2025-12-31")] } },
      NetCashProvidedByUsedInOperatingActivities: {
        units: { USD: [annualFact(30, "2025-01-01", "2025-12-31")] },
      },
      LongTermDebt: { units: { USD: [instantFact(40, "2025-12-31")] } },
      AssetsCurrent: { units: { USD: [instantFact(100, "2025-12-31")] } },
    });
    const rows = input.metricSections?.flatMap((section) => section.metrics) ?? [];
    for (const id of [
      "freeCashFlowProxy",
      "roe",
      "roa",
      "netDebt",
      "netDebtToMarketCap",
      "currentRatio",
      "debtToEquity",
    ]) {
      expect(rows.find((row) => row.id === id)).toMatchObject({
        status: "missing",
        cause: "not-filed",
      });
    }
    expect(input.sourceGaps?.find((gap) => gap.source === "financial-lens-quality")?.triage).toBe(
      "diagnostic",
    );
  });
});

test("newer incomplete debt withholds net debt and preserves its warning in statements parity", () => {
  const artifact = statements({
    ...REVENUE,
    LongTermDebtCurrent: { units: { USD: [instantFact(10, "2025-12-31")] } },
    LongTermDebtNoncurrent: {
      units: { USD: [instantFact(30, "2025-12-31"), instantFact(50, "2026-03-31")] },
    },
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instantFact(10, "2025-12-31")] } },
  });
  expect(artifact.omissionNotes).toContainEqual(
    expect.objectContaining({
      code: "incomplete-composite-series",
      seriesKey: "debt",
      periodKey: "instant|2026-03-31",
    }),
  );
  const snapshots = [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })];
  const before = addValuationEvidence(
    command,
    snapshots,
    withCanonicalFinancialLensInputs(
      { ...evidence(), items: evidence().items.filter((item) => item.category !== "valuation") },
      artifact,
    ),
    AS_OF,
  ).extendedEvidence;
  const result = addFinancialLensEvidence(
    command,
    snapshots,
    before,
    undefined,
    AS_OF,
    undefined,
    undefined,
    artifact,
  );
  const input: ParityInput = {
    marketSnapshots: snapshots,
    financialStatements: artifact,
    ...(result.extendedEvidence !== undefined ? { extendedEvidence: result.extendedEvidence } : {}),
    ...(result.artifact !== undefined ? { financialLenses: result.artifact } : {}),
    ...(result.metricSections !== undefined ? { metricSections: result.metricSections } : {}),
    sourceGaps: result.metricSectionGaps ?? [],
  };
  const rows = result.metricSections?.flatMap((section) => section.metrics);
  for (const id of ["netDebt", "netDebtToMarketCap"]) {
    expect(rows?.find((row) => row.id === id)).toMatchObject({
      status: "missing",
      reason: expect.stringContaining("incomplete"),
    });
  }
  expect(rows?.find((row) => row.id === "debt")?.label).toBe(
    "Debt as of 2025-12-31; incomplete as of 2026-03-31",
  );
  expectFinancialLensParity(
    "synthetic",
    command,
    input,
    classified(financialLensParityDiffs(command, input), "D2"),
  );
});

test("Phase 7a files keep comment blocks within the two-line budget", async () => {
  for (const path of [
    "src/sources/extended-evidence/financial-lens-sections.ts",
    "tests/support/financial-lens-parity.ts",
    "tests/financial-lens-parity.test.ts",
    "tests/financial-lens-pre-statements.test.ts",
  ]) {
    const source = await Bun.file(new URL(`../${path}`, import.meta.url)).text();
    expect(source.match(/(?:^[ \t]*\/\/[^\n]*\n){3,}/gm), path).toBeNull();
    expect(source, path).not.toMatch(/\/\*\*/u);
  }
});

test("statements preserve the gross-principal debt basis in artifact parity", () => {
  const artifact = statements({
    ...REVENUE,
    CashAndCashEquivalentsAtCarryingValue: { units: { USD: [instantFact(50, "2026-03-31")] } },
    LongTermDebt: { units: { USD: [instantFact(100, "2025-12-31")] } },
    DebtInstrumentCarryingAmount: {
      units: { USD: [instantFact(102, "2025-12-31"), instantFact(200, "2026-03-31")] },
    },
  });
  const snapshots = [marketSnapshot({ sourceId: "market-yahoo-equity-aapl", marketCap: 1000 })];
  const before = addValuationEvidence(
    command,
    snapshots,
    withCanonicalFinancialLensInputs(
      { ...evidence(), items: evidence().items.filter((item) => item.category !== "valuation") },
      artifact,
    ),
    AS_OF,
  ).extendedEvidence;
  const result = addFinancialLensEvidence(
    command,
    snapshots,
    before,
    undefined,
    AS_OF,
    undefined,
    undefined,
    artifact,
  );
  const input: ParityInput = {
    marketSnapshots: snapshots,
    financialStatements: artifact,
    ...(result.extendedEvidence !== undefined ? { extendedEvidence: result.extendedEvidence } : {}),
    ...(result.artifact !== undefined ? { financialLenses: result.artifact } : {}),
    ...(result.metricSections !== undefined ? { metricSections: result.metricSections } : {}),
    sourceGaps: result.metricSectionGaps ?? [],
  };
  expect(
    input.financialLenses?.lenses
      .find((lens) => lens.name === "Financial Strength")
      ?.metrics.find((row) => row.key === "debt")?.label,
  ).toBe("Debt (gross principal)");
  expectFinancialLensParity(
    "synthetic",
    command,
    input,
    classified(financialLensParityDiffs(command, input), "D2"),
  );
});
