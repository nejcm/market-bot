import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import type { RunDetail, RunSummary } from "../app/types";
import { buildRunWorkspaceView, valuationWorkbenchView } from "../app/client/run-workspace-view";
import {
  financialTrendFromProjection,
  fundamentalHistoryView,
} from "../app/client/run-workspace-financials";
import { composeEquitySnapshot } from "../app/client/run-workspace-snapshot";
import type { MarketSnapshot } from "../src/domain/types";
import { earningsBasis } from "../src/report/equity-reader-earnings-basis";
import { projectEquityReader } from "../src/report/equity-reader";
import { financialTrends } from "../src/report/equity-reader-trends";
import {
  renderProjectedFinancialTrends,
  renderValuationContext,
} from "../src/report/markdown-equity-sections";
import { renderValuationWorkbenchMarkdown } from "../src/report/valuation-workbench-markdown";
import { growthLens, qualityLens } from "../src/sources/extended-evidence/financial-lens-builders";
import { addFinancialLensEvidence } from "../src/sources/extended-evidence/financial-lens";
import {
  cashConversionScopeGaps,
  withCanonicalFinancialLensInputs,
} from "../src/sources/extended-evidence/financial-lens-canonical";
import { conceptScope } from "../src/sources/extended-evidence/financial-statement-definitions";
import { financialStatementFacts } from "../src/sources/extended-evidence/financial-statement-selection";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  readFinancialStatementsArtifact,
  type FinancialStatementsArtifact,
} from "../src/sources/extended-evidence/financial-statements-contract";
import { deriveFundamentalHistoryFromFinancialStatements } from "../src/sources/extended-evidence/fundamental-history-canonical";
import { deriveFundamentalHistory } from "../src/sources/extended-evidence/fundamental-history";
import { buildEvidencePayload } from "../src/research/prompts/evidence-payload";
import { config, contextWithHistory } from "./support/research-context-helpers";
import type { ResearchCommand } from "../src/cli/args";
import { summarizeSecFundamentals } from "../src/sources/extended-evidence/sec-edgar";
import { buildValuationWorkbench } from "../src/sources/extended-evidence/valuation-workbench";
import { valuationPeriodInputs } from "../src/sources/extended-evidence/valuation-workbench-inputs";
import { collectedSources, marketSnapshot, researchReport } from "./support/fixtures";
import { assertFinancialLensPeriodHygiene } from "./support/run-fixtures/financial-invariants";

const AS_OF = "2026-10-07T00:00:00.000Z";
const CONTINUING_OCF = "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations";
const TOTAL_OCF = "NetCashProvidedByUsedInOperatingActivities";
const CONTINUING_NCI =
  "IncomeLossFromContinuingOperationsIncludingPortionAttributableToNoncontrollingInterest";
const CONTINUING_PARENT = "IncomeLossFromContinuingOperations";
const CONTINUING_EPS = "IncomeLossFromContinuingOperationsPerDilutedShare";

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

function statements(concepts: Concepts, units?: Readonly<Record<string, string>>) {
  return deriveFinancialStatements(payload(concepts, units), {
    symbol: "CLFD",
    generatedAt: AS_OF,
    analysisAsOf: AS_OF,
    sourceId: "sec-clfd",
  });
}

function secItem(artifact: FinancialStatementsArtifact) {
  return withCanonicalFinancialLensInputs(undefined, artifact).items[0]!;
}

function lensMetric(artifact: FinancialStatementsArtifact, key: string) {
  const item = secItem(artifact);
  return [...qualityLens(item).metrics, ...growthLens(item).metrics].find(
    (metric) => metric.key === key,
  );
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
    const labels = growthLens(secItem(artifact)).metrics.map((metric) => metric.label);

    expect(metrics.cashConversionSelectedValue).toBeCloseTo(7_345_000 / 2_195_000, 6);
    expect(lensMetric(artifact, "cashConversion")?.label).toBe(
      "Cash conversion (continuing operations)",
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
    const metrics = secItem(statements(concepts)).metrics!;

    expect(metrics.roeSelectedValue).toBeCloseTo((1_858_000 * (12 / 9)) / 245_920_000, 8);
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

    expect(metrics.cashConversionSelectedValue).toBeCloseTo(7_345_000 / 1_858_000, 6);
    expect(metrics.continuingIncome).toBeUndefined();
    expect(metrics.netIncomeScope).toBeUndefined();
    expect(lensMetric(artifact, "netIncomeDeltaPercent")?.label).toBe("Net income (attrib.) YoY");
    expect(lensMetric(artifact, "continuingIncomeDeltaPercent")).toBeUndefined();
    expect(cashConversionScopeGaps(artifact)).toEqual([]);
  });

  test("withholds cash conversion and declares a gap when continuing income is missing", () => {
    const { [CONTINUING_NCI]: _income, ...concepts } = clfd();
    const artifact = statements(concepts);

    expect(secItem(artifact).metrics?.cashConversionSelectedValue).toBeUndefined();
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
      expect(secItem(artifact).metrics?.cashConversionSelectedValue).toBeUndefined();
      expect(cashConversionScopeGaps(artifact)).toHaveLength(1);
    }
  });

  test("withholds a zero-denominator ratio without a scope gap", () => {
    const artifact = statements({ ...clfd(), [CONTINUING_NCI]: [fy25(1), ytdPrior(1), ytd(0)] });

    expect(secItem(artifact).metrics?.cashConversionSelectedValue).toBeUndefined();
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

    expect(secItem(artifact).metrics?.cashConversionSelectedValue).toBeUndefined();
    expect(cashConversionScopeGaps(artifact).map((gap) => gap.message)).toEqual([
      "SEC cash conversion withheld: no net income shares the operating cash flow period, currency, and unit",
    ]);
  });

  test("scopes history earnings by their own continuing counterpart, not by cash flow", () => {
    const { [CONTINUING_OCF]: ocf, ...rest } = clfd();
    const concepts = { ...rest, [TOTAL_OCF]: ocf! };
    const canonical = deriveFundamentalHistoryFromFinancialStatements(statements(concepts));
    const legacy = deriveFundamentalHistory(payload(concepts), {
      symbol: "CLFD",
      generatedAt: AS_OF,
      analysisAsOf: AS_OF,
      sourceId: "sec-clfd",
    });
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

    for (const history of [canonical, legacy]) {
      expect(history.series.netIncome).toMatchObject({
        label: "Net income (total operations)",
        scope: "total operations",
      });
      expect(history.series.dilutedEps.label).toBe("Diluted EPS (total operations)");
    }
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
