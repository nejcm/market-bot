import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listRunSummaries,
  readAlphaLeadCohorts,
  readCalibrationSummary,
  readProviderHealth,
  readRunDetail,
  readRunFile,
  searchRunReports,
} from "../app/artifacts";
import {
  deepEquityEvidenceBundle,
  marketSnapshot,
  researchReport,
  valuationWorkbench,
  verifiedMarketSnapshot,
} from "./support/fixtures";
import { deriveFundamentalHistory } from "../src/sources/extended-evidence/fundamental-history";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import { derivePeerImpliedRange } from "../src/sources/extended-evidence/valuation-comps";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";
import { predictionTargetHealth } from "../app/report-artifact-view";
import { buildRunWorkspaceView } from "../app/client/run-workspace-view";

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("research console app artifacts", () => {
  test("reads typed Failed Run Artifact diagnostics", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "failed-run");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, RUN_ARTIFACT_FILES.failure), {
      schemaVersion: 1,
      runId: "failed-run",
      generatedAt: "2026-08-26T04:00:00.000Z",
      failedAt: "2026-08-26T04:01:00.000Z",
      phase: "final-synthesis",
      message: "Report failed validation after 4 final-synthesis call(s)",
      reportValidationErrors: ["Unsafe language: buy"],
      predictionErrors: ["Prediction shape invalid"],
      totalCalls: 4,
      reportRepairReprompts: 3,
      languageViolations: [{ field: "summary", match: "buy" }],
      evidenceQuality: {
        version: 1,
        rubricVersion: 3,
        label: "low",
        checks: [
          {
            capability: "financial-core",
            evidenceClass: "core",
            coverage: "fail",
            freshness: "pass",
            corroboration: "not-applicable",
            passed: false,
            reasons: ["coverage missing"],
          },
        ],
        limitingReasons: ["financial-core"],
        advisoryReasons: [],
      },
      cost: { tokenEstimate: 12_345, costEstimateUsd: 1.25 },
    });

    const detail = await readRunDetail(dataDir, "failed-run");

    expect(detail?.failure).toMatchObject({
      message: "Report failed validation after 4 final-synthesis call(s)",
      totalCalls: 4,
      reportRepairReprompts: 3,
      languageViolations: [{ field: "summary", match: "buy" }],
      evidenceQuality: { label: "low", limitingReasons: ["financial-core"] },
      cost: { tokenEstimate: 12_345, costEstimateUsd: 1.25 },
    });
    expect(detail?.summary.availableFiles).toContain(RUN_ARTIFACT_FILES.failure);
    expect(detail?.report).toBeUndefined();
  });

  test("keeps the Failed Run Artifact marker when diagnostics are malformed", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "failed-malformed");
    mkdirSync(runDir, { recursive: true });
    writeJson(join(runDir, RUN_ARTIFACT_FILES.failure), { schemaVersion: 2 });

    const detail = await readRunDetail(dataDir, "failed-malformed");

    expect(detail?.summary.availableFiles).toContain(RUN_ARTIFACT_FILES.failure);
    expect(detail?.failure).toBeUndefined();
    expect(detail?.report).toBeUndefined();
  });

  test("projects deep-equity detail evidence from the bundle", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "deep-detail");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    const snapshot = marketSnapshot({ sourceId: "bundle-market", price: 123 });
    const base = deepEquityEvidenceBundle();
    writeJson(
      join(runDir, RUN_ARTIFACT_FILES.report),
      researchReport({
        runId: "deep-detail",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        extras: { depth: "deep" },
      }),
    );
    writeJson(
      join(runDir, RUN_ARTIFACT_FILES.evidenceBundle),
      deepEquityEvidenceBundle({
        evidence: {
          ...base.evidence,
          marketSnapshots: [snapshot],
          verifiedMarketSnapshot: verifiedMarketSnapshot(),
        },
        governance: {
          ...base.governance,
          sourceLedger: {
            version: 2,
            generatedAt: "2026-05-19T00:00:00.000Z",
            sources: [
              {
                id: snapshot.sourceId,
                kind: "market-data",
                lane: "market-data",
                posture: "covered",
                relatedGapIds: [],
                observedAt: snapshot.observedAt,
              },
            ],
          },
        },
      }),
    );
    writeJson(join(runDir, RUN_ARTIFACT_FILES.marketSnapshots), [
      marketSnapshot({ sourceId: "legacy-market", price: 999 }),
    ]);

    const detail = await readRunDetail(dataDir, "deep-detail");

    expect(detail?.marketSnapshots?.[0]?.price).toBe(123);
    expect(detail?.verifiedMarketSnapshot?.symbol).toBe("AAPL");
  });

  test("projects canonical statements while tolerating historical runs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const canonicalDir = join(dataDir, "canonical");
    const historicalDir = join(dataDir, "historical");
    mkdirSync(join(canonicalDir, "normalized"), { recursive: true });
    mkdirSync(historicalDir, { recursive: true });
    const artifact = deriveFinancialStatements(
      {},
      {
        symbol: "AAPL",
        generatedAt: "2026-06-01T00:00:00.000Z",
        analysisAsOf: "2026-06-01T00:00:00.000Z",
        sourceId: "extended-sec-edgar-aapl-fundamentals",
      },
    );
    writeJson(join(canonicalDir, "report.json"), researchReport({ runId: "canonical" }));
    writeJson(join(canonicalDir, "normalized", "financial-statements.json"), artifact);
    writeJson(join(historicalDir, "report.json"), researchReport({ runId: "historical" }));

    const canonical = await readRunDetail(dataDir, "canonical");
    const historical = await readRunDetail(dataDir, "historical");

    expect(canonical?.financialStatements).toEqual({
      ...artifact,
      readDiagnostics: { droppedObservationCount: 0, drops: [] },
    });
    expect(historical?.financialStatements).toBeUndefined();
  });

  test("shows artifact observation drops through the existing Console gap surface", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "partial-artifact");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    const workbench = valuationWorkbench();
    const [unreadable, ...readable] = workbench.historicalMultiples.observations;
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "partial-artifact",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        extras: { depth: "brief" },
      }),
    );
    writeJson(join(runDir, "normalized", "valuation-workbench.json"), {
      ...workbench,
      historicalMultiples: {
        ...workbench.historicalMultiples,
        observations: [{ ...unreadable, basis: "retired" }, ...readable],
      },
    });

    const detail = await readRunDetail(dataDir, "partial-artifact");

    expect(detail?.report?.dataGaps).toContain(
      "Artifact observations unavailable: 1 observation dropped (valuationWorkbench.historicalMultiples.observations.invalid: 1).",
    );
    expect(
      detail === undefined
        ? undefined
        : buildRunWorkspaceView(detail).equityPresentation?.defaultView.materialGaps,
    ).toContain(
      "Artifact observations unavailable: 1 observation dropped (valuationWorkbench.historicalMultiples.observations.invalid: 1).",
    );
  });

  test("normalizes legacy prediction shortfalls on the Console read path", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "legacy-shortfall");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "legacy-shortfall",
        dataGaps: ["predictionShortfall: emitted 0 of 3", "Missing provider evidence"],
      }),
    );

    const detail = await readRunDetail(dataDir, "legacy-shortfall");

    expect(detail?.report?.predictionShortfall).toEqual({
      emittedCount: 0,
      targetCount: 3,
      missingCount: 3,
    });
    expect(detail?.report?.dataGaps).toEqual(["Missing provider evidence"]);
  });

  test("prefers post-prune analytics health over a reconstructed legacy shortfall", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "legacy-stale-shortfall");
    mkdirSync(runDir, { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "legacy-stale-shortfall",
        dataGaps: ["predictionShortfall: emitted 5 of 6"],
      }),
    );
    writeJson(join(runDir, "analytics.json"), {
      predictions: { count: 4, targetCount: 6, targetMet: false },
    });

    const detail = await readRunDetail(dataDir, "legacy-stale-shortfall");

    expect(detail?.report?.predictionShortfall).toEqual({
      emittedCount: 5,
      targetCount: 6,
      missingCount: 1,
    });
    expect(predictionTargetHealth(detail?.analytics, detail?.report)).toEqual({
      count: 4,
      target: 6,
      targetMet: false,
    });
  });

  test("indexes run summaries from report artifacts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-a");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-a",
        generatedAt: "2026-06-01T00:00:00.000Z",
        keyFindings: [{ text: "Finding", sourceIds: ["s1"] }],
        predictions: [
          {
            id: "p1",
            claim: "SPY closes higher.",
            kind: "direction",
            subject: "SPY",
            measurableAs: "close(SPY, +5) > close(SPY, 0)",
            horizonTradingDays: 5,
            probability: 0.6,
            sourceIds: ["s1"],
          },
        ],
        sources: [
          { id: "s1", title: "Source", fetchedAt: "2026-06-01T00:00:00.000Z", kind: "news" },
        ],
        dataGaps: ["Missing provider"],
        extras: { depth: "deep" },
      }),
    );
    writeFileSync(join(runDir, "report.md"), "# Report\n", "utf8");
    writeJson(join(runDir, "score.json"), { scores: [] });
    writeJson(join(runDir, "normalized", "source-gaps.json"), []);

    await expect(listRunSummaries(dataDir)).resolves.toEqual([
      {
        runId: "run-a",
        generatedAt: "2026-06-01T00:00:00.000Z",
        jobType: "daily",
        assetClass: "equity",
        depth: "deep",
        confidence: "medium",
        findingCount: 1,
        predictionCount: 1,
        sourceCount: 1,
        dataGapCount: 1,
        hasScore: true,
        availableFiles: ["normalized/source-gaps.json", "report.json", "report.md", "score.json"],
      },
    ]);
  });

  test("tolerates runs with missing or malformed reports", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-b");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "report.json"), "{", "utf8");

    await expect(listRunSummaries(dataDir)).resolves.toEqual([
      {
        runId: "run-b",
        findingCount: 0,
        predictionCount: 0,
        sourceCount: 0,
        dataGapCount: 0,
        hasScore: false,
        availableFiles: ["report.json"],
      },
    ]);
  });

  test("reads structured run detail and markdown fallback", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-c");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    const webSourceId = "web-aapl-12345678";
    const webAnswer = { answer: "Apple sells devices and services.", sourceIds: [webSourceId] };
    writeJson(join(runDir, "report.json"), researchReport({ runId: "run-c", summary: "Summary" }));
    writeFileSync(join(runDir, "report.md"), "# Markdown\n", "utf8");
    writeJson(join(runDir, "analytics.json"), { version: 1 });
    writeJson(join(runDir, "trace.json"), { stages: ["source-collection"] });
    writeJson(join(runDir, "score.json"), { scores: [] });
    writeJson(join(runDir, "miss-autopsy.json"), { version: 1, autopsies: [] });
    writeJson(join(runDir, "normalized", "market-snapshots.json"), [
      {
        sourceId: "market-yahoo-equity-aapl",
        assetClass: "equity",
        symbol: "AAPL",
        price: 211,
        changePercent24h: 1.4,
        volume: 62_000_000,
        observedAt: "2026-06-01T00:00:00.000Z",
      },
    ]);
    writeJson(join(runDir, "normalized", "web-subject-profile.json"), {
      version: 2,
      generatedAt: "2026-06-01T00:00:00.000Z",
      subjectKind: "company",
      subjectId: "AAPL",
      subjectLabel: "Apple Inc.",
      symbol: "AAPL",
      companyName: "Apple Inc.",
      subjectSummary: webAnswer,
      questions: {
        whatItDoes: webAnswer,
        howItMakesMoney: webAnswer,
        customers: webAnswer,
        geography: webAnswer,
        purchaseRecurrence: webAnswer,
        pricingPower: webAnswer,
        recessionCyclicality: webAnswer,
      },
      recentMaterialEvents: [],
      factLedger: [{ claim: "Apple sells devices and services.", sourceIds: [webSourceId] }],
      openGaps: [],
      sourceIds: [webSourceId],
      secFilingBasisDate: "2026-05-01",
    });
    writeJson(
      join(runDir, "normalized", "fundamental-history.json"),
      deriveFundamentalHistory(
        {
          facts: {
            "us-gaap": {
              Revenues: {
                units: {
                  USD: [
                    {
                      val: 100,
                      form: "10-K",
                      fp: "FY",
                      fy: 2025,
                      filed: "2025-11-01",
                      start: "2024-10-01",
                      end: "2025-09-30",
                    },
                  ],
                },
              },
            },
          },
        },
        {
          symbol: "AAPL",
          generatedAt: "2026-06-01T00:00:00.000Z",
          sourceId: "extended-sec-edgar-aapl-fundamentals",
        },
      ),
    );
    writeJson(join(runDir, "normalized", "valuation-comps.json"), {
      version: 1,
      impliedPriceRange: derivePeerImpliedRange({
        supportability: "supported",
        usablePeerCount: 3,
        peerP25EvToAnnualizedRevenue: 1,
        peerMedianEvToAnnualizedRevenue: 2,
        peerP75EvToAnnualizedRevenue: 3,
        annualizedRevenue: 400,
        netDebt: 10,
        sharesOutstanding: 10,
        currentPrice: 79,
        quoteCurrency: "USD",
        quoteObservedAt: "2026-06-01T00:00:00.000Z",
      }),
      unrelatedCompsData: { mustNotBeThreaded: true },
    });

    const detail = await readRunDetail(dataDir, "run-c");

    expect(detail?.summary.runId).toBe("run-c");
    expect(detail?.report?.summary).toBe("Summary");
    expect(detail?.markdown).toBe("# Markdown\n");
    expect(detail?.analytics).toEqual({ version: 1 });
    expect(detail?.trace).toEqual({ stages: ["source-collection"] });
    expect(detail?.score).toEqual({ scores: [] });
    expect(detail?.missAutopsy).toEqual({ version: 1, autopsies: [] });
    expect(detail?.marketSnapshots).toEqual([
      expect.objectContaining({ symbol: "AAPL", price: 211 }),
    ]);
    expect(detail?.webSubjectProfile).toMatchObject({
      subjectKind: "company",
      companyName: "Apple Inc.",
    });
    expect(detail?.fundamentalHistory).toMatchObject({
      version: 1,
      symbol: "AAPL",
      sourceId: "extended-sec-edgar-aapl-fundamentals",
    });
    expect(detail?.peerImpliedRange).toMatchObject({
      status: "derived",
      low: 39,
      mid: 79,
      high: 119,
      position: "within-range",
    });
    expect(detail).not.toHaveProperty("valuationComps");
  });

  test("reads run files inside the run directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-d");
    mkdirSync(join(runDir, "normalized"), { recursive: true });
    writeFileSync(join(runDir, "normalized", "source-gaps.json"), "[]\n", "utf8");

    await expect(readRunFile(dataDir, "run-d", "normalized/source-gaps.json")).resolves.toEqual({
      path: "normalized/source-gaps.json",
      content: "[]\n",
    });
  });

  test("rejects unsafe run ids and file paths", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-e");
    mkdirSync(runDir, { recursive: true });

    await expect(readRunDetail(dataDir, "../secret")).resolves.toBeUndefined();
    await expect(readRunDetail(dataDir, ".")).resolves.toBeUndefined();
    await expect(readRunFile(dataDir, "run-e", "../secret.txt")).resolves.toBeUndefined();
    await expect(readRunFile(dataDir, "run-e", "")).resolves.toBeUndefined();
  });

  test("rejects oversized run files", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-f");
    mkdirSync(runDir);
    writeFileSync(join(runDir, "large.txt"), "x".repeat(5_000_001), "utf8");

    await expect(readRunFile(dataDir, "run-f", "large.txt")).resolves.toBeUndefined();
  });

  test("reads provider health sibling artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "research-console-data-"));
    const dataDir = join(rootDir, "runs");
    const healthDir = join(rootDir, "provider-health");
    mkdirSync(dataDir);
    mkdirSync(healthDir);
    writeJson(join(healthDir, "summary.json"), { verdict: "pass" });
    writeFileSync(join(healthDir, "summary.md"), "# Provider Health\n", "utf8");

    await expect(readProviderHealth(dataDir)).resolves.toEqual({
      summary: { verdict: "pass" },
      markdown: "# Provider Health\n",
    });
  });

  test("reads calibration sibling artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "research-console-data-"));
    const dataDir = join(rootDir, "runs");
    const calibrationDir = join(rootDir, "calibration");
    mkdirSync(dataDir);
    mkdirSync(calibrationDir);
    writeJson(join(calibrationDir, "summary.json"), { resolvedCount: 13, brierScore: 0.2583 });
    writeFileSync(join(calibrationDir, "summary.md"), "# Calibration\n", "utf8");

    await expect(readCalibrationSummary(dataDir)).resolves.toEqual({
      summary: { resolvedCount: 13, brierScore: 0.2583 },
      markdown: "# Calibration\n",
    });
  });

  test("strips zero headline metrics from a calibration summary stored before the invariant", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "research-console-data-"));
    const dataDir = join(rootDir, "runs");
    const calibrationDir = join(rootDir, "calibration");
    mkdirSync(dataDir);
    mkdirSync(calibrationDir);
    writeJson(join(calibrationDir, "summary.json"), {
      generatedAt: "2026-09-01T00:00:00.000Z",
      resolvedCount: 0,
      hitRate: 0,
      brierScore: 0,
      brierSkillScore: 1,
      bins: [],
      missAutopsyCount: 0,
    });
    writeFileSync(
      join(calibrationDir, "summary.md"),
      [
        "# Calibration Summary",
        "",
        "Resolved predictions: 0",
        "",
        "Overall Brier score: 0.0000",
        "",
        "Overall hit rate: 0.0%",
        "",
        "Brier skill vs always-0.5 baseline: 1.0000 (0 = no edge, 1 = perfect, <0 = worse than a coin flip)",
        "",
        "_No populated bins yet._",
      ].join("\n"),
      "utf8",
    );

    const detail = await readCalibrationSummary(dataDir);

    expect(detail.summary).toEqual({
      generatedAt: "2026-09-01T00:00:00.000Z",
      resolvedCount: 0,
      bins: [],
      missAutopsyCount: 0,
    });
    // The stale rendering must not serve 0.0000 beside a normalized summary.
    expect(detail.markdown).toContain(
      "Overall Brier score: not yet measured (no resolved Predictions)",
    );
    expect(detail.markdown).toContain(
      "Overall hit rate: not yet measured (no resolved Predictions)",
    );
    expect(detail.markdown).toContain(
      "Brier skill vs always-0.5 baseline: not yet measured (no resolved Predictions)",
    );
    expect(detail.markdown).not.toContain("0.0000");
    expect(detail.markdown).not.toContain("0.0%");
    // The legacy legend goes with the number: "1 = perfect" is the misleading half.
    expect(detail.markdown).not.toContain("1 = perfect");
    expect(detail.markdown).not.toContain("1.0000");
    // Everything outside the two headline lines survives verbatim.
    expect(detail.markdown).toContain("Resolved predictions: 0");
    expect(detail.markdown).toContain("_No populated bins yet._");
  });

  test("keeps a measured zero hit rate when predictions have resolved", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "research-console-data-"));
    const dataDir = join(rootDir, "runs");
    const calibrationDir = join(rootDir, "calibration");
    mkdirSync(dataDir);
    mkdirSync(calibrationDir);
    writeJson(join(calibrationDir, "summary.json"), {
      resolvedCount: 1,
      hitRate: 0,
      brierScore: 0.64,
      brierSkillScore: -1.56,
    });
    const markdown = [
      "Overall Brier score: 0.6400",
      "",
      "Overall hit rate: 0.0%",
      "",
      "Brier skill vs always-0.5 baseline: -1.5600 (0 = no edge, 1 = perfect, <0 = worse than a coin flip)",
    ].join("\n");
    writeFileSync(join(calibrationDir, "summary.md"), markdown, "utf8");

    // A forecaster measured once and right zero times keeps every stored value.
    await expect(readCalibrationSummary(dataDir)).resolves.toEqual({
      summary: { resolvedCount: 1, hitRate: 0, brierScore: 0.64, brierSkillScore: -1.56 },
      markdown,
    });
  });

  test("reads alpha cohort sibling artifacts", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "research-console-data-"));
    const dataDir = join(rootDir, "runs");
    const alphaDir = join(rootDir, "alpha-search");
    mkdirSync(dataDir);
    mkdirSync(alphaDir);
    writeJson(join(alphaDir, "cohorts.json"), { rejectedCandidateCount: 2 });
    writeFileSync(join(alphaDir, "cohorts.md"), "# Alpha Lead Cohorts\n", "utf8");

    await expect(readAlphaLeadCohorts(dataDir)).resolves.toEqual({
      summary: { rejectedCandidateCount: 2 },
      markdown: "# Alpha Lead Cohorts\n",
    });
  });

  test("returns empty calibration detail when artifacts are absent", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));

    await expect(readCalibrationSummary(dataDir)).resolves.toEqual({});
  });

  test("searches structured report sections", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-g");
    mkdirSync(runDir);
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-g",
        summary: "needle summary",
        keyFindings: [{ text: "needle finding", sourceIds: ["s1"] }],
        predictions: [
          {
            id: "p1",
            claim: "needle forecast",
            kind: "direction",
            subject: "SPY",
            measurableAs: "close(SPY, +5) > close(SPY, 0)",
            horizonTradingDays: 5,
            probability: 0.6,
            sourceIds: ["s2"],
          },
        ],
        sources: [
          {
            id: "s3",
            title: "needle source",
            fetchedAt: "2026-06-01T00:00:00.000Z",
            kind: "news",
          },
        ],
        dataGaps: ["needle gap"],
      }),
    );

    const results = await searchRunReports(dataDir, { query: "needle" });

    expect(results.map((result) => result.section)).toEqual([
      "summary",
      "keyFindings",
      "sources",
      "dataGaps",
    ]);
    expect(results.map((result) => result.sourceIds)).toEqual([[], ["s1"], ["s3"], []]);

    const predictionResults = await searchRunReports(dataDir, { query: "SPY closes higher" });
    expect(predictionResults.map((result) => result.section)).toEqual(["predictions"]);
    expect(predictionResults.map((result) => result.sourceIds)).toEqual([["s2"]]);
  });

  test("searches extended evidence sections", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-valuation");
    mkdirSync(runDir);
    writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-valuation",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        summary: "summary",
        extendedEvidence: {
          instrument: { symbol: "AAPL", assetClass: "equity" },
          items: [
            {
              category: "valuation",
              title: "AAPL Valuation Evidence",
              summary: "needle valuation EV/annualized revenue 12.3x",
              sourceIds: ["extended-valuation-aapl"],
              observedAt: "2026-06-01T00:00:00.000Z",
            },
          ],
          gaps: [],
        },
      }),
    );

    const results = await searchRunReports(dataDir, { query: "needle valuation" });
    expect(results.map((result) => result.section)).toEqual(["extendedEvidence"]);
    expect(results[0]?.sourceIds).toEqual(["extended-valuation-aapl"]);
  });

  test("filters structured report search by run metadata", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const equityDir = join(dataDir, "run-h");
    const cryptoDir = join(dataDir, "run-i");
    mkdirSync(equityDir);
    mkdirSync(cryptoDir);
    writeJson(
      join(equityDir, "report.json"),
      researchReport({
        runId: "run-h",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-06-01T00:00:00.000Z",
        summary: "needle equity",
      }),
    );
    writeJson(
      join(cryptoDir, "report.json"),
      researchReport({
        runId: "run-i",
        jobType: "daily",
        assetClass: "crypto",
        generatedAt: "2026-05-01T00:00:00.000Z",
        summary: "needle crypto",
      }),
    );

    const results = await searchRunReports(dataDir, {
      query: "needle",
      symbol: "aapl",
      assetClass: "equity",
      jobType: "equity",
      from: "2026-06-01",
      to: "2026-06-01",
    });

    expect(results.map((result) => result.run.runId)).toEqual(["run-h"]);
  });

  test("excludes undated reports when date filters are present", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-undated");
    mkdirSync(runDir);
    const report = {
      ...researchReport({
        runId: "run-undated",
        summary: "needle undated",
      }),
      generatedAt: undefined,
    };
    writeJson(join(runDir, "report.json"), report);

    await expect(searchRunReports(dataDir, { query: "needle", to: "2026-06-01" })).resolves.toEqual(
      [],
    );
    await expect(
      searchRunReports(dataDir, { query: "needle", from: "2026-06-01" }),
    ).resolves.toEqual([]);
  });

  test("ignores malformed reports during structured search", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "research-console-runs-"));
    const runDir = join(dataDir, "run-j");
    mkdirSync(runDir);
    writeFileSync(join(runDir, "report.json"), "{", "utf8");

    await expect(searchRunReports(dataDir, { query: "needle" })).resolves.toEqual([]);
  });
});
