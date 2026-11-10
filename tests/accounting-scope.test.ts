import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { RunDetail } from "../app/types";
import type { RunSummary } from "../src/run-artifact-index-types";
import { buildRunWorkspaceView, valuationWorkbenchView } from "../app/client/run-workspace-view";
import {
  financialTrendFromProjection,
  fundamentalHistoryView,
} from "../app/client/run-workspace-financials";
import { composeEquitySnapshot } from "../app/client/run-workspace-snapshot";
import type { MarketSnapshot } from "../src/domain/market-data";
import { earningsBasis } from "../src/report/equity-reader-earnings-basis";
import { projectEquityReader } from "../src/report/equity-reader";
import { financialTrends } from "../src/report/equity-reader-trends";
import {
  renderProjectedFinancialTrends,
  renderValuationContext,
} from "../src/report/markdown-equity-sections";
import { renderValuationWorkbenchMarkdown } from "../src/report/valuation-workbench-markdown";
import { summaryLens } from "./support/financial-lens";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import {
  cashConversionScopeGaps,
  withCanonicalFinancialLensInputs,
} from "../src/sources/extended-evidence/financial-lens-canonical";
import {
  CAPEX_SCOPE_CAVEAT,
  conceptScope,
} from "../src/sources/extended-evidence/financial-statement-definitions";
import { financialStatementFacts } from "../src/sources/extended-evidence/financial-statement-selection";
import {
  deriveFinancialStatements,
  financialStatementsHistoryGaps,
} from "../src/sources/extended-evidence/financial-statements";
import {
  readFinancialStatementsArtifact,
  type FinancialStatementsArtifact,
} from "../src/sources/extended-evidence/financial-statements-contract";
import { deriveFundamentalHistoryFromFinancialStatements } from "../src/sources/extended-evidence/fundamental-history-canonical";
import { buildEvidencePayload } from "../src/research/prompts/evidence-payload";
import { config, contextWithHistory } from "./support/research-context-helpers";
import type { ResearchCommand } from "../src/cli/args";
import {
  CAPEX_CALC_PREFIX,
  secContinuingInvestingCalcMetrics,
} from "../src/sources/sec-calculation-linkbase";
import type { ExtendedEvidenceItem } from "../src/domain/evidence";
import { summarizeSecFundamentals } from "../src/sources/extended-evidence/sec-edgar";
import { operatingRatioNotes } from "../src/report/equity-reader-statements";
import { buildValuationWorkbench } from "../src/sources/extended-evidence/valuation-workbench";
import { valuationPeriodInputs } from "../src/sources/extended-evidence/valuation-workbench-inputs";
import { operatingRatiosSection } from "../src/sources/extended-evidence/operating-ratios";
import { debtScopeUnproven } from "../src/sources/extended-evidence/sec-debt";
import { collectedSources, marketSnapshot, researchReport } from "./support/fixtures";
import { assertFinancialLensPeriodHygiene } from "../src/corpus/financial-invariants";

const AS_OF = "2026-10-07T00:00:00.000Z";
const CONTINUING_OCF = "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations";
const TOTAL_OCF = "NetCashProvidedByUsedInOperatingActivities";
const CONTINUING_NCI =
  "IncomeLossFromContinuingOperationsIncludingPortionAttributableToNoncontrollingInterest";
const CONTINUING_PARENT = "IncomeLossFromContinuingOperations";
const CONTINUING_EPS = "IncomeLossFromContinuingOperationsPerDilutedShare";
const CONTINUING_INVESTING = "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations";
const TOTAL_INVESTING = "NetCashProvidedByUsedInInvestingActivities";
const DISCONTINUED_INVESTING = "CashProvidedByUsedInInvestingActivitiesDiscontinuedOperations";
const CAPEX = "PaymentsToAcquirePropertyPlantAndEquipment";

type Row = Record<string, unknown>;
type Concepts = Record<string, readonly Row[]>;

function row(val: number, start: string, end: string, fp: string, filed: string): Row {
  return { val, start, end, form: fp === "FY" ? "10-K" : "10-Q", fy: 2026, fp, filed, accn: filed };
}

const fy25 = (val: number): Row => row(val, "2024-10-01", "2025-09-30", "FY", "2025-11-25");
const ytdPrior = (val: number): Row => row(val, "2024-10-01", "2025-06-30", "Q3", "2026-08-06");
const ytd = (val: number): Row => row(val, "2025-10-01", "2026-06-30", "Q3", "2026-08-06");

// CLFD shape: continuing-operations OCF, income, and EPS beside total net income and EPS.
function clfd(): Concepts {
  return {
    RevenueFromContractWithCustomerExcludingAssessedTax: [
      fy25(150_134_000),
      ytdPrior(109_074_000),
      ytd(112_596_000),
    ],
    NetIncomeLoss: [fy25(-8_050_000), ytdPrior(1_028_000), ytd(1_858_000)],
    EarningsPerShareDiluted: [fy25(-0.58), ytdPrior(0.07), ytd(0.14)],
    [CONTINUING_NCI]: [fy25(6_310_000), ytdPrior(4_522_000), ytd(2_195_000)],
    [CONTINUING_EPS]: [fy25(0.45), ytdPrior(0.32), ytd(0.16)],
    [CONTINUING_OCF]: [fy25(26_553_000), ytdPrior(22_423_000), ytd(7_345_000)],
  };
}

function payload(concepts: Concepts, units: Readonly<Record<string, string>> = {}): unknown {
  return {
    facts: {
      "us-gaap": Object.fromEntries(
        Object.entries(concepts).map(([concept, rows]) => [
          concept,
          {
            units: {
              [units[concept] ??
              (/PerShare|PerDilutedShare/u.test(concept) ? "USD/shares" : "USD")]: rows,
            },
          },
        ]),
      ),
    },
  };
}

// A fetched 10-K whose calculation linkbase subtracts `concept` inside continuing investing cash flow.
function capexCalc(accessionNumber: string, weight = -1, concept = CAPEX): ExtendedEvidenceItem {
  return {
    category: "sec-edgar",
    title: "10-K",
    summary: "",
    sourceIds: ["sec-filing"],
    observedAt: AS_OF,
    metrics: { accessionNumber, [`${CAPEX_CALC_PREFIX}${concept}`]: weight },
  };
}

function statements(
  concepts: Concepts,
  units?: Readonly<Record<string, string>>,
  secFilings?: readonly ExtendedEvidenceItem[],
) {
  return deriveFinancialStatements(payload(concepts, units), {
    ...(secFilings === undefined ? {} : { secFilings }),
    symbol: "CLFD",
    generatedAt: AS_OF,
    analysisAsOf: AS_OF,
    sourceId: "sec-clfd",
  });
}

function secItem(artifact: FinancialStatementsArtifact) {
  return withCanonicalFinancialLensInputs(undefined, artifact).items[0]!;
}

function legacyMetric(concepts: Concepts, key: string) {
  const summary = summarizeSecFundamentals(payload(concepts), AS_OF)!;
  const item = {
    category: "sec-edgar" as const,
    title: "SEC Fundamental Evidence",
    summary: summary.summary,
    sourceIds: ["sec-clfd"],
    observedAt: AS_OF,
    metrics: summary.metrics,
  };
  return summaryLens(item, "Quality", AS_OF).metrics.find((metric) => metric.key === key);
}

function lensMetric(artifact: FinancialStatementsArtifact, key: string) {
  const item = secItem(artifact);
  return [
    ...summaryLens(item, "Quality", undefined, artifact).metrics,
    ...summaryLens(item, "Growth", undefined, artifact).metrics,
  ].find((metric) => metric.key === key);
}

function yahoo(eps: number | null = 0.54, quoteCurrency: string | null = "USD"): MarketSnapshot {
  return marketSnapshot({
    sourceId: "market-yahoo-equity-clfd",
    symbol: "CLFD",
    ...(quoteCurrency === null
      ? {}
      : { identity: { quoteCurrency } as NonNullable<MarketSnapshot["identity"]> }),
    fundamentals: eps === null ? {} : { epsTrailingTwelveMonths: eps },
  });
}

describe("accounting scope", () => {
  test("labels continuing concepts with operations and attribution scope", () => {
    expect(conceptScope(CONTINUING_NCI)).toBe("continuing operations, including NCI");
    expect(conceptScope(CONTINUING_PARENT)).toBe("continuing operations, attributable to parent");
    expect(conceptScope(CONTINUING_EPS)).toBe("continuing operations");
    expect(conceptScope(CONTINUING_OCF)).toBe("continuing operations");
    expect(conceptScope("NetIncomeLoss")).toBeUndefined();
  });

  test("divides continuing OCF by continuing income and keeps both scopes in growth", () => {
    const artifact = statements(clfd());
    const metrics = secItem(artifact).metrics!;
    const labels = summaryLens(secItem(artifact), "Growth", undefined, artifact).metrics.map(
      (metric) => metric.label,
    );

    expect(lensMetric(artifact, "cashConversion")?.value).toBeCloseTo(7_345_000 / 2_195_000, 6);
    expect(artifact.statements.cashFlowStatement.operatingCashFlow.interim[0]?.concept).toBe(
      CONTINUING_OCF,
    );
    expect(metrics).toMatchObject({
      continuingIncome: 2_195_000,
      continuingIncomePrior: 4_522_000,
      continuingIncomeScope: "continuing operations, including NCI",
      netIncome: 1_858_000,
      netIncomeScope: "total operations",
      dilutedEpsScope: "total operations",
      continuingDilutedEps: 0.16,
    });
    expect(metrics.continuingIncomeDeltaPercent).toBeCloseTo(-51.46, 2);
    expect(labels).toEqual([
      "Revenue YoY",
      "Net income (attrib.) YoY (total operations)",
      "Diluted EPS YoY (total operations)",
      "Income YoY (continuing operations, including NCI)",
      "Diluted EPS YoY (continuing operations)",
      "Operating cash flow YoY (continuing operations)",
    ]);
    expect(cashConversionScopeGaps(artifact)).toEqual([]);
  });

  test("keeps ROE on total parent income", () => {
    const concepts = {
      ...clfd(),
      StockholdersEquity: [
        {
          val: 245_920_000,
          end: "2026-06-30",
          form: "10-Q",
          fy: 2026,
          fp: "Q3",
          filed: "2026-08-06",
        },
      ],
    };
    const artifact = statements(concepts);

    expect(lensMetric(artifact, "roe")?.value).toBeCloseTo((1_858_000 * (12 / 9)) / 245_920_000, 8);
  });

  test("states continuing income in the SEC fundamentals summary", () => {
    const summary = summarizeSecFundamentals(payload(clfd()), AS_OF)!;

    expect(summary.summary).toContain(
      "net income attributable to parent (total operations) 1858000 (80.7% YoY)",
    );
    expect(summary.summary).toContain(
      "income (continuing operations, including NCI) 2195000 (-51.5% YoY)",
    );
    expect(summary.summary).toContain("diluted EPS (continuing operations) 0.16 (-50.0% YoY)");
  });

  test("leaves a total-operations issuer unscoped", () => {
    const concepts = clfd();
    const {
      [CONTINUING_NCI]: _income,
      [CONTINUING_EPS]: _eps,
      [CONTINUING_OCF]: ocf,
      ...rest
    } = concepts;
    const artifact = statements({ ...rest, [TOTAL_OCF]: ocf! });
    const metrics = secItem(artifact).metrics!;

    expect(lensMetric(artifact, "cashConversion")?.value).toBeCloseTo(7_345_000 / 1_858_000, 6);
    expect(metrics.continuingIncome).toBeUndefined();
    expect(metrics.netIncomeScope).toBeUndefined();
    expect(lensMetric(artifact, "netIncomeDeltaPercent")?.label).toBe("Net income (attrib.) YoY");
    expect(lensMetric(artifact, "continuingIncomeDeltaPercent")).toBeUndefined();
    expect(cashConversionScopeGaps(artifact)).toEqual([]);
  });

  test("withholds cash conversion and declares a gap when continuing income is missing", () => {
    const { [CONTINUING_NCI]: _income, ...concepts } = clfd();
    const artifact = statements(concepts);

    expect(lensMetric(artifact, "cashConversion")).toBeUndefined();
    expect(cashConversionScopeGaps(artifact).map((gap) => gap.message)).toEqual([
      "SEC cash conversion withheld: operating cash flow is reported for continuing operations, and no income from continuing operations shares its period, currency, and unit",
    ]);
  });

  test("withholds cash conversion when continuing income shares no period or unit", () => {
    const quarterOnly = statements({
      ...clfd(),
      [CONTINUING_NCI]: [row(3_000_000, "2026-04-01", "2026-06-30", "Q3", "2026-08-06")],
    });
    const otherCurrency = statements(clfd(), { [CONTINUING_NCI]: "EUR" });

    for (const artifact of [quarterOnly, otherCurrency]) {
      expect(lensMetric(artifact, "cashConversion")).toBeUndefined();
      expect(cashConversionScopeGaps(artifact)).toHaveLength(1);
    }
  });

  test("withholds a zero-denominator ratio without a scope gap", () => {
    const artifact = statements({ ...clfd(), [CONTINUING_NCI]: [fy25(1), ytdPrior(1), ytd(0)] });

    expect(lensMetric(artifact, "cashConversion")).toBeUndefined();
    expect(cashConversionScopeGaps(artifact)).toEqual([]);
  });

  test("keeps scopes apart even when continuing and total values are equal", () => {
    const artifact = statements({
      ...clfd(),
      [CONTINUING_NCI]: [fy25(-8_050_000), ytdPrior(1_028_000), ytd(1_858_000)],
    });
    const metrics = secItem(artifact).metrics!;

    expect(metrics.continuingIncome).toBe(metrics.netIncome);
    expect(metrics.netIncomeScope).toBe("total operations");
    expect(metrics.continuingIncomeScope).toBe("continuing operations, including NCI");
  });

  test("omits the comparative but keeps the value when no prior is tagged", () => {
    const metrics = secItem(statements({ ...clfd(), [CONTINUING_NCI]: [ytd(2_195_000)] })).metrics!;

    expect(metrics.continuingIncome).toBe(2_195_000);
    expect(metrics.continuingIncomePrior).toBeUndefined();
    expect(metrics.continuingIncomeDeltaPercent).toBeUndefined();
  });

  test("treats a continuing series older than total income as history, not a scope split", () => {
    const artifact = statements({ ...clfd(), [CONTINUING_NCI]: [fy25(6_310_000)] });
    const metrics = secItem(artifact).metrics!;

    expect(metrics.continuingIncome).toBeUndefined();
    expect(metrics.netIncomeScope).toBeUndefined();
  });

  test("prefers parent-attributable continuing income on an equal period", () => {
    const parent = statements({
      ...clfd(),
      [CONTINUING_PARENT]: [fy25(6_000_000), ytdPrior(4_400_000), ytd(2_100_000)],
    });

    expect(secItem(parent).metrics).toMatchObject({
      continuingIncome: 2_100_000,
      continuingIncomeScope: "continuing operations, attributable to parent",
    });
  });

  test("never splices continuing-income concepts inside one TTM", () => {
    const artifact = statements({ ...clfd(), [CONTINUING_PARENT]: [fy25(6_000_000)] });
    const series = artifact.statements.incomeStatement.continuingIncome;

    expect(new Set(financialStatementFacts(series).map((fact) => fact.concept))).toEqual(
      new Set([CONTINUING_NCI]),
    );
    expect(Object.values(series.ttm!.components).map((fact) => fact.concept)).toEqual([
      CONTINUING_NCI,
      CONTINUING_NCI,
      CONTINUING_NCI,
    ]);
    expect(series.ttm?.value).toBe(6_310_000 + 2_195_000 - 4_522_000);
  });

  test("reads consolidated net income beside parent net income on the same period", () => {
    const artifact = statements({
      ...clfd(),
      ProfitLoss: [fy25(-7_900_000), ytdPrior(1_100_000), ytd(1_950_000)],
    });

    expect(secItem(artifact).metrics).toMatchObject({
      netIncome: 1_858_000,
      consolidatedNetIncome: 1_950_000,
      consolidatedNetIncomePeriodEnd: "2026-06-30",
      consolidatedNetIncomePeriodMonths: 9,
      consolidatedNetIncomePrior: 1_100_000,
    });
    expect(lensMetric(artifact, "consolidatedNetIncome")).toMatchObject({
      value: 1_950_000,
      periodEnd: "2026-06-30",
      periodMonths: 9,
    });
    const lenses = addFinancialLensEvidence(
      { jobType: "equity", assetClass: "equity", symbol: "CLFD", depth: "deep" },
      [],
      withCanonicalFinancialLensInputs(undefined, artifact),
      undefined,
      AS_OF,
    ).artifact!;
    expect(() => assertFinancialLensPeriodHygiene(artifact, lenses)).not.toThrow();
  });

  test("withholds consolidated net income off net income's period or equal to it", () => {
    const stale = statements({ ...clfd(), ProfitLoss: [fy25(-7_900_000)] });
    const equal = statements({
      ...clfd(),
      ProfitLoss: [fy25(-8_050_000), ytdPrior(1_028_000), ytd(1_858_000)],
    });

    expect(secItem(stale).metrics?.consolidatedNetIncome).toBeUndefined();
    expect(lensMetric(stale, "consolidatedNetIncome")).toBeUndefined();
    expect(secItem(statements(clfd())).metrics?.consolidatedNetIncome).toBeUndefined();
    expect(secItem(equal).metrics?.consolidatedNetIncome).toBe(1_858_000);
    expect(lensMetric(equal, "consolidatedNetIncome")).toBeUndefined();
  });

  test("backfills consolidated net income as empty on artifacts written before it", () => {
    const artifact = statements(clfd());
    const { consolidatedNetIncome: _consolidated, ...incomeStatement } =
      artifact.statements.incomeStatement;
    const older = readFinancialStatementsArtifact({
      ...artifact,
      statements: { ...artifact.statements, incomeStatement },
    });

    expect(older?.statements.incomeStatement.consolidatedNetIncome).toEqual({
      key: "consolidatedNetIncome",
      label: "Net income including noncontrolling interest",
      statement: "incomeStatement",
      annual: [],
      interim: [],
    });
  });

  test("reads the continuing series back and backfills artifacts written before them", () => {
    const artifact = statements(clfd());
    const roundTrip = readFinancialStatementsArtifact(structuredClone(artifact));
    const { continuingIncome: _income, ...incomeStatement } = artifact.statements.incomeStatement;
    const { continuingDilutedEps: _eps, ...perShare } = artifact.statements.perShare;
    const older = readFinancialStatementsArtifact({
      ...artifact,
      statements: { ...artifact.statements, incomeStatement, perShare },
    });

    expect(roundTrip?.statements.perShare.continuingDilutedEps.ttm?.value).toBeCloseTo(0.29, 10);
    expect(older?.statements.incomeStatement.continuingIncome).toEqual({
      key: "continuingIncome",
      label: "Income from continuing operations",
      statement: "incomeStatement",
      annual: [],
      interim: [],
    });
    expect(older?.statements.perShare.continuingDilutedEps.annual).toEqual([]);
  });

  test("labels total-operations earnings in valuation inputs and both disclosures", () => {
    const artifact = statements(clfd());
    const { ttm } = valuationPeriodInputs(artifact);
    const workbench = buildValuationWorkbench({
      generatedAt: AS_OF,
      symbol: "CLFD",
      financialStatements: artifact,
      priceHistory: [],
      quoteCurrency: "USD",
    });
    const markdown = renderValuationWorkbenchMarkdown(workbench, researchReport());
    const console = valuationWorkbenchView({
      summary: {} as RunSummary,
      valuationWorkbench: workbench,
    })?.scopeDisclosure;

    expect(ttm?.netIncome?.label).toBe("Net income (total operations)");
    expect(ttm?.dilutedEps).toMatchObject({
      label: "Diluted EPS (total operations)",
      scope: "total operations",
    });
    expect(console).toContain("P/E uses diluted EPS (total operations)");
    expect(markdown).toContain(`- ${console!}.`);
  });

  test("withholds cash conversion and declares a gap when total income shares no period", () => {
    const {
      [CONTINUING_NCI]: _income,
      [CONTINUING_EPS]: _eps,
      [CONTINUING_OCF]: ocf,
      NetIncomeLoss: _netIncome,
      ...rest
    } = clfd();
    const artifact = statements({
      ...rest,
      [TOTAL_OCF]: ocf!,
      NetIncomeLoss: [row(3_000_000, "2026-04-01", "2026-06-30", "Q3", "2026-08-06")],
    });

    expect(lensMetric(artifact, "cashConversion")).toBeUndefined();
    expect(cashConversionScopeGaps(artifact).map((gap) => gap.message)).toEqual([
      "SEC cash conversion withheld: no net income shares the operating cash flow period, currency, and unit",
    ]);
  });

  test("scopes history earnings by their own continuing counterpart, not by cash flow", () => {
    const { [CONTINUING_OCF]: ocf, ...rest } = clfd();
    const concepts = { ...rest, [TOTAL_OCF]: ocf! };
    const canonical = deriveFundamentalHistoryFromFinancialStatements(statements(concepts));
    const trends = financialTrends(canonical, false)!;
    const cards = fundamentalHistoryView({
      summary: {} as RunSummary,
      fundamentalHistory: canonical,
    })!;
    const snapshot = composeEquitySnapshot({
      fundamentalHistory: cards,
      financialLensGroups: [],
      cases: [],
    });

    expect(canonical.series.netIncome).toMatchObject({
      label: "Net income (total operations)",
      scope: "total operations",
    });
    expect(canonical.series.dilutedEps.label).toBe("Diluted EPS (total operations)");
    expect(trends.freeCashFlowScope).toBeUndefined();
    expect(financialTrendFromProjection(trends)?.columns[2]).toBe("Net income (total operations)");
    expect(cards.cards.find((card) => card.key === "dilutedEps")?.label).toBe(
      "Diluted EPS (total operations)",
    );
    expect(snapshot.keyDatedMetrics.metrics.map((metric) => metric.label)).toContain(
      "TTM diluted EPS (total operations)",
    );
  });

  test("leaves history earnings unscoped when the continuing series is stale", () => {
    const history = deriveFundamentalHistoryFromFinancialStatements(
      statements({
        ...clfd(),
        [CONTINUING_NCI]: [fy25(6_310_000)],
        [CONTINUING_EPS]: [fy25(0.45)],
      }),
    );

    expect(history.series.netIncome.scope).toBeUndefined();
    expect(history.series.dilutedEps.label).toBe("Diluted EPS");
  });

  test("labels trend net income as total operations beside continuing FCF", () => {
    const trends = financialTrends(
      deriveFundamentalHistoryFromFinancialStatements(statements(clfd())),
      false,
    )!;

    expect(renderProjectedFinancialTrends(researchReport(), trends)).toContain(
      "Period | Revenue | Net income (total operations) | Operating margin | FCF",
    );
    expect(financialTrendFromProjection(trends)?.columns[2]).toBe("Net income (total operations)");
  });
});

describe("earnings basis disclosure", () => {
  const artifact = statements(clfd());

  test("shows SEC and provider trailing EPS side by side when they disagree", () => {
    const basis = earningsBasis(yahoo(), artifact);

    expect(basis).toEqual({
      text: "Provider trailing EPS 0.54 (Yahoo; accounting scope and period basis undisclosed). SEC diluted EPS TTM -0.51 USD through 2026-06-30 (total operations). SEC diluted EPS TTM from continuing operations 0.29 USD through 2026-06-30. Both SEC values are approximations that add per-share periods without reweighting diluted shares. The provider value matches neither SEC value at two decimals, and the supplied evidence does not reconcile the difference.",
      sourceIds: ["market-yahoo-equity-clfd", "sec-clfd"],
    });
  });

  test("names the matching SEC scope when the values agree", () => {
    const basis = earningsBasis(yahoo(0.29), artifact);

    expect(basis?.text).toEndWith(
      "The provider value matches the SEC continuing-operations value at two decimals.",
    );
  });

  test("omits the disclosure without a provider value", () => {
    expect(earningsBasis(yahoo(null), artifact)).toBeUndefined();
    expect(earningsBasis(undefined, artifact)).toBeUndefined();
  });

  test("keeps continuing EPS and its citation when total EPS is missing", () => {
    const { EarningsPerShareDiluted: _eps, ...concepts } = clfd();
    const basis = earningsBasis(yahoo(), statements(concepts));

    expect(basis).toEqual({
      text: "Provider trailing EPS 0.54 (Yahoo; accounting scope and period basis undisclosed). SEC diluted EPS TTM from continuing operations 0.29 USD through 2026-06-30. The SEC value is an approximation that adds per-share periods without reweighting diluted shares. The provider value matches no SEC value at two decimals, and the supplied evidence does not reconcile the difference.",
      sourceIds: ["market-yahoo-equity-clfd", "sec-clfd"],
    });
  });

  test("applies the approximation note to total EPS shown alone", () => {
    const { [CONTINUING_EPS]: _continuing, ...concepts } = clfd();
    const basis = earningsBasis(yahoo(), statements(concepts));

    expect(basis?.text).toContain(
      "SEC diluted EPS TTM -0.51 USD through 2026-06-30. The SEC value is an approximation that adds per-share periods without reweighting diluted shares.",
    );
  });

  test("projects the disclosure and its citations into the synthesis evidence", () => {
    const command: ResearchCommand = {
      jobType: "equity",
      assetClass: "equity",
      symbol: "CLFD",
      depth: "brief",
    };
    const evidence = buildEvidencePayload(
      { includePriorCalibration: true, sourceGapView: "all", webSourceText: "fresh-only" },
      command,
      collectedSources({
        rawSnapshots: [],
        marketSnapshots: [yahoo()],
        newsSources: [],
        sourceGaps: [],
        financialStatements: artifact,
      }),
      config,
      contextWithHistory(command),
    );

    expect(evidence.earningsBasis).toEqual(earningsBasis(yahoo(), artifact));
    expect(evidence.deterministicCitationGuidance).toContain("earningsBasis");
  });

  test("keeps the provider value when the SEC or currency basis is unknown", () => {
    expect(earningsBasis(yahoo(), undefined)?.text).toBe(
      "Provider trailing EPS 0.54 (Yahoo; accounting scope and period basis undisclosed). No SEC diluted EPS TTM is available to compare.",
    );
    expect(earningsBasis(yahoo(0.54, null), artifact)?.text).toEndWith(
      "The provider quote currency (undisclosed) differs from the USD filing currency, so the values are not compared.",
    );
  });

  test("renders the same disclosure in Markdown and the Research Console", async () => {
    const snapshot = yahoo();
    const report = researchReport({
      jobType: "equity",
      symbol: "CLFD",
      sources: [
        { id: "market-yahoo-equity-clfd", title: "Yahoo", fetchedAt: AS_OF, kind: "market-data" },
        { id: "sec-clfd", title: "SEC", fetchedAt: AS_OF, kind: "market-data" },
      ],
    } as never);
    const projection = projectEquityReader({
      report,
      marketSnapshot: snapshot,
      financialStatements: artifact,
    });
    const markdown = renderValuationContext(
      report,
      projection.defaultView.valuationContext,
      projection.defaultView.earningsBasis,
    );
    const detail: RunDetail = {
      summary: {
        runId: "run-1",
        jobType: "equity",
        assetClass: "equity",
        symbol: "CLFD",
        findingCount: 0,
        predictionCount: 0,
        sourceCount: 0,
        dataGapCount: 0,
        hasScore: false,
        availableFiles: [],
      },
      report: report as unknown as Record<string, unknown>,
      marketSnapshots: [snapshot],
      financialStatements: artifact,
    };
    const view = buildRunWorkspaceView(detail).equityPresentation?.defaultView.earningsBasis;
    const html = await renderRunWorkspace(detail);

    expect(view).toEqual(projection.defaultView.earningsBasis);
    expect(markdown).toContain(
      `- **Earnings basis:** ${view!.text} [market-yahoo-equity-clfd] [sec-clfd]`,
    );
    expect(html.replaceAll(/<[^>]+>/gu, "")).toContain("Provider trailing EPS 0.54");
  }, 15_000);
});

async function renderRunWorkspace(detail: RunDetail): Promise<string> {
  const subprocess = Bun.spawn(
    [
      process.execPath,
      "run",
      resolve(import.meta.dir, "support/render-run-workspace.ts"),
      "simple",
      "report",
    ],
    { stdin: new Blob([JSON.stringify(detail)]), stdout: "pipe", stderr: "pipe" },
  );
  const [body, error, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(error);
  }
  return body;
}

const gpnH1 = (val: number): Row => ({
  val,
  start: "2026-01-01",
  end: "2026-06-30",
  form: "10-Q",
  fy: 2026,
  fp: "Q2",
  filed: "2026-08-05",
  accn: "0001123360-26-000084",
});

// AMD FY2025 10-K (0000002488-26-000018) and Q1/Q2 2026 10-Qs (-26-000076, -26-000123), USD millions.
function amd(): Concepts {
  const m = 1_000_000;
  const at =
    (start: string, end: string, fp: string, filed: string, accn: string) => (val: number) => ({
      val: val * m,
      start,
      end,
      form: fp === "FY" ? "10-K" : "10-Q",
      fy: 2026,
      fp,
      filed,
      accn,
    });
  const fy2025 = at("2024-12-29", "2025-12-27", "FY", "2026-02-04", "0000002488-26-000018");
  const q1 = at("2025-12-28", "2026-03-28", "Q1", "2026-05-06", "0000002488-26-000076");
  const h1Prior = at("2024-12-29", "2025-06-28", "Q2", "2026-08-05", "0000002488-26-000123");
  const h1 = at("2025-12-28", "2026-06-27", "Q2", "2026-08-05", "0000002488-26-000123");
  return {
    RevenueFromContractWithCustomerExcludingAssessedTax: [
      fy2025(34_639),
      q1(10_253),
      h1Prior(15_123),
      h1(21_789),
    ],
    NetIncomeLoss: [fy2025(4335), q1(1383), h1Prior(1581), h1(3680)],
    [CONTINUING_PARENT]: [fy2025(4269), q1(1372), h1Prior(1477), h1(3677)],
    IncomeLossFromDiscontinuedOperationsNetOfTax: [fy2025(66), q1(11), h1Prior(104), h1(3)],
    [TOTAL_OCF]: [fy2025(7709), q1(2955), h1Prior(2950), h1(5321)],
    [CONTINUING_OCF]: [fy2025(6493), h1Prior(2401), h1(5321)],
    CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations: [
      fy2025(1216),
      h1Prior(549),
      h1(0),
    ],
    PaymentsToAcquirePropertyPlantAndEquipment: [fy2025(974), q1(389), h1Prior(494), h1(1197)],
    // The face splits investing, so its PP&E line is continuing capex.
    [CONTINUING_INVESTING]: [fy2025(-6851), h1Prior(-2633), h1(-5172)],
  };
}

describe("continuing-operations basis for cash flow and margins", () => {
  test("pairs continuing OCF with capex and revenue for AMD", () => {
    const artifact = statements(amd(), undefined, [capexCalc("0000002488-26-000018")]);
    const ocf = artifact.statements.cashFlowStatement.operatingCashFlow;
    const history = deriveFundamentalHistoryFromFinancialStatements(artifact);
    const fy2025 = (key: "freeCashFlowProxy" | "netMargin") =>
      history.series[key].annual.find((point) => point.periodEnd === "2025-12-27")?.value;

    expect(ocf.annual.find((fact) => fact.periodEnd === "2025-12-27")?.value).toBe(6_493_000_000);
    expect(ocf.ttm?.value).toBe(9_413_000_000);
    expect(fy2025("freeCashFlowProxy")).toBe(5_519_000_000);
    expect(artifact.statements.cashFlowStatement.capitalExpenditure.ttm).toBeDefined();
    expect(fy2025("netMargin")).toBeCloseTo(4269 / 34_639, 12);
    expect(history.series.freeCashFlowProxy.label).toBe(
      "Free cash flow proxy (continuing operations)",
    );
    expect(history.series.freeCashFlowProxy.notes).toContain(
      `scope:capex-continuing: ${CAPEX_SCOPE_CAVEAT}`,
    );
    // AMD reports no NCI, so parent continuing income is its consolidated amount.
    expect(lensMetric(artifact, "netMargin")).toMatchObject({
      label: "Net margin (continuing operations)",
      value: 3677 / 21_789,
    });
    // The H1 2026 10-Q has no fetched calculation linkbase or discontinued investing, so its capex is noted.
    expect(lensMetric(artifact, "freeCashFlowProxy")?.value).toBeDefined();
    expect(unprovenNotes(artifact).map(({ periodKey }) => periodKey)).toContain(
      "duration:6|2026-06-27",
    );
    const { periods } = valuationPeriodInputs(artifact);
    const annual = periods.find(
      (period) => period.basis === "annual" && period.periodEnd === "2025-12-27",
    );
    expect(annual?.freeCashFlow).toMatchObject({
      value: 5_519_000_000,
      derivation: expect.stringContaining(CAPEX_SCOPE_CAVEAT),
    });
    expect(annual?.capitalExpenditure?.label).toBe("Capital expenditure");
    expect(
      operatingRatiosSection({ symbol: "AMD", statements: artifact }).section.metrics.find(
        ({ id }) => id === "freeCashFlowMargin",
      ),
    ).toMatchObject({
      label: "Free cash flow margin (continuing operations)",
      value: 5519 / 34_639,
      basis: expect.stringContaining(CAPEX_SCOPE_CAVEAT),
    });
  });

  test("AMD H1 2026 10-Q's own calc linkbase proves both YTD capex columns and the TTM", () => {
    const tenK = capexCalc("0000002488-26-000018");
    const tenQ = capexCalc("0000002488-26-000123");
    const proofFree = { ...tenQ, metrics: { accessionNumber: "0000002488-26-000123" } };
    const h1Keys = new Set(["duration:6|2025-06-28", "duration:6|2026-06-27"]);
    const unprovenH1 = (artifact: FinancialStatementsArtifact) =>
      unprovenNotes(artifact).filter(({ periodKey }) => h1Keys.has(periodKey ?? ""));

    for (const filings of [
      [tenK, tenQ],
      [tenK, tenQ, proofFree],
      [tenK, proofFree, tenQ],
    ]) {
      const artifact = statements(amd(), undefined, filings);
      expect(unprovenH1(artifact)).toEqual([]);
      expect(artifact.statements.cashFlowStatement.capitalExpenditure.ttm?.value).toBe(
        (974 + 1197 - 494) * 1_000_000,
      );
    }
    // Q1's linkbase is another filing's proof, so the H1 columns stay noted.
    expect(
      unprovenH1(statements(amd(), undefined, [tenK, capexCalc("0000002488-26-000076")])),
    ).toHaveLength(2);
  });

  test("a TTM over a withheld YTD column stays absent until that column's filing proves it", () => {
    const h1Prior = amd()[CAPEX]!.find(({ end }) => end === "2025-06-28")!;
    const mixed = { ...amd(), [DISCONTINUED_INVESTING]: [{ ...h1Prior, val: -14_000_000 }] };
    const ttm = (filings: readonly ExtendedEvidenceItem[]) =>
      statements(mixed, undefined, filings).statements.cashFlowStatement.capitalExpenditure.ttm;

    expect(ttm([capexCalc("0000002488-26-000018")])).toBeUndefined();
    expect(ttm([capexCalc("0000002488-26-000018"), capexCalc("0000002488-26-000123")])?.value).toBe(
      (974 + 1197 - 494) * 1_000_000,
    );
  });

  test.each([
    ["no FY proof", "duration:12|2025-12-27", false],
    ["a prior YTD filed by another accession", "duration:6|2025-06-28", true],
  ])("a TTM over %s keeps that component's unproven disclosure", (_label, unproven, olderPrior) => {
    const concepts = olderPrior
      ? {
          ...amd(),
          [CAPEX]: amd()[CAPEX]!.map((fact) =>
            fact.end === "2025-06-28" ? { ...fact, accn: "0000002488-25-000082" } : fact,
          ),
        }
      : amd();
    const tenQ = capexCalc("0000002488-26-000123");
    const artifact = statements(
      concepts,
      undefined,
      olderPrior ? [capexCalc("0000002488-26-000018"), tenQ] : [tenQ],
    );
    const ttm = valuationPeriodInputs(artifact).periods.find(({ basis }) => basis === "ttm");

    expect(unprovenNotes(artifact).map(({ periodKey }) => periodKey)).toEqual([unproven]);
    expect(artifact.statements.cashFlowStatement.capitalExpenditure.ttm?.value).toBe(
      (974 + 1197 - 494) * 1_000_000,
    );
    expect(ttm?.freeCashFlow?.derivation).toContain(CAPEX_SCOPE_CAVEAT);
    expect(
      deriveFundamentalHistoryFromFinancialStatements(artifact).series.freeCashFlowProxy.notes,
    ).toContain(`scope:capex-continuing: ${CAPEX_SCOPE_CAVEAT}`);
  });

  test("withholds a total-only OCF period that reports discontinued operations, with a gap", () => {
    const artifact = statements(amd());
    const ocf = artifact.statements.cashFlowStatement.operatingCashFlow;

    expect(financialStatementFacts(ocf).some((fact) => fact.periodEnd === "2026-03-28")).toBe(
      false,
    );
    expect(financialStatementsHistoryGaps(artifact).map((gap) => gap.message)).toContain(
      "SEC operating cash flow is not derived for 2025-12-28 to 2026-03-28: discontinued operations are reported for the period and no continuing-operations operating cash flow is tagged",
    );
  });

  test("withholds the legacy FCF proxy when OCF is total and discontinued operations are reported", () => {
    const legacyFcf = (concepts: Concepts) => {
      const summary = summarizeSecFundamentals(payload(concepts), AS_OF)!;
      const item = {
        category: "sec-edgar" as const,
        title: "AMD SEC Fundamental Evidence",
        summary: summary.summary,
        sourceIds: ["sec-amd"],
        observedAt: AS_OF,
        metrics: summary.metrics,
      };
      return {
        scope: summary.metrics.operatingCashFlowScope,
        fcf: summaryLens(item, "Quality", AS_OF).metrics.find(
          ({ key }) => key === "freeCashFlowProxy",
        ),
      };
    };
    const { [CONTINUING_OCF]: _continuing, ...totalOnly } = amd();
    const {
      IncomeLossFromDiscontinuedOperationsNetOfTax: _income,
      CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations: _cash,
      ...noDiscontinued
    } = totalOnly;

    expect(legacyFcf(totalOnly)).toEqual({ scope: "total operations", fcf: undefined });
    expect(legacyFcf(noDiscontinued)).toMatchObject({
      scope: undefined,
      fcf: { label: "FCF proxy", value: (5321 - 1197) * 1_000_000 },
    });
  });

  test("keeps total OCF unscoped when no discontinued operations are reported", () => {
    const {
      [CONTINUING_OCF]: _continuing,
      [CONTINUING_PARENT]: _income,
      IncomeLossFromDiscontinuedOperationsNetOfTax: _discontinued,
      CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations: _discontinuedCash,
      ...concepts
    } = amd();
    const artifact = statements(concepts);

    expect(artifact.statements.cashFlowStatement.operatingCashFlow.ttm?.value).toBe(10_080_000_000);
    expect(lensMetric(artifact, "freeCashFlowProxy")).toMatchObject({
      label: "FCF proxy",
      value: (5321 - 1197) * 1_000_000,
    });
    expect(lensMetric(artifact, "netMargin")?.label).toBe("Net margin");
    expect(
      summarizeSecFundamentals(payload(concepts), AS_OF)!.metrics.operatingCashFlowScope,
    ).toBeUndefined();
  });

  test("withholds a total-income margin for a period with discontinued operations, with a gap", () => {
    const concepts = {
      ...amd(),
      [CONTINUING_PARENT]: amd()[CONTINUING_PARENT]!.filter((fact) => fact.end !== "2026-06-27"),
    };
    const artifact = statements(concepts);
    const history = deriveFundamentalHistoryFromFinancialStatements(artifact);
    const summary = summarizeSecFundamentals(payload(concepts), AS_OF)!;
    const legacyItem = {
      category: "sec-edgar" as const,
      title: "AMD SEC Fundamental Evidence",
      summary: summary.summary,
      sourceIds: ["sec-amd"],
      observedAt: AS_OF,
      metrics: summary.metrics,
    };
    expect(lensMetric(artifact, "netMargin")).toBeUndefined();
    expect(
      summaryLens(legacyItem, "Quality", AS_OF).metrics.find(({ key }) => key === "netMargin"),
    ).toBeUndefined();
    expect(history.series.netMargin.ttm?.periodEnd).not.toBe("2026-06-27");
    expect(financialStatementsHistoryGaps(artifact).map((gap) => gap.message)).toContain(
      "SEC net margin is withheld for 2025-12-28 to 2026-06-27: discontinued operations are reported and no continuing-operations income is tagged",
    );
  });

  test("withholds a TTM margin when its prior-YTD component reports discontinued operations untagged", () => {
    const concepts = {
      ...amd(),
      [CONTINUING_PARENT]: amd()[CONTINUING_PARENT]!.filter((fact) => fact.end !== "2025-06-28"),
    };
    const artifact = statements(concepts);

    expect(artifact.statements.incomeStatement.netIncome.ttm?.periodEnd).toBe("2026-06-27");
    expect(
      deriveFundamentalHistoryFromFinancialStatements(artifact).series.netMargin.ttm,
    ).toBeUndefined();
    expect(financialStatementsHistoryGaps(artifact).map((gap) => gap.message)).toContain(
      "SEC net margin is withheld for 2024-12-29 to 2025-06-28: discontinued operations are reported and no continuing-operations income is tagged",
    );
  });

  // GPN H1 2026 10-Q (0001123360-26-000084): continuing income -98.717M to parent, -61.938M including NCI.
  const gpn = (): Concepts => ({
    RevenueFromContractWithCustomerExcludingAssessedTax: [gpnH1(6_290_473_000)],
    NetIncomeLoss: [gpnH1(-1_786_907_000)],
    ProfitLoss: [gpnH1(-1_750_128_000)],
    NetIncomeLossAttributableToNoncontrollingInterest: [gpnH1(36_779_000)],
    [CONTINUING_PARENT]: [gpnH1(-98_717_000)],
    [CONTINUING_NCI]: [gpnH1(-61_938_000)],
    IncomeLossFromDiscontinuedOperationsNetOfTax: [gpnH1(-1_688_190_000)],
  });

  test("puts continuing income including NCI over consolidated revenue for GPN", () => {
    expect(lensMetric(statements(gpn()), "netMargin")).toMatchObject({
      label: "Net margin (continuing operations)",
      value: -61_938_000 / 6_290_473_000,
    });
    expect(legacyMetric(gpn(), "netMargin")?.value).toBeCloseTo(-0.009_846, 6);
  });

  test("withholds a parent-only continuing margin when NCI income is reported, with a gap", () => {
    const { [CONTINUING_NCI]: _consolidated, ...concepts } = gpn();
    const artifact = statements(concepts);

    expect(lensMetric(artifact, "netMargin")).toBeUndefined();
    expect(legacyMetric(concepts, "netMargin")).toBeUndefined();
    expect(
      deriveFundamentalHistoryFromFinancialStatements(artifact).series.netMargin.annual,
    ).toEqual([]);
    expect(financialStatementsHistoryGaps(artifact).map((gap) => gap.message)).toContain(
      "SEC continuing net margin is withheld for 2026-01-01 to 2026-06-30: noncontrolling interest income is reported and continuing income is tagged only as attributable to parent",
    );
  });

  test("treats ProfitLoss unequal to NetIncomeLoss as NCI evidence without NCI concepts", () => {
    const {
      [CONTINUING_NCI]: _consolidated,
      NetIncomeLossAttributableToNoncontrollingInterest: _nci,
      ...concepts
    } = gpn();
    const artifact = statements(concepts);

    expect(lensMetric(artifact, "netMargin")).toBeUndefined();
    expect(legacyMetric(concepts, "netMargin")).toBeUndefined();
    expect(financialStatementsHistoryGaps(artifact).map((gap) => gap.message)).toContain(
      "SEC continuing net margin is withheld for 2026-01-01 to 2026-06-30: noncontrolling interest income is reported and continuing income is tagged only as attributable to parent",
    );
  });

  test("puts consolidated net income over revenue and withholds parent-only income beside NCI", () => {
    const {
      [CONTINUING_NCI]: _nci,
      [CONTINUING_PARENT]: _parent,
      IncomeLossFromDiscontinuedOperationsNetOfTax: _discontinued,
      ...consolidated
    } = gpn();
    const { ProfitLoss: _profitLoss, ...parentOnly } = consolidated;

    expect(lensMetric(statements(consolidated), "netMargin")).toMatchObject({
      label: "Net margin",
      value: -1_750_128_000 / 6_290_473_000,
    });
    expect(legacyMetric(consolidated, "netMargin")?.value).toBeCloseTo(
      -1_750_128_000 / 6_290_473_000,
      12,
    );
    expect(lensMetric(statements(parentOnly), "netMargin")).toBeUndefined();
    expect(legacyMetric(parentOnly, "netMargin")).toBeUndefined();
    expect(
      financialStatementsHistoryGaps(statements(parentOnly)).map((gap) => gap.message),
    ).toContain(
      "SEC net margin is withheld for 2026-01-01 to 2026-06-30: noncontrolling interest income is reported and no consolidated net income including NCI is tagged",
    );
  });
});

test("withholds IFRS parent continuing income when NCI income is reported", () => {
  const ifrs = (val: number) => ({ ...fy25(val), form: "20-F" });
  const artifact = deriveFinancialStatements(
    {
      facts: {
        "ifrs-full": Object.fromEntries(
          Object.entries({
            Revenue: 100_000_000,
            ProfitLoss: 55_000_000,
            ProfitLossAttributableToOwnersOfParent: 27_500_000,
            ProfitLossAttributableToNoncontrollingInterests: 27_500_000,
            ProfitLossFromContinuingOperationsAttributableToOwnersOfParent: 27_500_000,
          }).map(([concept, val]) => [concept, { units: { USD: [ifrs(val)] } }]),
        ),
      },
    },
    { symbol: "IFRS", generatedAt: AS_OF, analysisAsOf: AS_OF, sourceId: "sec-ifrs" },
  );

  expect(lensMetric(artifact, "netMargin")?.value).toBeUndefined();
  expect(deriveFundamentalHistoryFromFinancialStatements(artifact).series.netMargin.annual).toEqual(
    [],
  );
  expect(artifact.omissionNotes).toContainEqual(
    expect.objectContaining({
      code: "withheld-derivation",
      seriesKey: "consolidatedContinuingIncome",
    }),
  );
});

const filings = (concepts: Concepts, form: (fp: string) => string): Concepts =>
  Object.fromEntries(
    Object.entries(concepts).map(([concept, rows]) => [
      concept,
      rows.map((value) => ({ ...value, form: form(String(value.fp)) })),
    ]),
  );
const unitFor = (concept: string) => {
  if (/PerShare/u.test(concept)) {
    return "USD/shares";
  }
  return /Shares/u.test(concept) ? "shares" : "USD";
};
const scoped = (taxonomy: "us-gaap" | "ifrs-full", concepts: Concepts) =>
  deriveFinancialStatements(
    {
      facts: {
        [taxonomy]: Object.fromEntries(
          Object.entries(concepts).map(([concept, rows]) => [
            concept,
            { units: { [unitFor(concept)]: rows } },
          ]),
        ),
      },
    },
    { symbol: "TEST", generatedAt: AS_OF, analysisAsOf: AS_OF, sourceId: "sec-test" },
  );
const flows = (value: number): readonly Row[] => [fy25(value), ytdPrior(value), ytd(value)];

describe("diluted shares require parent-attributable income", () => {
  test("IFRS consolidated ProfitLoss 100 vs parent 50 and EPS 5 withholds shares, not 20", () => {
    const { ttm, periods } = valuationPeriodInputs(
      scoped(
        "ifrs-full",
        filings(
          {
            Revenue: flows(1000),
            ProfitLoss: flows(100),
            ProfitLossAttributableToOwnersOfParent: flows(50),
            DilutedEarningsLossPerShare: flows(5),
          },
          (fp) => (fp === "FY" ? "20-F" : "6-K"),
        ),
      ),
    );

    expect(ttm?.netIncome?.value).toBe(100);
    expect(ttm?.dilutedShares).toBeUndefined();
    expect(periods[0]?.netIncome?.value).toBe(100);
    expect(periods[0]?.dilutedShares).toBeUndefined();
  });

  test("us-gaap parent NetIncomeLoss 50 and EPS 5 takes the filed count, never NI / EPS", () => {
    const { ttm, periods } = valuationPeriodInputs(
      scoped("us-gaap", {
        Revenues: flows(1000),
        NetIncomeLoss: flows(50),
        ProfitLoss: flows(100),
        EarningsPerShareDiluted: flows(5),
        WeightedAverageNumberOfDilutedSharesOutstanding: flows(12),
      }),
    );

    expect(ttm?.dilutedShares?.value).toBe(12);
    expect(periods[0]?.dilutedShares?.value).toBe(12);
  });
});

const hlitFy = (val: number): Row => ({
  val,
  start: "2025-01-01",
  end: "2025-12-31",
  form: "10-K",
  fy: 2025,
  fp: "FY",
  filed: "2026-02-24",
  accn: "0001193125-26-067506",
});
const hlitH1 = (val: number): Row => ({
  val,
  start: "2026-01-01",
  end: "2026-07-03",
  form: "10-Q",
  fy: 2026,
  fp: "Q2",
  filed: "2026-08-17",
  accn: "0001193125-26-353891",
});
const apld = (val: number, accn: string, filed: string, fy: number): Row => ({
  val,
  start: "2022-06-01",
  end: "2023-05-31",
  form: "10-K",
  fy,
  fp: "FY",
  filed,
  accn,
});

// HLIT FY2025 10-K (0001193125-26-067506) and Q2 2026 10-Q (0001193125-26-353891).
describe("continuing OCF from a filed total and its discontinued component", () => {
  const DISCONTINUED_OCF = "CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations";
  const hlit = (): Concepts => ({
    RevenueFromContractWithCustomerExcludingAssessedTax: [hlitFy(360_523_000), hlitH1(255_157_000)],
    [TOTAL_OCF]: [hlitFy(107_966_000), hlitH1(-26_260_000)],
    [DISCONTINUED_OCF]: [hlitFy(2_532_000)],
    IncomeLossFromDiscontinuedOperationsNetOfTax: [hlitFy(-44_526_000), hlitH1(-21_714_000)],
  });

  test("nets FY2025 total 107,966K minus discontinued 2,532K to continuing 105,434K", () => {
    const ocf = statements(hlit()).statements.cashFlowStatement.operatingCashFlow;

    expect(ocf.annual).toHaveLength(1);
    expect(ocf.annual[0]).toMatchObject({ periodEnd: "2025-12-31", value: 105_434_000 });
    expect(conceptScope(ocf.annual[0]!.concept)).toBe("continuing operations");
  });

  test("withholds the H1 2026 total, which has no filed discontinued component", () => {
    const artifact = statements(hlit());

    expect(artifact.statements.cashFlowStatement.operatingCashFlow.interim).toEqual([]);
    expect(artifact.omissionNotes.map((note) => note.message).join("\n")).toContain(
      "SEC operating cash flow is not derived for 2026-01-01 to 2026-07-03",
    );
  });

  test("a same-day 10-K/A total without the component withholds rather than netting the original", () => {
    const amended = (val: number): Row => ({
      ...hlitFy(val),
      form: "10-K/A",
      accn: "0001193125-26-067507",
    });
    const artifact = statements({
      RevenueFromContractWithCustomerExcludingAssessedTax: [hlitFy(360_523_000)],
      [TOTAL_OCF]: [hlitFy(100), amended(120)],
      [DISCONTINUED_OCF]: [hlitFy(10)],
      IncomeLossFromDiscontinuedOperationsNetOfTax: [hlitFy(-44_526_000)],
    });

    expect(artifact.statements.cashFlowStatement.operatingCashFlow.annual).toEqual([]);
  });

  // APLD FY2023: the 2023 10-K tagged zero discontinued OCF; the 2025 10-K recast Cloud Services as discontinued.
  test("APLD FY2023 keeps the gap when only a superseded filing tags the discontinued component", () => {
    const apldFy23 = (val: number) => apld(val, "0001144879-23-000176", "2023-08-02", 2023);
    const apldFy25 = (val: number) => apld(val, "0001144879-25-000021", "2025-07-30", 2025);
    const artifact = statements({
      Revenues: [apldFy23(55_388_000), apldFy25(55_388_000)],
      [TOTAL_OCF]: [apldFy23(58_735_000), apldFy25(58_735_000)],
      [DISCONTINUED_OCF]: [apldFy23(0)],
      IncomeLossFromDiscontinuedOperationsNetOfTax: [apldFy23(0), apldFy25(-1_118_000)],
    });

    expect(artifact.statements.cashFlowStatement.operatingCashFlow.annual).toEqual([]);
    expect(artifact.omissionNotes.map((note) => note.message).join("\n")).toContain(
      "SEC operating cash flow is not derived for 2022-06-01 to 2023-05-31",
    );
  });
});

const ebayFy = (val: number): Row => ({
  val: val * 1_000_000,
  start: "2025-01-01",
  end: "2025-12-31",
  form: "10-K",
  fy: 2025,
  fp: "FY",
  filed: "2026-02-19",
  accn: "0001065088-26-000027",
});

// EBAY FY2025 10-K (0001065088-26-000027): continuing OCF, unsplit investing, no discontinued capex tag.
function ebay(): Concepts {
  return {
    RevenueFromContractWithCustomerExcludingAssessedTax: [ebayFy(11_100)],
    [TOTAL_OCF]: [ebayFy(1959)],
    [CONTINUING_OCF]: [ebayFy(2009)],
    CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations: [ebayFy(-50)],
    [CAPEX]: [ebayFy(525)],
    [TOTAL_INVESTING]: [ebayFy(1420)],
    [CONTINUING_INVESTING]: [ebayFy(1450)],
  };
}

const capex = (artifact: FinancialStatementsArtifact) =>
  artifact.statements.cashFlowStatement.capitalExpenditure.annual;
const fcfMargin = (artifact: FinancialStatementsArtifact) =>
  operatingRatiosSection({ symbol: "TEST", statements: artifact }).section.metrics.find(
    ({ id }) => id === "freeCashFlowMargin",
  );

const EBAY_10K = "0001065088-26-000027";
const CAPEX_GAP =
  "SEC capital expenditure is not derived for 2025-01-01 to 2025-12-31: operating cash flow is continuing operations, discontinued-operations investing cash flow is reported for the period, and no calculation linkbase places capital expenditure inside the continuing-operations investing subtotal";
const CAPEX_NOTE =
  "SEC capital expenditure for 2025-01-01 to 2025-12-31 is the filed line beside continuing-operations operating cash flow; no calculation linkbase proves it is continuing-operations only, and no discontinued-operations investing is reported for the period";
const unprovenNotes = (artifact: FinancialStatementsArtifact) =>
  artifact.omissionNotes.filter(({ code }) => code === "capex-scope-unproven");
const mixedEbay = (): Concepts => ({ ...ebay(), [DISCONTINUED_INVESTING]: [ebayFy(-30)] });

describe("capital expenditure on the operating cash flow's scope", () => {
  // HLIT FY2025 10-K (0001193125-26-067506): continuing OCF 105,434K, capex 11,080K unsplit beside discontinued investing −801K.
  test("withholds HLIT FY2025 capex instead of subtracting 11,080K from continuing OCF", () => {
    const artifact = statements({
      RevenueFromContractWithCustomerExcludingAssessedTax: [hlitFy(360_523_000)],
      [TOTAL_OCF]: [hlitFy(107_966_000)],
      CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations: [hlitFy(2_532_000)],
      IncomeLossFromDiscontinuedOperationsNetOfTax: [hlitFy(-44_526_000)],
      [CAPEX]: [hlitFy(11_080_000)],
      [TOTAL_INVESTING]: [hlitFy(-11_080_000)],
      [DISCONTINUED_INVESTING]: [hlitFy(-801_000)],
    });

    expect(capex(artifact)).toEqual([]);
    expect(lensMetric(artifact, "freeCashFlowProxy")?.value).toBeUndefined();
    expect(fcfMargin(artifact)?.value).toBeUndefined();
  });

  test("withholds capex beside discontinued investing, with a gap", () => {
    const artifact = statements(mixedEbay());

    expect(capex(artifact)).toEqual([]);
    expect(financialStatementsHistoryGaps(artifact).map((gap) => gap.message)).toContain(CAPEX_GAP);
    expect(lensMetric(artifact, "freeCashFlowProxy")?.value).toBeUndefined();
    expect(valuationPeriodInputs(artifact).periods[0]?.freeCashFlow).toBeUndefined();
  });

  test("publishes EBAY FY2025 capex without mixed-scope evidence, with a disclosed note", () => {
    const artifact = statements(ebay());

    expect(capex(artifact)).toEqual([expect.objectContaining({ value: 525_000_000 })]);
    expect(unprovenNotes(artifact).map(({ message }) => message)).toEqual([CAPEX_NOTE]);
    expect(operatingRatioNotes(artifact)?.map(({ message }) => message)).toContain(CAPEX_NOTE);
    expect(lensMetric(artifact, "freeCashFlowProxy")?.value).toBe((2009 - 525) * 1_000_000);
    expect(fcfMargin(artifact)?.value).toBeCloseTo((2009 - 525) / 11_100, 12);
  });

  test("ignores a zero discontinued investing fact", () => {
    const artifact = statements({ ...ebay(), [DISCONTINUED_INVESTING]: [ebayFy(0)] });

    expect(capex(artifact)).toHaveLength(1);
    expect(unprovenNotes(artifact)).toHaveLength(1);
  });

  test("publishes linkbase-proven capex unqualified, even beside discontinued investing", () => {
    const artifact = statements(mixedEbay(), undefined, [capexCalc(EBAY_10K)]);

    expect(capex(artifact)).toEqual([expect.objectContaining({ value: 525_000_000 })]);
    expect(unprovenNotes(artifact)).toEqual([]);
    expect(lensMetric(artifact, "freeCashFlowProxy")?.value).toBe((2009 - 525) * 1_000_000);
  });

  test("reads tagged discontinued capex, another filing's evidence, and issuer extensions", () => {
    const later = (val: number): Row => ({ ...ebayFy(val), filed: "2026-05-01", accn: "later" });
    const extension: ExtendedEvidenceItem = {
      ...capexCalc("0001065088-26-000099"),
      metrics: {
        "extensionDiscontinuedInvesting|ebay:PaymentsToAcquirePropertyAndEquipmentDiscontinuedOperations|2025-01-01|2025-12-31": 12,
      },
    };

    expect(
      capex(statements({ ...ebay(), CapitalExpenditureDiscontinuedOperations: [ebayFy(20)] })),
    ).toEqual([]);
    expect(capex(statements({ ...ebay(), [DISCONTINUED_INVESTING]: [later(-30)] }))).toEqual([]);
    expect(capex(statements(ebay(), undefined, [extension]))).toEqual([]);
  });

  test("withholds mixed-scope capex the linkbase adds, places elsewhere, or proves for another filing", () => {
    const withProof = (filing: ExtendedEvidenceItem) =>
      capex(statements(mixedEbay(), undefined, [filing]));
    const { [CONTINUING_INVESTING]: _subtotal, ...untagged } = mixedEbay();

    expect(capex(statements(untagged, undefined, [capexCalc(EBAY_10K)]))).toEqual([]);
    expect(withProof(capexCalc(EBAY_10K, 1))).toEqual([]);
    expect(withProof(capexCalc(EBAY_10K, -1, "PaymentsToAcquireProductiveAssets"))).toEqual([]);
    expect(withProof(capexCalc("0001065088-26-000099"))).toEqual([]);
  });

  test("withholds mixed-scope capex filed outside the OCF's filing even at the same value", () => {
    const later = (val: number): Row => ({ ...ebayFy(val), filed: "2026-05-01", accn: "later" });
    const artifact = statements({ ...mixedEbay(), [CAPEX]: [later(525)] }, undefined, [
      capexCalc("later"),
    ]);

    expect(capex(artifact)).toEqual([]);
  });

  test("drops the legacy summary capex beside continuing OCF", () => {
    expect(summarizeSecFundamentals(payload(ebay()), AS_OF)?.metrics.capex).toBeUndefined();
  });

  test("binds the proof only to a subtotal in the capex fact's unit", () => {
    const filed = payload(mixedEbay()) as {
      facts: { "us-gaap": Record<string, { units: Record<string, readonly Row[]> }> };
    };
    filed.facts["us-gaap"][CONTINUING_INVESTING] = { units: { EUR: [ebayFy(1450)] } };
    const artifact = deriveFinancialStatements(filed, {
      symbol: "EBAY",
      generatedAt: AS_OF,
      analysisAsOf: AS_OF,
      sourceId: "sec-ebay",
      secFilings: [capexCalc(EBAY_10K)],
    });

    expect(capex(artifact)).toEqual([]);
  });

  test("reads discontinued investing evidence in another currency", () => {
    const filed = payload(ebay()) as {
      facts: { "us-gaap": Record<string, { units: Record<string, readonly Row[]> }> };
    };
    filed.facts["us-gaap"][DISCONTINUED_INVESTING] = { units: { EUR: [ebayFy(-30)] } };
    const artifact = deriveFinancialStatements(filed, {
      symbol: "EBAY",
      generatedAt: AS_OF,
      analysisAsOf: AS_OF,
      sourceId: "sec-ebay",
    });

    expect(capex(artifact)).toEqual([]);
  });

  // NBIS 2016: a later 20-F restates capex in RUB beside the USD series the linkbase proves.
  test("ignores a later capex revision in another unit", () => {
    const filed = payload(ebay()) as {
      facts: { "us-gaap": Record<string, { units: Record<string, readonly Row[]> }> };
    };
    filed.facts["us-gaap"][CAPEX]!.units.RUB = [
      { ...ebayFy(40_000), filed: "2026-03-01", accn: "later" },
    ];
    const artifact = deriveFinancialStatements(filed, {
      symbol: "EBAY",
      generatedAt: AS_OF,
      analysisAsOf: AS_OF,
      sourceId: "sec-ebay",
      secFilings: [capexCalc(EBAY_10K)],
    });

    expect(capex(artifact)).toEqual([expect.objectContaining({ value: 525_000_000 })]);
  });
});

function arc(from: string, to: string, weight: number) {
  return `<link:calculationArc xlink:type="arc" xlink:arcrole="http://www.xbrl.org/2003/arcrole/summation-item" xlink:from="${from}" xlink:to="${to}" weight="${weight}"/>`;
}

describe("continuing investing capex in a calculation linkbase", () => {
  const linkbaseUrl = "https://www.sec.gov/Archives/edgar/data/1/0001/issuer_cal.xml";
  const schema = {
    url: "https://www.sec.gov/Archives/edgar/data/1/0001/issuer.xsd",
    xml: `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="http://issuer.example/2025"><xs:element id="iss_Other" name="Other"/></xs:schema>`,
  };
  const calc = (xml: string) => secContinuingInvestingCalcMetrics(xml, linkbaseUrl, schema);
  const fasb = "https://xbrl.fasb.org/us-gaap/2025/elts/us-gaap-2025.xsd";
  const link = (arcs: string, href = fasb) =>
    `<link:linkbase xmlns:link="http://www.xbrl.org/2003/linkbase" xmlns:xlink="http://www.w3.org/1999/xlink"><link:calculationLink xlink:type="extended" xlink:role="r">${[
      "NetCashProvidedByUsedInInvestingActivities",
      "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations",
      "PaymentsForProceedsFromOtherInvestingActivities",
      CAPEX,
    ]
      .map(
        (concept) =>
          `<link:loc xlink:type="locator" xlink:label="${concept}" xlink:href="${href}#us-gaap_${concept}"/>`,
      )
      .join("")}${arcs}</link:calculationLink></link:linkbase>`;

  test("reads AMD's FY2025 10-K PP&E line inside continuing investing", () => {
    const xml = readFileSync(
      new URL("fixtures/sec-reference-set/amd-10k-0000002488-26-000018.cal.xml", import.meta.url),
      "utf8",
    );

    expect(calc(xml)).toEqual({
      [`${CAPEX_CALC_PREFIX}${CAPEX}`]: -1,
    });
  });

  test("composes nested weights and ignores capex outside the continuing subtotal", () => {
    expect(
      calc(
        link(
          arc(
            "NetCashProvidedByUsedInInvestingActivities",
            "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations",
            1,
          ) + arc("NetCashProvidedByUsedInInvestingActivities", CAPEX, -1),
        ),
      ),
    ).toEqual({});
    expect(
      calc(
        link(
          arc(
            "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations",
            "PaymentsForProceedsFromOtherInvestingActivities",
            -1,
          ) + arc("PaymentsForProceedsFromOtherInvestingActivities", CAPEX, 1),
        ),
      ),
    ).toEqual({ [`${CAPEX_CALC_PREFIX}${CAPEX}`]: -1 });
  });

  test("a second path, a cycle or an unverified locator proves nothing", () => {
    const direct = arc("NetCashProvidedByUsedInInvestingActivitiesContinuingOperations", CAPEX, -1);
    expect(calc(link(direct))).toEqual({ [`${CAPEX_CALC_PREFIX}${CAPEX}`]: -1 });
    expect(
      calc(
        link(
          direct +
            arc(
              "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations",
              "PaymentsForProceedsFromOtherInvestingActivities",
              1,
            ) +
            arc("PaymentsForProceedsFromOtherInvestingActivities", CAPEX, 1),
        ),
      ),
    ).toEqual({});
    expect(
      calc(
        link(
          arc("PaymentsForProceedsFromOtherInvestingActivities", CAPEX, -1) +
            arc(
              "NetCashProvidedByUsedInInvestingActivities",
              "PaymentsForProceedsFromOtherInvestingActivities",
              1,
            ) +
            arc(
              "PaymentsForProceedsFromOtherInvestingActivities",
              "NetCashProvidedByUsedInInvestingActivities",
              1,
            ),
        ),
      ),
    ).toEqual({});
    expect(calc(link(direct, "issuer.xsd"))).toEqual({});
    expect(
      calc(
        link(
          arc("NetCashProvidedByUsedInInvestingActivitiesContinuingOperations", CAPEX, -1).replace(
            'weight="-1"',
            'weight="-1.00000000000000001"',
          ),
        ),
      ),
    ).toEqual({});
  });

  test("a path split across calculation roles proves nothing", () => {
    const role = (name: string, arcs: string) =>
      link(arcs).replace('xlink:role="r"', `xlink:role="${name}"`);
    const [a, b] = [
      role("a", arc("PaymentsForProceedsFromOtherInvestingActivities", CAPEX, 1)),
      role(
        "b",
        arc(
          "NetCashProvidedByUsedInInvestingActivitiesContinuingOperations",
          "PaymentsForProceedsFromOtherInvestingActivities",
          -1,
        ),
      ),
    ];
    const merged = a.replace("</link:linkbase>", "") + b.slice(b.indexOf("<link:calculationLink"));
    expect(calc(merged)).toEqual({});
    expect(calc(merged.replace(`xlink:role="b"`, `xlink:role="a"`))).toEqual({
      [`${CAPEX_CALC_PREFIX}${CAPEX}`]: -1,
    });
  });
});

function annualOcf(artifact: FinancialStatementsArtifact) {
  return artifact.statements.cashFlowStatement.operatingCashFlow.annual;
}

describe("IFRS operating cash flow in a period with discontinued operations", () => {
  const ifrs = (extra: Concepts) =>
    scoped(
      "ifrs-full",
      filings(
        {
          Revenue: flows(1000),
          CashFlowsFromUsedInOperatingActivities: flows(300),
          PurchaseOfPropertyPlantAndEquipment: flows(100),
          ...extra,
        },
        (fp) => (fp === "FY" ? "20-F" : "6-K"),
      ),
    );

  test("withholds the total-operations amount with a gap", () => {
    const artifact = ifrs({ ProfitLossFromDiscontinuedOperations: [fy25(-7)] });

    expect(annualOcf(artifact)).toEqual([]);
    expect(financialStatementsHistoryGaps(artifact).map((gap) => gap.message)).toContain(
      "SEC operating cash flow is not derived for 2024-10-01 to 2025-09-30: discontinued operations are reported for the period and no continuing-operations operating cash flow is tagged",
    );
  });

  test("withholds it on discontinued cash flow even when the discontinued result is zero", () => {
    const artifact = ifrs({
      ProfitLossFromDiscontinuedOperations: [fy25(0)],
      CashFlowsFromUsedInOperatingActivitiesDiscontinuedOperations: [fy25(12)],
    });

    expect(annualOcf(artifact)).toEqual([]);
  });

  test("takes the tagged continuing amount, and notes or withholds capex beside it", () => {
    const continuing = {
      ProfitLossFromDiscontinuedOperations: [fy25(-7)],
      CashFlowsFromUsedInOperatingActivitiesContinuingOperations: [fy25(280)],
    };
    const artifact = ifrs(continuing);

    expect(annualOcf(artifact)).toEqual([expect.objectContaining({ value: 280 })]);
    expect(conceptScope(annualOcf(artifact)[0]!.concept)).toBe("continuing operations");
    expect(capex(artifact)).toEqual([expect.objectContaining({ value: 100 })]);
    expect(unprovenNotes(artifact)).toHaveLength(1);
    expect(
      capex(
        ifrs({
          ...continuing,
          CashFlowsFromUsedInInvestingActivitiesDiscontinuedOperations: [fy25(-15)],
        }),
      ),
    ).toEqual([]);
  });

  test("takes a differing continuing amount without discontinued markers, and gates capex on discontinued investing", () => {
    const continuing = { CashFlowsFromUsedInOperatingActivitiesContinuingOperations: [fy25(280)] };

    expect(annualOcf(ifrs(continuing))).toEqual([expect.objectContaining({ value: 280 })]);
    expect(unprovenNotes(ifrs(continuing))).toHaveLength(1);
    const mixed = ifrs({
      ...continuing,
      ProfitLossFromDiscontinuedOperations: [fy25(0)],
      CashFlowsFromUsedInInvestingActivitiesDiscontinuedOperations: [fy25(-20)],
    });
    expect(annualOcf(mixed)).toEqual([expect.objectContaining({ value: 280 })]);
    expect(capex(mixed)).toEqual([]);
  });

  test("withholds a continuing amount older than the newest total", () => {
    const artifact = ifrs({
      ProfitLossFromDiscontinuedOperations: [fy25(-7)],
      CashFlowsFromUsedInOperatingActivitiesContinuingOperations: [fy25(280)],
      CashFlowsFromUsedInOperatingActivities: [
        ...flows(300),
        { ...fy25(330), form: "20-F", filed: "2026-01-15", accn: "recast" },
      ],
    });

    expect(annualOcf(artifact)).toEqual([]);
    expect(financialStatementsHistoryGaps(artifact).map((gap) => gap.message)).toContain(
      "SEC operating cash flow is not derived for 2024-10-01 to 2025-09-30: continuing-operations operating cash flow is older than the newest total for the period",
    );
  });

  test("keeps it when no discontinued result or cash flow is reported", () => {
    expect(annualOcf(ifrs({ ProfitLossFromDiscontinuedOperations: [fy25(0)] }))).toEqual([
      expect.objectContaining({ value: 300 }),
    ]);
  });
});

describe("first-public dating across equivalent HLIT concepts", () => {
  const fy = (start: string, end: string, accn: string, filed: string) => (val: number) =>
    ({ val, start, end, form: "10-K", fy: 2020, fp: "FY", filed, accn }) satisfies Row;
  const fy17In18 = fy("2017-01-01", "2017-12-31", "0000851310-18-000017", "2018-03-05");
  const fy17In20 = fy("2017-01-01", "2017-12-31", "0000851310-20-000006", "2020-03-02");
  const fy19In20 = fy("2019-01-01", "2019-12-31", "0000851310-20-000006", "2020-03-02");
  const fy19In22 = fy("2019-01-01", "2019-12-31", "0000851310-22-000012", "2022-02-28");
  const ocf = (continuing: number) =>
    statements({
      RevenueFromContractWithCustomerExcludingAssessedTax: [fy17In20(403_558_000)],
      [CONTINUING_OCF]: [fy17In18(continuing)],
      [TOTAL_OCF]: [fy17In20(3_064_000)],
    }).statements.cashFlowStatement.operatingCashFlow.annual[0];

  test("FY2017 total OCF 3,064K is public from the 2018 continuing-operations tag", () => {
    expect(ocf(3_064_000)).toMatchObject({ value: 3_064_000, firstPublicAt: "2018-03-05" });
  });

  test("a different continuing figure does not date the total", () => {
    expect(ocf(3_000_000)).toMatchObject({ value: 3_064_000, firstPublicAt: "2020-03-02" });
  });

  test("a nonzero discontinued-operations fact blocks the earlier continuing date", () => {
    const { annual } = statements({
      RevenueFromContractWithCustomerExcludingAssessedTax: [fy17In20(403_558_000)],
      [CONTINUING_OCF]: [fy17In18(3_064_000)],
      [TOTAL_OCF]: [fy17In20(3_064_000)],
      IncomeLossFromDiscontinuedOperationsNetOfTax: [fy17In20(-1_000_000)],
    }).statements.cashFlowStatement.operatingCashFlow;

    expect(annual.some((fact) => fact.firstPublicAt === "2018-03-05")).toBe(false);
  });

  test("FY2019 diluted EPS -0.07 is public from the basic-and-diluted tag", () => {
    const eps = statements({
      RevenueFromContractWithCustomerExcludingAssessedTax: [fy19In22(402_874_000)],
      EarningsPerShareBasicAndDiluted: [fy19In20(-0.07)],
      EarningsPerShareDiluted: [fy19In22(-0.07)],
    }).statements.perShare.dilutedEps.annual[0];

    expect(eps).toMatchObject({
      concept: "EarningsPerShareDiluted",
      value: -0.07,
      firstPublicAt: "2020-03-02",
    });
  });
});

// Debt filed in a FY2024 10-K; a FY2025 10-K restates FY2024 revenue and first reports its discontinued operations.
const recastOriginal = (val: number, start?: string): Row => ({
  val,
  ...(start === undefined ? {} : { start }),
  end: "2024-09-30",
  form: "10-K",
  fy: 2024,
  fp: "FY",
  filed: "2024-11-15",
  accn: "0000000001-24-000001",
});
const recastRefiled = (val: number, start?: string): Row => ({
  ...recastOriginal(val, start),
  fy: 2025,
  filed: "2025-11-25",
  accn: "0000000001-25-000001",
});
const recastFy2024 = (overrides: Concepts = {}) =>
  deriveFinancialStatements(
    payload({
      RevenueFromContractWithCustomerExcludingAssessedTax: [
        recastOriginal(300, "2023-10-01"),
        recastRefiled(250, "2023-10-01"),
      ],
      CashAndCashEquivalentsAtCarryingValue: [recastOriginal(40), recastRefiled(40)],
      LongTermDebt: [recastOriginal(20)],
      CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations: [
        recastRefiled(-6, "2023-10-01"),
      ],
      ...overrides,
    }),
    { symbol: "X", generatedAt: "2026-02-01", analysisAsOf: "2026-02-01", sourceId: "sec-x" },
  );
const debtScopeNotes = (artifact: FinancialStatementsArtifact) =>
  artifact.omissionNotes.filter(({ code }) => code === "debt-scope-unproven");
const recastPeriod = (artifact: FinancialStatementsArtifact) =>
  valuationPeriodInputs(artifact).periods.find(({ periodEnd }) => periodEnd === "2024-09-30");

describe("debt filed before a later filing first reported discontinued operations", () => {
  test("publishes the debt beside restated revenue with the disclosure", () => {
    const artifact = recastFy2024();
    expect(
      debtScopeNotes(artifact).map(({ periodKey, publicAt }) => [periodKey, publicAt]),
    ).toEqual([["instant|2024-09-30", "2025-11-25"]]);
    expect([
      recastPeriod(artifact)?.debt?.value,
      recastPeriod(artifact)?.debtScopeUnproven,
    ]).toEqual([20, true]);
  });

  test("revenue as originally filed predates the recast, so the pairing carries no disclosure", () => {
    const artifact = recastFy2024({
      RevenueFromContractWithCustomerExcludingAssessedTax: [recastOriginal(300, "2023-10-01")],
    });
    expect(debtScopeNotes(artifact)).toHaveLength(1);
    expect([
      recastPeriod(artifact)?.debt?.value,
      recastPeriod(artifact)?.debtScopeUnproven,
    ]).toEqual([20, undefined]);
  });

  test.each([
    [
      "zero discontinued operations",
      {
        CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations: [
          recastRefiled(0, "2023-10-01"),
        ],
      },
    ],
    [
      "debt re-filed unchanged in the recast",
      { LongTermDebt: [recastOriginal(20), recastRefiled(20)] },
    ],
    [
      "discontinued operations reported with the debt",
      {
        CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations: [
          recastOriginal(-6, "2023-10-01"),
        ],
      },
    ],
  ] as const)("no disclosure: %s", (_label, overrides) => {
    const artifact = recastFy2024(overrides);
    expect(debtScopeNotes(artifact)).toEqual([]);
    expect(recastPeriod(artifact)?.debtScopeUnproven).toBeUndefined();
  });

  const comparative = (filed: string): Row => ({
    ...recastOriginal(20),
    form: "10-Q",
    fy: Number(filed.slice(0, 4)),
    fp: "Q1",
    filed,
    accn: `0000000001-${filed.slice(2, 4)}-000002`,
  });
  const restatedFlow = { periodEnd: "2024-09-30", firstPublicAt: "2025-11-25" };

  test.each([
    ["after", "2026-01-20", false],
    ["before", "2025-02-10", true],
  ] as const)(
    "a 10-Q comparative under another concept filed %s the recast leaves the annual debt disclosed",
    (_order, filed, interimUnproven) => {
      const artifact = recastFy2024({
        DebtLongtermAndShorttermCombinedAmount: [comparative(filed)],
      });
      const { annual, interim } = artifact.statements.balanceSheet.debt;
      const annualDebt = annual.find(({ periodEnd }) => periodEnd === "2024-09-30")!;
      const interimDebt = interim.find(({ periodEnd }) => periodEnd === "2024-09-30")!;
      expect([annualDebt.concept, interimDebt.concept]).toEqual([
        "LongTermDebt",
        "DebtLongtermAndShorttermCombinedAmount",
      ]);
      expect(debtScopeUnproven(artifact, annualDebt, restatedFlow)?.publicAt).toBe("2025-11-25");
      expect(debtScopeUnproven(artifact, interimDebt, restatedFlow) !== undefined).toBe(
        interimUnproven,
      );
    },
  );

  test.each([
    ["after the recast", "2026-01-15", 20, true],
    ["with the recast", "2025-11-25", undefined, undefined],
  ] as const)(
    "held-for-sale evidence filed %s keeps the scope note; it withholds only pairings at or after its date",
    (_label, filed, debt, flagged) => {
      const artifact = recastFy2024({
        LiabilitiesOfDisposalGroupIncludingDiscontinuedOperationCurrent: [
          { ...recastOriginal(50), fy: 2026, filed, accn: "0000000001-26-000003" },
        ],
      });
      expect(
        artifact.omissionNotes
          .filter(({ periodKey }) => periodKey === "instant|2024-09-30")
          .map(({ code, publicAt }) => [code, publicAt])
          .toSorted(),
      ).toEqual(
        [
          ["debt-held-for-sale", filed],
          ["debt-scope-unproven", "2025-11-25"],
        ].toSorted(),
      );
      expect([
        recastPeriod(artifact)?.debt?.value,
        recastPeriod(artifact)?.debtScopeUnproven,
      ]).toEqual([debt, flagged]);
    },
  );

  test("composite debt with the same concepts and total keeps each filing's provenance", () => {
    const artifact = recastFy2024({
      LongTermDebt: [],
      DebtCurrent: [recastOriginal(5), { ...comparative("2026-01-20"), val: 7 }],
      LongTermDebtNoncurrent: [recastOriginal(15), { ...comparative("2026-01-20"), val: 13 }],
    });
    const { annual, interim } = artifact.statements.balanceSheet.debt;
    const annualDebt = annual.find(({ periodEnd }) => periodEnd === "2024-09-30")!;
    const interimDebt = interim.find(({ periodEnd }) => periodEnd === "2024-09-30")!;
    expect([annualDebt.concept, annualDebt.value]).toEqual([
      interimDebt.concept,
      interimDebt.value,
    ]);
    expect(annualDebt.composite?.components.map(({ value }) => value)).toEqual([5, 15]);
    expect(debtScopeUnproven(artifact, annualDebt, restatedFlow)?.publicAt).toBe("2025-11-25");
    expect(debtScopeUnproven(artifact, interimDebt, restatedFlow)).toBeUndefined();
  });

  test("a serialized artifact keeps a well-formed scope note and drops a malformed one with a diagnostic", () => {
    const artifact = recastFy2024();
    const [note] = debtScopeNotes(artifact);
    const read = (unprovenDebt: unknown) =>
      readFinancialStatementsArtifact(
        JSON.parse(JSON.stringify({ ...artifact, omissionNotes: [{ ...note, unprovenDebt }] })),
      );
    expect(recastPeriod(read(note?.unprovenDebt)!)?.debtScopeUnproven).toBe(true);
    for (const malformed of ["not-an-array", [null], [{ periodType: "annual" }]]) {
      const malformedRead = read(malformed)!;
      expect(malformedRead.omissionNotes).toEqual([]);
      expect(malformedRead.readDiagnostics?.drops).toContainEqual(
        expect.objectContaining({ count: 1, reason: expect.stringContaining("unprovenDebt") }),
      );
      expect(recastPeriod(malformedRead)?.debtScopeUnproven).toBeUndefined();
    }
  });
});
