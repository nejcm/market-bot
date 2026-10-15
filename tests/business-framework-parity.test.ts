import { afterAll, describe, expect, test } from "bun:test";
import { parseArgs, type InstrumentCommand } from "../src/cli/args";
import type { ExtendedEvidence } from "../src/domain/evidence";
import type { MarketSnapshot } from "../src/domain/market-data";
import { addBusinessFrameworkEvidence } from "../src/sources/extended-evidence/business-framework";
import { withCanonicalFinancialLensInputs } from "../src/sources/extended-evidence/financial-lens-canonical";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  businessFrameworkParityDiffs,
  expectBusinessFrameworkParity,
  waiverPreconditionHolds,
  type ParityDiff,
  type ParityInput,
  type Waiver,
} from "./support/business-framework-parity";
import { marketSnapshot } from "./support/fixtures";
import {
  EQUITY_RUN_FIXTURES,
  loadFixture,
  runFixture,
  type RunFixtureResult,
} from "./support/run-fixtures";

const WAIVERS: readonly Waiver[] = [
  {
    fixture: "equity-nbis-deep",
    key: "item.summary",
    old: "Business Framework: Business criteria-supported (Revenue $529.8M, Operating income $-611.7M); Phase classification (Phase hyper-growth, Revenue YoY 479.0%); Moat criteria-not-supported (Operating margin -115.5%); Growth criteria-mixed (Revenue YoY 479.0%, Operating income YoY -53.1%, Net income YoY (total operations) 112.9%); Management insufficient-data; Risk criteria-supported (Current ratio (historical, 2025-12-31) 3.08x); Valuation insufficient-data (Valuation caveat Revenue multiples are not a valid basis for this issuer; the peer set is size/sector-comparable only., Trailing PE 87.33x, Forward PE -139.64x).",
    new: "Business Framework: Business criteria-supported (Revenue $529.8M, Operating income $-611.7M); Phase classification (Phase hyper-growth, Revenue YoY 479.0%); Moat criteria-not-supported (Operating margin -115.5%); Growth criteria-mixed (Revenue YoY 479.0%, Operating income YoY -53.1%, Net income YoY (total operations) 112.9%); Management insufficient-data; Risk criteria-supported; Valuation insufficient-data (Valuation caveat Revenue multiples are not a valid basis for this issuer; the peer set is size/sector-comparable only., Trailing PE 87.33x, Forward PE -139.64x).",
    class: "D4",
  },
  {
    fixture: "equity-nbis-deep",
    key: "Risk.summary",
    old: "Risk criteria-supported (Current ratio (historical, 2025-12-31) 3.08x)",
    new: "Risk criteria-supported",
    class: "D4",
  },
  {
    fixture: "equity-nbis-deep",
    key: "Risk.currentRatio",
    old: 3.083_780_599_554_915_5,
    new: undefined,
    class: "D4",
  },
  {
    fixture: "equity-depository-deep",
    key: "item.summary",
    old: "Business Framework: Business insufficient-data (Revenue $9.6B); Phase classification (Phase capital-return, Revenue YoY 2.9%, Dividend yield 3.6%); Moat insufficient-data; Growth criteria-supported (Revenue YoY 2.9%, Net income YoY 131.5%); Management insufficient-data; Risk criteria-supported; Valuation insufficient-data (Trailing PE 17.60x, Forward PE 13.76x).",
    new: "Business Framework: Business insufficient-data (Revenue CAD 9.6B); Phase classification (Phase capital-return, Revenue YoY 2.9%, Dividend yield 3.6%); Moat insufficient-data; Growth criteria-supported (Revenue YoY 2.9%, Net income YoY 131.5%); Management insufficient-data; Risk criteria-supported; Valuation insufficient-data (Trailing PE 17.60x, Forward PE 13.76x).",
    class: "D6",
  },
  {
    fixture: "equity-depository-deep",
    key: "Business.summary",
    old: "Business insufficient-data (Revenue $9.6B)",
    new: "Business insufficient-data (Revenue CAD 9.6B)",
    class: "D6",
  },
  {
    fixture: "equity-depository-deep",
    key: "Business.revenue.currency",
    old: "USD",
    new: "CAD",
    class: "D6",
  },
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

describe("Business Framework accepted-difference gate", () => {
  for (const name of EQUITY_RUN_FIXTURES) {
    test(`${name} differs from the legacy builder only by waived classes`, async () => {
      const fixture = await loadFixture(name);
      const result = await runFixture(name, { llm: "replay" });
      results.push(result);
      expectBusinessFrameworkParity(
        name,
        instrumentCommand(fixture.meta.argv),
        result.collectedSources,
        WAIVERS,
      );
    });
  }
});

const AS_OF = "2026-06-22T00:00:00.000Z";
const command = instrumentCommand(["equity", "AAPL", "--deep"]);

function fact(val: number, start: string, end: string, form = "10-K") {
  const fy = Number(end.slice(0, 4));
  return { val, form, fp: form === "10-K" ? "FY" : "Q1", fy, filed: "2026-05-01", start, end };
}

function synthetic(concepts: Record<string, unknown>, lens: Record<string, number | string> = {}) {
  const statements = deriveStatements(concepts);
  const canonical = withCanonicalFinancialLensInputs(undefined, statements);
  return frameworkInput({ ...canonical, items: [...canonical.items, lensItem(lens)] }, statements);
}

function lensItem(metrics: Record<string, number | string>): ExtendedEvidence["items"][number] {
  return {
    category: "financial-lens",
    title: "AAPL Financial Lens Evidence",
    summary: "Financial Lens Evidence.",
    sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
    observedAt: AS_OF,
    metrics,
  };
}

function deriveStatements(concepts: Record<string, unknown>) {
  return deriveFinancialStatements(
    { facts: { "us-gaap": concepts } },
    {
      symbol: "AAPL",
      generatedAt: AS_OF,
      analysisAsOf: AS_OF,
      sourceId: "extended-sec-edgar-aapl-fundamentals",
    },
  );
}

function frameworkInput(
  evidence: ExtendedEvidence,
  statements: ReturnType<typeof deriveStatements> | undefined,
  marketSnapshots = [marketSnapshot({ sourceId: "market-aapl" })],
) {
  const result = addBusinessFrameworkEvidence(
    command,
    marketSnapshots,
    evidence,
    undefined,
    AS_OF,
    statements,
  );
  const input: ParityInput = {
    marketSnapshots,
    ...(statements !== undefined ? { financialStatements: statements } : {}),
    ...(result.extendedEvidence !== undefined ? { extendedEvidence: result.extendedEvidence } : {}),
    ...(result.artifact !== undefined ? { businessFramework: result.artifact } : {}),
    ...(result.metricSections !== undefined ? { metricSections: result.metricSections } : {}),
  };
  return { input, diffs: businessFrameworkParityDiffs(command, input) };
}

function diffOf(diffs: ReturnType<typeof synthetic>["diffs"], key: string) {
  return diffs.find((diff) => diff.key === key);
}

function waive(
  diffs: ReturnType<typeof synthetic>["diffs"],
  waiverClass: Waiver["class"],
): readonly Waiver[] {
  return diffs.map((diff) => ({ ...diff, fixture: "synthetic", class: waiverClass }));
}

describe("waiver classes", () => {
  test("D1: a 13-month annual fact gives way to the year-aligned fact ending the same day", () => {
    const { input, diffs } = synthetic({
      Revenues: {
        units: {
          USD: [fact(100, "2024-10-01", "2025-10-31"), fact(100, "2024-11-01", "2025-10-31")],
        },
      },
      GrossProfit: {
        units: {
          USD: [fact(10, "2024-10-01", "2025-10-31"), fact(20, "2024-11-01", "2025-10-31")],
        },
      },
    });

    expect(diffOf(diffs, "Moat.grossMargin")).toEqual({
      key: "Moat.grossMargin",
      old: 0.1,
      new: 0.2,
    });
    expectBusinessFrameworkParity("synthetic", command, input, waive(diffs, "D1"));
  });

  test("D2 and D5: no same-period denominator is missing, not an older common period", () => {
    const { input, diffs } = synthetic({
      Revenues: { units: { USD: [fact(100, "2024-01-01", "2024-12-31")] } },
      GrossProfit: {
        units: {
          USD: [fact(30, "2024-01-01", "2024-12-31"), fact(35, "2025-01-01", "2025-12-31")],
        },
      },
      OperatingIncomeLoss: {
        units: {
          USD: [fact(20, "2024-01-01", "2024-12-31"), fact(22, "2025-01-01", "2025-12-31")],
        },
      },
    });
    const posture = diffOf(diffs, "item.metrics.moatPosture");

    expect(diffOf(diffs, "Moat.grossMargin")).toEqual({
      key: "Moat.grossMargin",
      old: 0.3,
      new: undefined,
    });
    expect(posture).toEqual({
      key: "item.metrics.moatPosture",
      old: "criteria-mixed",
      new: "insufficient-data",
    });
    expectBusinessFrameworkParity(
      "synthetic",
      command,
      input,
      diffs.map((diff) => ({
        ...diff,
        fixture: "synthetic",
        class: /Posture$|posture$/u.test(diff.key) ? "D5" : "D2",
      })),
    );
  });

  test("D3: an interim latest-period anchor is no difference for framework metrics", () => {
    const { diffs } = synthetic({
      Revenues: {
        units: {
          USD: [
            fact(100, "2025-01-01", "2025-12-31"),
            fact(30, "2026-01-01", "2026-03-31", "10-Q"),
          ],
        },
      },
    });

    expect(diffOf(diffs, "Business.revenue")).toBeUndefined();
  });

  test("D4: a stale current ratio is missing instead of a historical label", () => {
    const { input, diffs } = synthetic(
      { Revenues: { units: { USD: [fact(100, "2025-01-01", "2025-12-31")] } } },
      { currentRatio: 1.5, currentRatioPeriodEnd: "2025-06-30" },
    );

    expect(diffOf(diffs, "Risk.currentRatio")).toEqual({
      key: "Risk.currentRatio",
      old: 1.5,
      new: undefined,
    });
    expectBusinessFrameworkParity("synthetic", command, input, waive(diffs, "D4"));
  });

  test("D6: an amount carries its filed currency, not the quote currency", () => {
    const { input, diffs } = synthetic({
      Revenues: {
        units: {
          CAD: [{ ...fact(100, "2025-01-01", "2025-12-31"), val: 9_600_000_000 }],
        },
      },
    });

    expect(diffOf(diffs, "Business.revenue.currency")).toEqual({
      key: "Business.revenue.currency",
      old: "USD",
      new: "CAD",
    });
    expectBusinessFrameworkParity("synthetic", command, input, waive(diffs, "D6"));
  });

  test("an unwaived difference or a waiver whose precondition fails is rejected", () => {
    const { input, diffs } = synthetic(
      { Revenues: { units: { USD: [fact(100, "2025-01-01", "2025-12-31")] } } },
      { currentRatio: 1.5, currentRatioPeriodEnd: "2025-06-30" },
    );

    expect(() => expectBusinessFrameworkParity("synthetic", command, input, [])).toThrow();
    expect(() =>
      expectBusinessFrameworkParity("synthetic", command, input, waive(diffs, "D2")),
    ).toThrow();
    expect(() =>
      expectBusinessFrameworkParity("synthetic", command, input, waive(diffs, "D3")),
    ).toThrow();
  });
});

const SEC_SUMMARY: ExtendedEvidence = {
  instrument: { symbol: "AAPL", assetClass: "equity" },
  items: [
    {
      category: "sec-edgar",
      title: "AAPL SEC Fundamental Evidence",
      summary: "SEC Fundamental Evidence.",
      sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
      observedAt: AS_OF,
      metrics: {
        revenue: 100,
        revenueDeltaPercent: 6,
        grossProfit: 45,
        operatingIncome: 24,
        operatingIncomeDeltaPercent: 8,
        netIncome: 18,
        netIncomeDeltaPercent: 5,
        shareRepurchases: 10,
      },
    },
    lensItem({ debtToMarketCap: 0.1 }),
  ],
  gaps: [],
};

function waiver(diff: ParityDiff, cls: Waiver["class"]): Waiver {
  return { ...diff, fixture: "synthetic", class: cls };
}

function tamperedFramework(
  input: ParityInput,
  name: string,
  patch: Partial<NonNullable<ParityInput["businessFramework"]>["sections"][number]>,
): ParityInput {
  const framework = input.businessFramework!;
  return {
    ...input,
    businessFramework: {
      ...framework,
      sections: framework.sections.map((section) =>
        section.name === name ? { ...section, ...patch } : section,
      ),
    },
  };
}

const D2_CONCEPTS = {
  Revenues: { units: { USD: [fact(100, "2024-01-01", "2024-12-31")] } },
  GrossProfit: {
    units: { USD: [fact(30, "2024-01-01", "2024-12-31"), fact(35, "2025-01-01", "2025-12-31")] },
  },
};

describe("accepted-difference gate rejections", () => {
  test("SEC summary evidence without statements keeps every legacy value and classification", () => {
    const { input, diffs } = frameworkInput(SEC_SUMMARY, undefined);

    expect(diffs).toEqual([]);
    expect(input.businessFramework?.phase).toBe("capital-return");
  });

  test("SEC-only amounts move from a non-USD quote currency to the summary's USD only as D6", () => {
    const eurQuote = [
      marketSnapshot({
        sourceId: "market-aapl",
        identity: { quoteCurrency: "EUR" } as NonNullable<MarketSnapshot["identity"]>,
      }),
    ];
    const { input, diffs } = frameworkInput(SEC_SUMMARY, undefined, eurQuote);

    expect(diffOf(diffs, "Business.revenue.currency")).toEqual({
      key: "Business.revenue.currency",
      old: "EUR",
      new: "USD",
    });
    expect(diffs.some(({ key }) => key === "Business.revenue")).toBe(false);
    expectBusinessFrameworkParity("synthetic", command, input, waive(diffs, "D6"));
    expect(
      waiverPreconditionHolds(
        command,
        input,
        waiver({ key: "Business.revenue.currency", old: "EUR", new: "EUR" }, "D6"),
        [],
      ),
    ).toBe(false);
  });

  test("D1: YoY against a misaligned prior becomes missing and needs re-derivation", () => {
    const revenue = (prior: string) =>
      synthetic({
        Revenues: {
          units: {
            USD: [fact(90, prior, "2024-12-31"), fact(100, "2025-01-15", "2025-12-31")],
          },
        },
      });
    const { input, diffs } = revenue("2024-01-26");
    const classified = diffs.map((diff) => ({
      ...diff,
      fixture: "synthetic",
      class: diff.key.endsWith("osture") ? ("D5" as const) : ("D1" as const),
    }));

    expect(diffOf(diffs, "Growth.revenueDeltaPercent")?.new).toBeUndefined();
    expect(diffOf(diffs, "Growth.revenueDeltaPercent")?.old).toBeCloseTo((10 / 90) * 100);
    expectBusinessFrameworkParity("synthetic", command, input, classified);
    expect(
      waiverPreconditionHolds(
        command,
        input,
        waiver({ key: "Growth.revenueDeltaPercent", old: (10 / 90) * 100, new: 5 }, "D1"),
        classified,
      ),
    ).toBe(false);
    expect(revenue("2024-01-16").diffs).toEqual([]);
  });

  test("a missing framework or missing evidence fails instead of passing vacuously", () => {
    const { input } = synthetic(D2_CONCEPTS);
    const { businessFramework: _framework, ...noFramework } = input;
    const { extendedEvidence: _evidence, ...noEvidence } = input;

    expect(() => businessFrameworkParityDiffs(command, noFramework)).toThrow();
    expect(() => businessFrameworkParityDiffs(command, noEvidence)).toThrow();
    expect(() => businessFrameworkParityDiffs(command, { ...input, metricSections: [] })).toThrow();
  });

  test("D1 needs the misaligned fact that produced the old value", () => {
    const { input, diffs } = synthetic({
      ...D2_CONCEPTS,
      Revenues: {
        units: {
          USD: [fact(100, "2024-01-01", "2024-12-31"), fact(999, "2022-12-01", "2023-12-31")],
        },
      },
    });

    expect(() =>
      expectBusinessFrameworkParity("synthetic", command, input, waive(diffs, "D1")),
    ).toThrow();
    expect(() =>
      expectBusinessFrameworkParity(
        "synthetic",
        command,
        input,
        diffs.map((diff) => ({
          ...diff,
          fixture: "synthetic",
          class: diff.key.endsWith("osture") ? "D5" : "D2",
        })),
      ),
    ).not.toThrow();
  });

  test("a forged old value, rebuilt reason or snapshot currency is not trusted", () => {
    const { input } = synthetic(D2_CONCEPTS);
    const margin = { key: "Moat.grossMargin", old: 0.3, new: undefined };
    const rows = input.metricSections!.map((section) => ({
      ...section,
      metrics: section.metrics.map((metric) => ({ ...metric, reason: "stale current ratio" })),
    }));

    expect(waiverPreconditionHolds(command, input, waiver(margin, "D2"), [])).toBe(true);
    expect(
      waiverPreconditionHolds(command, input, waiver({ ...margin, old: 0.35 }, "D2"), []),
    ).toBe(false);
    expect(
      waiverPreconditionHolds(
        command,
        { ...input, metricSections: rows },
        waiver(margin, "D4"),
        [],
      ),
    ).toBe(false);
    expect(
      waiverPreconditionHolds(
        command,
        {
          ...input,
          marketSnapshots: [marketSnapshot({ symbol: "MSFT", sourceId: "market-msft" })],
        },
        waiver({ key: "Business.revenue.currency", old: "EUR", new: "USD" }, "D6"),
        [],
      ),
    ).toBe(false);
  });

  test("D5 covers only postures the waived metrics reproduce", () => {
    const { input, diffs } = synthetic(D2_CONCEPTS);
    const tampered = tamperedFramework(input, "Growth", { posture: "criteria-supported" });
    const waivers = businessFrameworkParityDiffs(command, tampered).map(
      (diff): Waiver => ({
        ...diff,
        fixture: "synthetic",
        class: diff.key.endsWith("osture") ? "D5" : "D2",
      }),
    );

    expect(waivers.length).toBe(diffs.length + 1);
    expect(() => expectBusinessFrameworkParity("synthetic", command, tampered, waivers)).toThrow();
  });

  test("D6 rejects a changed amount or a summary rewrite beyond the currency label", () => {
    const { input } = synthetic({
      Revenues: {
        units: { CAD: [{ ...fact(100, "2025-01-01", "2025-12-31"), val: 9_600_000_000 }] },
      },
    });
    const rewritten = tamperedFramework(input, "Business", {
      summary: "Business insufficient-data (Revenue CAD 9.6B, steady)",
    });
    const doubled: ParityInput = {
      ...input,
      metricSections: input.metricSections!.map((section) => ({
        ...section,
        metrics: section.metrics.map((metric) =>
          metric.id === "revenue" && metric.status === "value"
            ? { ...metric, value: 19_200_000_000 }
            : metric,
        ),
      })),
    };

    for (const tampered of [rewritten, doubled]) {
      expect(() =>
        expectBusinessFrameworkParity(
          "synthetic",
          command,
          tampered,
          waive(businessFrameworkParityDiffs(command, tampered), "D6"),
        ),
      ).toThrow();
    }
  });

  test("a divergent rebuilt classification is caught", () => {
    const { input } = synthetic(D2_CONCEPTS);
    const evidence = input.extendedEvidence!;
    const divergent: ParityInput = {
      ...input,
      extendedEvidence: {
        ...evidence,
        items: evidence.items.map((item) =>
          item.category === "business-framework"
            ? { ...item, metrics: { ...item.metrics, phase: "startup" } }
            : item,
        ),
      },
    };
    const diffs = businessFrameworkParityDiffs(command, divergent);

    expect(diffs.find(({ key }) => key === "item.metrics.phase")?.new).toBe("startup");
    expect(() =>
      expectBusinessFrameworkParity(
        "synthetic",
        command,
        divergent,
        diffs.map((diff) => ({ ...diff, fixture: "synthetic", class: "D5" })),
      ),
    ).toThrow();
  });
});
