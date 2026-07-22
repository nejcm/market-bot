import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  loadRunArtifact,
  scanRunArtifacts,
  scanWebSubjectProfileRunArtifacts,
} from "../src/run-artifacts";
import { deriveFundamentalHistory } from "../src/sources/extended-evidence/fundamental-history";
import { deriveFinancialStatements } from "../src/sources/extended-evidence/financial-statements";
import {
  marketSnapshot,
  prediction,
  predictionScore,
  researchReport,
  verifiedMarketSnapshot,
} from "./support/fixtures";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tempRunsDir(): string {
  const dir = join(
    tmpdir(),
    `market-bot-run-artifacts-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "runs",
  );
  tmpDirs.push(dirname(dir));
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function webSubjectProfile(symbol: string): unknown {
  const sourceId = `web-${symbol.toLowerCase()}-12345678`;
  const answer = { answer: `${symbol} business profile.`, sourceIds: [sourceId] };
  return {
    version: 2,
    generatedAt: "2026-05-19T00:00:00.000Z",
    subjectKind: "company",
    subjectId: symbol,
    subjectLabel: `${symbol} Inc.`,
    symbol,
    companyName: `${symbol} Inc.`,
    subjectSummary: answer,
    questions: {
      whatItDoes: answer,
      howItMakesMoney: answer,
      customers: answer,
      geography: answer,
      purchaseRecurrence: answer,
      pricingPower: answer,
      recessionCyclicality: answer,
    },
    recentMaterialEvents: [],
    factLedger: [{ claim: `${symbol} sells products.`, sourceIds: [sourceId] }],
    openGaps: [],
    sourceIds: [sourceId],
    secFilingBasisDate: "2026-05-01",
  };
}

describe("loadRunArtifact", () => {
  test("round-trips canonical statements and equity completeness", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "canonical-financials");
    const sourceId = "extended-sec-edgar-fpi-fundamentals";
    const financialStatements = deriveFinancialStatements(
      {
        facts: {
          "ifrs-full": {
            Revenue: {
              units: {
                USD: [
                  {
                    val: 100,
                    form: "20-F",
                    fp: "FY",
                    fy: 2025,
                    filed: "2026-03-01",
                    start: "2025-01-01",
                    end: "2025-12-31",
                  },
                ],
              },
            },
          },
        },
      },
      {
        symbol: "FPI",
        generatedAt: "2026-06-01T00:00:00.000Z",
        analysisAsOf: "2026-06-01T00:00:00.000Z",
        sourceId,
      },
    );
    const dimension = {
      status: "partial" as const,
      reasonCodes: ["fixture-partial"],
      asOf: "2026-06-01T00:00:00.000Z",
      sourceIds: [sourceId],
    };
    const equityAnalysisCompleteness = {
      version: 1 as const,
      financialCoreStatus: "partial" as const,
      coverageLevel: "limited" as const,
      asOf: "2026-06-01T00:00:00.000Z",
      dimensions: {
        primaryFinancials: dimension,
        valuation: dimension,
        expectations: dimension,
        capitalOwnership: dimension,
        operatingKpis: dimension,
      },
    };
    await writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "canonical-financials",
        jobType: "equity",
        symbol: "FPI",
        sources: [
          {
            id: sourceId,
            title: "FPI canonical statements",
            fetchedAt: "2026-06-01T00:00:00.000Z",
            kind: "market-data",
          },
        ],
        equityAnalysisCompleteness,
      }),
    );
    await writeJson(join(runDir, "normalized", "financial-statements.json"), financialStatements);

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.financialStatements).toEqual(financialStatements);
    expect(artifact?.report.equityAnalysisCompleteness).toEqual(equityAnalysisCompleteness);
  });

  test("keeps historical reports readable without Phase 2 fields", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "historical-report");
    await writeJson(join(runDir, "report.json"), researchReport({ runId: "historical-report" }));

    const { artifact, status } = await loadRunArtifact(runDir);

    expect(status.report).toBe("ok");
    expect(artifact?.report.equityAnalysisCompleteness).toBeUndefined();
    expect(artifact?.financialStatements).toBeUndefined();
  });

  test("round-trips a validated fundamental-history sidecar", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "fundamental-history");
    const fundamentalHistory = deriveFundamentalHistory(
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
                    fy: 2024,
                    filed: "2024-11-01",
                    start: "2023-10-01",
                    end: "2024-09-30",
                  },
                ],
              },
            },
          },
        },
      },
      {
        symbol: "AAPL",
        generatedAt: "2025-08-01T00:00:00.000Z",
        analysisAsOf: "2025-08-01T00:00:00.000Z",
        sourceId: "extended-sec-edgar-aapl-fundamentals",
      },
    );
    await writeJson(join(runDir, "report.json"), researchReport({ runId: "fundamental-history" }));
    await writeJson(join(runDir, "normalized", "fundamental-history.json"), fundamentalHistory);

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.fundamentalHistory).toEqual(fundamentalHistory);
  });

  test("loads report, scores, and snapshots at full fidelity", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "run-ok");
    await writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-ok",
        symbol: "aapl",
        sources: [
          { id: "news-1", title: "Headline", fetchedAt: "2026-05-19T00:00:00.000Z", kind: "news" },
        ],
        predictions: [
          prediction({ id: "p-vol", kind: "volatility", subject: "AAPL" }),
          prediction({ id: "p-dir", kind: "direction", subject: "AAPL" }),
        ],
      }),
    );
    await writeJson(join(runDir, "score.json"), {
      runId: "run-ok",
      scores: [predictionScore("hit", { predictionId: "p-vol", runId: "run-ok" })],
    });
    await writeJson(join(runDir, "miss-autopsy.json"), {
      version: 1,
      runId: "run-ok",
      generatedAt: "2026-05-20T00:00:00.000Z",
      autopsies: [
        {
          predictionId: "p-dir",
          runId: "run-ok",
          observedAt: "2026-05-20T00:00:00.000Z",
          scoreOutcome: "miss",
          probability: 0.8,
          forecastError: "overpredicted",
          cause: "model_overconfidence",
          rationale: "Material forecast error where the stated probability was extreme.",
          supportingSignals: ["forecast probability was extreme"],
          evidence: { close0: 100, closeN: 90 },
        },
      ],
    });
    await writeJson(join(runDir, "normalized", "market-snapshots.json"), [
      marketSnapshot({
        symbol: "AAPL",
        price: 200,
        benchmark: {
          sourceId: "bench-spy",
          symbol: "SPY",
          basis: "broad-index",
          changePercent24h: 1.2,
          observedAt: "2026-05-19T00:00:00.000Z",
        },
      }),
    ]);

    const { artifact, status } = await loadRunArtifact(runDir);

    expect(status).toEqual({ report: "ok", score: "ok" });
    expect(artifact?.runDirName).toBe("run-ok");
    // Full fidelity: sources are kept and the real prediction kind survives.
    expect(artifact?.report.sources.map((source) => source.id)).toEqual(["news-1"]);
    expect(artifact?.report.predictions.map((p) => p.kind)).toEqual(["volatility", "direction"]);
    expect(artifact?.report.symbol).toBe("AAPL");
    expect(artifact?.scores).toHaveLength(1);
    expect(artifact?.missAutopsies).toHaveLength(1);
    expect(artifact?.missAutopsies[0]?.cause).toBe("model_overconfidence");
    expect(artifact?.marketSnapshots[0]?.benchmark?.symbol).toBe("SPY");
  });

  test("keeps persisted scoringPolicyVersion 3 and degrades unknown versions to absent", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "run-policy");
    await writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "run-policy",
        predictions: [
          prediction({ id: "p-v3", scoringPolicyVersion: 3 }),
          { ...prediction({ id: "p-unknown" }), scoringPolicyVersion: 99 } as never,
          prediction({ id: "p-legacy" }),
        ],
      }),
    );

    const { artifact, status } = await loadRunArtifact(runDir);

    expect(status.report).toBe("ok");
    const byId = new Map(artifact?.report.predictions.map((p) => [p.id, p.scoringPolicyVersion]));
    expect(byId.get("p-v3")).toBe(3);
    // Unknown persisted versions must not survive: they resolve under policy v2.
    expect(byId.get("p-unknown")).toBeUndefined();
    expect(byId.get("p-legacy")).toBeUndefined();
  });

  test("loads historical reports without report-integrity fields and keeps stamped ones", async () => {
    const dataDir = tempRunsDir();
    const legacyDir = join(dataDir, "run-legacy");
    await writeJson(join(legacyDir, "report.json"), researchReport({ runId: "run-legacy" }));
    const stampedDir = join(dataDir, "run-stamped");
    await writeJson(
      join(stampedDir, "report.json"),
      researchReport({
        runId: "run-stamped",
        reportIntegrity: "medium",
        researchQuality: "low",
        researchQualityDriver: "news evidence missing; remediation: rerun",
      }),
    );

    const legacy = await loadRunArtifact(legacyDir);
    const stamped = await loadRunArtifact(stampedDir);

    expect(legacy.status.report).toBe("ok");
    expect(legacy.artifact?.report.reportIntegrity).toBeUndefined();
    expect(legacy.artifact?.report.researchQuality).toBeUndefined();
    expect(stamped.artifact?.report.reportIntegrity).toBe("medium");
    expect(stamped.artifact?.report.researchQuality).toBe("low");
    expect(stamped.artifact?.report.researchQualityDriver).toBe(
      "news evidence missing; remediation: rerun",
    );
  });

  test("loads verified market snapshot through the run artifact seam", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "verified");
    await writeJson(join(runDir, "report.json"), researchReport({ runId: "verified" }));
    await writeJson(join(runDir, "normalized", "verified-market-snapshot.json"), {
      symbol: "aapl",
      assetClass: "equity",
      analysisDate: "2026-05-19",
      fetchedAt: "2026-05-19T00:00:00.000Z",
      latestSessionDate: "2026-05-18",
      ohlcv: {
        date: "2026-05-18",
        open: 100,
        high: 110,
        low: 99,
        close: 108,
        volume: 123,
      },
      indicators: {
        ema10: 101,
        sma50: 102,
        sma200: null,
        rsi14: 55,
        macd: 1,
        macdSignal: 0.5,
        macdHistogram: 0.5,
        bollUpper: 120,
        bollMiddle: 100,
        bollLower: 80,
        atr14: 3,
      },
      recentCloses: [
        { date: "2026-05-15", close: 105 },
        { date: "2026-05-18", close: 108 },
      ],
    });

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.verifiedMarketSnapshot?.symbol).toBe("AAPL");
    expect(artifact?.verifiedMarketSnapshot?.recentCloses).toEqual([
      { date: "2026-05-15", close: 105 },
      { date: "2026-05-18", close: 108 },
    ]);
  });

  test("loads business framework sidecar through the run artifact seam", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "business-framework");
    await writeJson(join(runDir, "report.json"), researchReport({ runId: "business-framework" }));
    await writeJson(join(runDir, "normalized", "business-framework.json"), {
      version: 1,
      generatedAt: "2026-05-19T00:00:00.000Z",
      symbol: "AAPL",
      phase: "capital-return",
      sections: [
        {
          name: "Business",
          posture: "criteria-supported",
          summary: "Business criteria-supported.",
          metrics: [
            {
              key: "revenue",
              label: "Revenue",
              value: 100,
              unit: "currency",
              sourceIds: ["market-aapl"],
            },
          ],
          sourceIds: ["market-aapl"],
          gaps: ["Segment mix unavailable"],
        },
      ],
      sourceIds: ["market-aapl"],
      gaps: ["Management evidence unavailable"],
    });

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.businessFramework?.phase).toBe("capital-return");
    expect(artifact?.businessFramework?.sections[0]?.name).toBe("Business");
  });

  test("loads verified representative snapshots from sidecar", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "research-reps");
    const snapshot = verifiedMarketSnapshot({ symbol: "AMGN" });
    await writeJson(
      join(runDir, "report.json"),
      researchReport({ runId: "research-reps", jobType: "research" }),
    );
    await writeJson(join(runDir, "normalized", "verified-representative-snapshots.json"), [
      snapshot,
    ]);

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.verifiedRepresentativeSnapshots?.map((item) => item.symbol)).toEqual(["AMGN"]);
  });

  test("loads verified representative snapshots from report fallback", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "research-reps-report");
    await writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "research-reps-report",
        jobType: "research",
        verifiedRepresentativeSnapshots: [verifiedMarketSnapshot({ symbol: "GILD" })],
      }),
    );

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.verifiedRepresentativeSnapshots?.map((item) => item.symbol)).toEqual(["GILD"]);
  });

  test("loads theme catalysts from sidecar", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "research-theme-catalysts");
    await writeJson(
      join(runDir, "report.json"),
      researchReport({ runId: "research-theme-catalysts", jobType: "research" }),
    );
    await writeJson(join(runDir, "normalized", "theme-catalysts.json"), [
      {
        date: "2026-11-01",
        label: "PDUFA decision expected 2026-11-01.",
        sourceIds: ["web-biotech"],
        sourceStatus: "sourced catalyst",
        researchRelevance: "watch item",
      },
      { sourceIds: ["web-biotech"] },
    ]);

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.themeCatalysts).toEqual([
      {
        date: "2026-11-01",
        label: "PDUFA decision expected 2026-11-01.",
        sourceIds: ["web-biotech"],
        sourceStatus: "sourced catalyst",
        researchRelevance: "watch item",
      },
    ]);
  });

  test("loads current business framework v2 atomic gaps", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "business-framework-v2");
    await writeJson(
      join(runDir, "report.json"),
      researchReport({ runId: "business-framework-v2" }),
    );
    await writeJson(join(runDir, "normalized", "business-framework.json"), {
      version: 2,
      generatedAt: "2026-05-19T00:00:00.000Z",
      symbol: "AAPL",
      phase: "capital-return",
      sections: [
        {
          name: "Business",
          posture: "insufficient-data",
          summary: "Business evidence incomplete.",
          metrics: [],
          sourceIds: [],
          gaps: [{ code: "pricing-power", text: "Pricing power unavailable" }],
        },
      ],
      sourceIds: [],
      gaps: [{ code: "cyclicality", text: "Cyclicality unavailable" }],
    });

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.businessFramework?.version).toBe(2);
    expect(artifact?.businessFramework?.gaps).toEqual([
      { code: "cyclicality", text: "Cyclicality unavailable" },
    ]);
  });

  test("loads source-plan sidecars through the run artifact seam", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "source-plan");
    await writeJson(join(runDir, "report.json"), researchReport({ runId: "source-plan" }));
    await writeJson(join(runDir, "normalized", "source-plan.json"), {
      version: 1,
      generatedAt: "2026-05-19T00:00:00.000Z",
      run: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      lanes: [
        {
          lane: "market-data",
          requirement: "required",
          appliesToRun: true,
          providerPath: "yahoo equity market data",
        },
      ],
    });
    await writeJson(join(runDir, "normalized", "evidence-lanes.json"), {
      version: 1,
      generatedAt: "2026-05-19T00:00:00.000Z",
      lanes: [
        {
          lane: "market-data",
          status: "covered",
          required: true,
          coveredSourceIds: ["market-yahoo-equity-aapl"],
          gapIds: [],
          gapText: [],
          freshnessNotes: ["latest evidence timestamp 2026-05-19T00:00:00.000Z"],
        },
      ],
      summary: {
        plannedLaneCount: 1,
        requiredLaneCount: 1,
        optionalLaneCount: 0,
        coveredLaneCount: 1,
        gapLaneCount: 0,
        requiredGapLaneCount: 0,
        sourceCount: 1,
        gapCount: 0,
        coverageRatio: 1,
      },
    });
    await writeJson(join(runDir, "normalized", "source-ledger.json"), {
      version: 1,
      generatedAt: "2026-05-19T00:00:00.000Z",
      sources: [
        {
          id: "market-yahoo-equity-aapl",
          kind: "market-data",
          provider: "yahoo",
          observedAt: "2026-05-19T00:00:00.000Z",
          lane: "market-data",
          posture: "covered",
          relatedGapIds: [],
        },
      ],
    });

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.sourcePlan?.lanes[0]?.lane).toBe("market-data");
    expect(artifact?.evidenceLanes?.summary.coverageRatio).toBe(1);
    expect(artifact?.sourceLedger?.sources[0]?.id).toBe("market-yahoo-equity-aapl");
  });

  test("drops source-plan sidecars with invalid headers", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "bad-source-plan-headers");
    await writeJson(
      join(runDir, "report.json"),
      researchReport({ runId: "bad-source-plan-headers" }),
    );
    await writeJson(join(runDir, "normalized", "source-plan.json"), {
      version: 1,
      generatedAt: 42,
      run: { jobType: "equity", assetClass: "equity", symbol: 42, depth: "deep" },
      lanes: [
        {
          lane: "market-data",
          requirement: "required",
          appliesToRun: true,
          providerPath: "yahoo equity market data",
        },
      ],
    });
    await writeJson(join(runDir, "normalized", "evidence-lanes.json"), {
      version: 1,
      generatedAt: 42,
      lanes: [
        {
          lane: "market-data",
          status: "covered",
          required: true,
          coveredSourceIds: ["market-yahoo-equity-aapl"],
          gapIds: [],
          gapText: [],
          freshnessNotes: [],
        },
      ],
      summary: {
        plannedLaneCount: 1,
        requiredLaneCount: 1,
        optionalLaneCount: 0,
        coveredLaneCount: 1,
        gapLaneCount: 0,
        requiredGapLaneCount: 0,
        sourceCount: 1,
        gapCount: 0,
        coverageRatio: 1,
      },
    });
    await writeJson(join(runDir, "normalized", "source-ledger.json"), {
      version: 1,
      sources: [
        {
          id: "market-yahoo-equity-aapl",
          kind: "market-data",
          provider: "yahoo",
          observedAt: "2026-05-19T00:00:00.000Z",
          lane: "market-data",
          posture: "covered",
          relatedGapIds: [],
        },
      ],
    });

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.sourcePlan).toBeUndefined();
    expect(artifact?.evidenceLanes).toBeUndefined();
    expect(artifact?.sourceLedger).toBeUndefined();
  });

  test("drops malformed source-plan sidecars at the run artifact seam", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "bad-source-plan");
    await writeJson(join(runDir, "report.json"), researchReport({ runId: "bad-source-plan" }));
    await writeJson(join(runDir, "normalized", "source-plan.json"), {
      version: 1,
      generatedAt: "2026-05-19T00:00:00.000Z",
      run: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      lanes: [{ lane: "not-real", requirement: "required", appliesToRun: true, providerPath: "x" }],
    });
    await writeJson(join(runDir, "normalized", "evidence-lanes.json"), {
      version: 1,
      generatedAt: "2026-05-19T00:00:00.000Z",
      lanes: [{ lane: "market-data", status: "covered", required: true }],
      summary: {
        plannedLaneCount: Number.NaN,
        requiredLaneCount: 1,
        optionalLaneCount: 0,
        coveredLaneCount: 1,
        gapLaneCount: 0,
        requiredGapLaneCount: 0,
        sourceCount: 1,
        gapCount: 0,
        coverageRatio: 1,
      },
    });
    await writeJson(join(runDir, "normalized", "source-ledger.json"), {
      version: 1,
      generatedAt: "2026-05-19T00:00:00.000Z",
      sources: [{ id: "market-yahoo-equity-aapl", kind: "market-data", lane: "bogus" }],
    });

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.sourcePlan).toBeUndefined();
    expect(artifact?.evidenceLanes).toBeUndefined();
    expect(artifact?.sourceLedger).toBeUndefined();
  });

  test("preserves extended evidence identities and source gap metadata", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "extended-evidence");
    await writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "extended-evidence",
        extendedEvidence: {
          instrument: {
            symbol: "aapl",
            assetClass: "equity",
            identity: {
              exchange: "NASDAQ",
              quoteCurrency: "USD",
              displayName: "Apple Inc.",
              providerIds: [{ provider: "sec", idKind: "cik", value: "0000320193" }],
              aliases: [{ provider: "yahoo", idKind: "ticker", value: "AAPL" }],
            },
          },
          items: [
            {
              category: "sec-edgar",
              title: "Latest filing",
              summary: "10-Q filing summary",
              sourceIds: ["sec-aapl-10q"],
              observedAt: "2026-05-19T00:00:00.000Z",
              identity: { displayName: "Apple Inc.", exchange: "NASDAQ" },
            },
          ],
          gaps: [
            {
              source: "tradier-options",
              message: "No options data available",
              provider: "tradier",
              capability: "extended-evidence",
              cause: "provider-data-missing",
              evidenceQualityImpact: "extended-evidence-cap",
            },
          ],
        },
      }),
    );

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.report.extendedEvidence?.instrument?.identity).toEqual({
      exchange: "NASDAQ",
      quoteCurrency: "USD",
      displayName: "Apple Inc.",
      providerIds: [{ provider: "sec", idKind: "cik", value: "0000320193" }],
      aliases: [{ provider: "yahoo", idKind: "ticker", value: "AAPL" }],
    });
    expect(artifact?.report.extendedEvidence?.items[0]?.identity).toEqual({
      displayName: "Apple Inc.",
      exchange: "NASDAQ",
    });
    expect(artifact?.report.extendedEvidence?.gaps[0]).toEqual({
      source: "tradier-options",
      message: "No options data available",
      provider: "tradier",
      capability: "extended-evidence",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });
  });

  test("preserves subject-scoped extended evidence without an instrument", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "theme-extended-evidence");
    await writeJson(
      join(runDir, "report.json"),
      researchReport({
        runId: "theme-extended-evidence",
        jobType: "research",
        extendedEvidence: {
          subject: {
            subjectKind: "theme",
            subjectId: "ai-infrastructure-buildout",
            subjectLabel: "AI infrastructure buildout",
          },
          items: [
            {
              category: "web-subject-profile",
              title: "Web Subject Profile",
              summary: "Cited web subject profile captured.",
              sourceIds: ["web-ai-infrastructure-buildout-12345678"],
              observedAt: "2026-05-19T00:00:00.000Z",
            },
          ],
          gaps: [],
        },
      }),
    );

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.report.extendedEvidence?.instrument).toBeUndefined();
    expect(artifact?.report.extendedEvidence?.subject).toEqual({
      subjectKind: "theme",
      subjectId: "ai-infrastructure-buildout",
      subjectLabel: "AI infrastructure buildout",
    });
    expect(artifact?.report.extendedEvidence?.items[0]?.category).toBe("web-subject-profile");
  });

  test("reports an absent report directory (ENOENT) without an artifact", async () => {
    const dataDir = tempRunsDir();
    await mkdir(join(dataDir, "empty"), { recursive: true });

    const { artifact, status } = await loadRunArtifact(join(dataDir, "empty"));

    expect(artifact).toBeUndefined();
    expect(status).toEqual({ report: "absent", score: "absent" });
  });

  test("flags a present-but-broken report as malformed", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "bad-json");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "report.json"), "{not-json", "utf8");

    const { artifact, status } = await loadRunArtifact(runDir);

    expect(artifact).toBeUndefined();
    expect(status.report).toBe("malformed");
  });

  test("flags a well-formed JSON report with the wrong shape as malformed", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "wrong-shape");
    await writeJson(join(runDir, "report.json"), { jobType: "daily" });

    const { status } = await loadRunArtifact(runDir);

    expect(status.report).toBe("malformed");
  });

  test("treats a missing score file as absent and a broken one as malformed", async () => {
    const dataDir = tempRunsDir();

    const noScore = join(dataDir, "no-score");
    await writeJson(join(noScore, "report.json"), researchReport({ runId: "no-score" }));
    const absent = await loadRunArtifact(noScore);
    expect(absent.status).toEqual({ report: "ok", score: "absent" });
    expect(absent.artifact?.scores).toEqual([]);

    const badScore = join(dataDir, "bad-score");
    await writeJson(join(badScore, "report.json"), researchReport({ runId: "bad-score" }));
    await writeFile(join(badScore, "score.json"), "{not-json", "utf8");
    const malformed = await loadRunArtifact(badScore);
    expect(malformed.status).toEqual({ report: "ok", score: "malformed" });
    expect(malformed.artifact?.scores).toEqual([]);
  });

  test("carries scoringVersion through the seam when present", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "versioned");
    await writeJson(join(runDir, "report.json"), researchReport({ runId: "versioned" }));
    await writeJson(join(runDir, "score.json"), {
      runId: "versioned",
      scores: [
        predictionScore("hit", { predictionId: "p-1", runId: "versioned", scoringVersion: 3 }),
      ],
    });

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.scores[0]?.scoringVersion).toBe(3);
  });

  test("round-trips a legacy score entry without scoringVersion, leaving it undefined", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "legacy");
    await writeJson(join(runDir, "report.json"), researchReport({ runId: "legacy" }));
    // A pre-versioning score file: every required field present, scoringVersion absent.
    await writeJson(join(runDir, "score.json"), {
      runId: "legacy",
      scores: [
        {
          predictionId: "p-legacy",
          runId: "legacy",
          resolved: true,
          outcome: "miss",
          observedAt: "2026-05-28T00:00:00.000Z",
          attemptCount: 2,
          evidence: { close0: 100, closeN: 90 },
        },
      ],
    });

    const { artifact, status } = await loadRunArtifact(runDir);

    expect(status.score).toBe("ok");
    expect(artifact?.scores).toEqual([
      {
        predictionId: "p-legacy",
        runId: "legacy",
        resolved: true,
        outcome: "miss",
        observedAt: "2026-05-28T00:00:00.000Z",
        attemptCount: 2,
        evidence: { close0: 100, closeN: 90 },
      },
    ]);
    expect(artifact?.scores[0]?.scoringVersion).toBeUndefined();
  });

  test("drops only the unusable score entries while keeping a valid sibling (file stays ok)", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "mixed-scores");
    await writeJson(join(runDir, "report.json"), researchReport({ runId: "mixed-scores" }));
    // One entry is missing required fields (no numeric attemptCount, no record evidence) and is
    // Dropped; the file itself is well-formed so status stays "ok" and the valid sibling survives.
    await writeJson(join(runDir, "score.json"), {
      runId: "mixed-scores",
      scores: [
        { predictionId: "p-broken", runId: "mixed-scores", resolved: true },
        predictionScore("hit", { predictionId: "p-good", runId: "mixed-scores" }),
      ],
    });

    const { artifact, status } = await loadRunArtifact(runDir);

    expect(status.score).toBe("ok");
    expect(artifact?.scores.map((score) => score.predictionId)).toEqual(["p-good"]);
  });

  test("returns no snapshots when the snapshot file is absent", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "no-snapshots");
    await writeJson(join(runDir, "report.json"), researchReport({ runId: "no-snapshots" }));

    const { artifact } = await loadRunArtifact(runDir);

    expect(artifact?.marketSnapshots).toEqual([]);
  });

  test("returns no miss autopsies when the sidecar is absent or malformed", async () => {
    const dataDir = tempRunsDir();
    const absentRun = join(dataDir, "no-autopsy");
    await writeJson(join(absentRun, "report.json"), researchReport({ runId: "no-autopsy" }));
    const absent = await loadRunArtifact(absentRun);
    expect(absent.artifact?.missAutopsies).toEqual([]);

    const badRun = join(dataDir, "bad-autopsy");
    await writeJson(join(badRun, "report.json"), researchReport({ runId: "bad-autopsy" }));
    await writeFile(join(badRun, "miss-autopsy.json"), "{not-json", "utf8");
    const malformed = await loadRunArtifact(badRun);
    expect(malformed.artifact?.missAutopsies).toEqual([]);
  });
});

describe("scanRunArtifacts", () => {
  test("returns ok artifacts and a status entry per directory", async () => {
    const dataDir = tempRunsDir();
    await writeJson(join(dataDir, "ok-1", "report.json"), researchReport({ runId: "ok-1" }));
    await writeJson(join(dataDir, "ok-2", "report.json"), researchReport({ runId: "ok-2" }));
    await mkdir(join(dataDir, "absent"), { recursive: true });
    const badDir = join(dataDir, "malformed");
    await mkdir(badDir, { recursive: true });
    await writeFile(join(badDir, "report.json"), "{bad", "utf8");

    const scan = await scanRunArtifacts(dataDir);

    expect(scan.artifacts.map((artifact) => artifact.report.runId).toSorted()).toEqual([
      "ok-1",
      "ok-2",
    ]);
    expect(scan.entries).toHaveLength(4);
    const byDir = new Map(scan.entries.map((entry) => [entry.runDirName, entry.status.report]));
    expect(byDir.get("ok-1")).toBe("ok");
    expect(byDir.get("absent")).toBe("absent");
    expect(byDir.get("malformed")).toBe("malformed");
  });

  test("returns an empty scan for a missing data directory", async () => {
    const scan = await scanRunArtifacts(join(tempRunsDir(), "does-not-exist"));
    expect(scan).toEqual({ artifacts: [], entries: [] });
  });
});

describe("scanWebSubjectProfileRunArtifacts", () => {
  test("returns only same-symbol deep equity profiles", async () => {
    const dataDir = tempRunsDir();
    await writeJson(
      join(dataDir, "aapl-deep", "report.json"),
      researchReport({
        runId: "aapl-deep",
        jobType: "equity",
        symbol: "AAPL",
        extras: { depth: "deep" },
      }),
    );
    await writeJson(
      join(dataDir, "aapl-deep", "normalized", "web-subject-profile.json"),
      webSubjectProfile("AAPL"),
    );
    await writeJson(
      join(dataDir, "aapl-brief", "report.json"),
      researchReport({
        runId: "aapl-brief",
        jobType: "equity",
        symbol: "AAPL",
        extras: { depth: "brief" },
      }),
    );
    await writeJson(
      join(dataDir, "aapl-brief", "normalized", "web-subject-profile.json"),
      webSubjectProfile("AAPL"),
    );
    await writeJson(
      join(dataDir, "msft-deep", "report.json"),
      researchReport({
        runId: "msft-deep",
        jobType: "equity",
        symbol: "MSFT",
        extras: { depth: "deep" },
      }),
    );
    await writeJson(
      join(dataDir, "msft-deep", "normalized", "web-subject-profile.json"),
      webSubjectProfile("MSFT"),
    );
    await writeJson(
      join(dataDir, "crypto-deep", "report.json"),
      researchReport({
        runId: "crypto-deep",
        jobType: "crypto",
        assetClass: "crypto",
        symbol: "AAPL",
        extras: { depth: "deep" },
      }),
    );
    await writeJson(
      join(dataDir, "crypto-deep", "normalized", "web-subject-profile.json"),
      webSubjectProfile("AAPL"),
    );
    await writeJson(
      join(dataDir, "profile-only", "normalized", "web-subject-profile.json"),
      webSubjectProfile("AAPL"),
    );

    const artifacts = await scanWebSubjectProfileRunArtifacts(dataDir, {
      subjectKind: "company",
      subjectId: "aapl",
      depth: "deep",
    });

    expect(artifacts.map((artifact) => artifact.runDirName)).toEqual(["aapl-deep"]);
    expect(artifacts[0]?.report.runId).toBe("aapl-deep");
    expect(artifacts[0]?.webSubjectProfile).toMatchObject({
      subjectKind: "company",
      symbol: "AAPL",
    });
  });
});
