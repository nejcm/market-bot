import { afterEach, describe, expect, test } from "bun:test";
import { persistResearchJob, runResearchJob } from "../src/research/orchestrator";
import { resolveResearchSubject } from "../src/research/research-subject-identity";
import { legacyMarketOverviewCommand } from "./support/commands";
import {
  collectedSources as collectedSourceBundle,
  marketSnapshot,
  newsSource,
} from "./support/fixtures";
import { providerReturning } from "./support/mocks";
import {
  config,
  createDataDirRegistry,
  marketContext,
  marketContextSources,
  marketSnapshots,
  mockPredictions,
  newsSources,
  writeHistoricalRun,
} from "./support/orchestrator-helpers";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";

const { dataDirs, cleanupDataDirs, tempDataDir } = createDataDirRegistry();

const AMD_DATED_SUMMARY =
  "AMD's operating evidence supports a high-growth Data Center and AI infrastructure thesis, with substantial revenue, profit, and cash-flow expansion through 2026-06-27.";
const DATE_ONLY_ADVISORY = {
  code: "uncited-numeric-summary-sentence",
  location: "summary[0]",
} as const;
const WEAK_POSTURE_ADVISORY = {
  code: "weak-evidence-posture-missing",
  location: "keyFindings[1]",
} as const;
const COVERAGE_GAP = "No Helios economics disclosure in the latest filing.";
const CITED_FINDING = "AMD operating evidence is sourced.";
const POSTURE_FINDING = "Coverage remains incomplete.";
const NUMERIC_FINDING = "Uncited claim: EPS beats by $0.12.";
const HISTORY_SOURCE = "history-report-prior-daily";
const PRUNED_NUMERIC_ITEM = {
  location: "keyFindings[2]",
  text: NUMERIC_FINDING,
  sourceIds: [HISTORY_SOURCE],
} as const;

interface DiskAdvisory {
  readonly code: string;
  readonly location: string;
}

interface DiskPrunedItem {
  readonly location: string;
  readonly text: string;
  readonly sourceIds: readonly string[];
}

interface DiskReport {
  readonly summary: string;
  readonly evidenceQuality?: string;
  readonly reportIntegrity?: string;
  readonly researchQuality?: string;
  readonly dataGaps: readonly string[];
  readonly keyFindings: readonly { readonly text: string; readonly sourceIds: readonly string[] }[];
  readonly predictions: readonly {
    readonly id: string;
    readonly sourceIds: readonly string[];
  }[];
}

interface DiskTrace {
  readonly reportIntegrityAudit: {
    readonly reportIntegrity: string;
    readonly researchQuality: string;
    readonly prunedItemCount: number;
    readonly advisoryWarningCount: number;
    readonly advisories?: readonly DiskAdvisory[];
    readonly pruned: readonly DiskPrunedItem[];
  };
}

interface DiskAnalytics {
  readonly reportIntegrity: {
    readonly label: string;
    readonly researchQuality: string;
    readonly prunedItemCount: number;
    readonly advisoryWarningCount: number;
    readonly advisories?: readonly DiskAdvisory[];
  };
}

async function readRunJson<T>(runDir: string, file: string): Promise<T> {
  return JSON.parse(await readFile(join(runDir, file), "utf8")) as T;
}

async function readIntegrityArtifacts(runDir: string) {
  const reportJson = await readFile(join(runDir, RUN_ARTIFACT_FILES.report), "utf8");
  const report = JSON.parse(reportJson) as DiskReport;
  const trace = await readRunJson<DiskTrace>(runDir, RUN_ARTIFACT_FILES.trace);
  const analytics = await readRunJson<DiskAnalytics>(runDir, RUN_ARTIFACT_FILES.analytics);
  const traceAudit = trace.reportIntegrityAudit;
  const analyticsIntegrity = analytics.reportIntegrity;
  return {
    reportJson,
    report,
    traceAudit,
    analyticsIntegrity,
    traceAdvisories: traceAudit.advisories ?? [],
    analyticsAdvisories: analyticsIntegrity.advisories ?? [],
  };
}

function datedSynthesisPayload(
  summary: string,
  extraFindings: readonly { readonly text: string; readonly sourceIds: readonly string[] }[] = [],
): string {
  return JSON.stringify({
    summary,
    keyFindings: [
      { text: CITED_FINDING, sourceIds: ["market-aapl"] },
      { text: POSTURE_FINDING, sourceIds: [HISTORY_SOURCE] },
      ...extraFindings,
    ],
    bullCase: [],
    bearCase: [],
    risks: [{ text: "Source coverage can change.", sourceIds: ["market-aapl"] }],
    catalysts: [],
    scenarios: [
      { name: "Base", description: "Evidence remains relevant.", sourceIds: ["market-aapl"] },
    ],
    confidence: "medium",
    dataGaps: [COVERAGE_GAP],
    predictions: mockPredictions(2, "SPY"),
  });
}

async function persistDatedIntegrityJob(
  summary: string,
  extraFindings: readonly { readonly text: string; readonly sourceIds: readonly string[] }[] = [],
) {
  const dataDir = tempDataDir("market-bot-integrity-dates");
  await writeHistoricalRun({
    dataDir,
    runId: "prior-daily",
    jobType: "daily",
    generatedAt: "2026-05-18T00:00:00.000Z",
  });
  const result = await persistResearchJob({
    command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
    config: { ...config, dataDir },
    provider: providerReturning(datedSynthesisPayload(summary, extraFindings)),
    collectedSources: collectedSourceBundle({
      rawSnapshots: [],
      marketSnapshots,
      newsSources: [
        ...newsSources,
        newsSource({ id: "news-equity-2", title: "Second equity tape update" }),
      ],
      marketContext,
      marketContextSources,
      sourceGaps: [],
    }),
    now: new Date("2026-05-19T00:00:00.000Z"),
  });
  return { dataDir, result };
}

afterEach(cleanupDataDirs);

describe("runResearchJob artifact persistence", () => {
  test("persists raw, normalized, report, markdown, and trace artifacts", async () => {
    const dataDir = join(tmpdir(), `market-bot-test-${Date.now()}`);
    dataDirs.push(dataDir);
    const result = await persistResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config: {
        ...config,
        dataDir,
      },
      provider: providerReturning(
        JSON.stringify({
          summary: "Equity market breadth is constructive.",
          keyFindings: [{ text: "AAPL is liquid.", sourceIds: ["market-aapl"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "medium",
          dataGaps: [],
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [
          {
            id: "raw-1",
            adapter: "mock",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            payload: { ok: true },
          },
          {
            id: "raw-large",
            adapter: "mock-large",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            payload: { body: "x".repeat(1024 * 1024 + 1) },
          },
        ],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    await expect(
      readFile(join(result.artifacts.rawDir, "snapshots.json"), "utf8"),
    ).resolves.toContain("raw-1");
    const rawSnapshots = JSON.parse(
      await readFile(join(result.artifacts.rawDir, "snapshots.json"), "utf8"),
    ) as readonly { readonly id: string; readonly payloadCompacted?: boolean }[];
    expect(rawSnapshots.find((snapshot) => snapshot.id === "raw-large")).toMatchObject({
      payloadCompacted: true,
    });
    await expect(
      readFile(join(result.artifacts.normalizedDir, "market-snapshots.json"), "utf8"),
    ).resolves.toContain("market-aapl");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "historical-context.json"), "utf8"),
    ).resolves.toContain("selectedRunCount");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "spotlight-candidates.json"), "utf8"),
    ).resolves.toContain("market-aapl");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "spotlight-selection.json"), "utf8"),
    ).resolves.toContain("malformed");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "movers.json"), "utf8"),
    ).resolves.toContain("market-aapl");
    const sourcePlanJson = await readFile(
      join(result.artifacts.normalizedDir, "source-plan.json"),
      "utf8",
    );
    expect(JSON.parse(sourcePlanJson)).toMatchObject({ version: 2 });
    expect(sourcePlanJson).toContain("market-data");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "evidence-lanes.json"), "utf8"),
    ).resolves.toContain("coveredLaneCount");
    await expect(
      readFile(join(result.artifacts.normalizedDir, "source-ledger.json"), "utf8"),
    ).resolves.toContain("market-aapl");
    expect(result.trace.sourcePlan?.plannedLaneCount).toBeGreaterThan(0);
    expect(result.analytics.evidenceLanes?.coveredLaneCount).toBeGreaterThan(0);
    expect(result.trace.codeVersion?.dirty).toEqual(expect.any(Boolean));
    expect(result.analytics.codeVersion).toEqual(result.trace.codeVersion);
    expect(result.trace.reproducibility?.effectiveConfigHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.analytics.reproducibility).toEqual(result.trace.reproducibility);
    expect(result.trace.evidenceQualityAssessment?.label).toBe(result.report.evidenceQuality);
    expect(result.trace.schemaVersion).toBe(2);
    expect(result.trace.modelInputSanitization).toBeDefined();
    expect(result.analytics.modelInputSanitization).toEqual(result.trace.modelInputSanitization);
    expect(result.analytics.evidenceQuality.assessment).toEqual(
      result.trace.evidenceQualityAssessment,
    );
    const reportJson = await readFile(join(result.artifacts.runDir, "report.json"), "utf8");
    expect(reportJson).toContain("Equity market breadth");
    expect(reportJson).toContain('"evidenceQuality"');
    expect(reportJson).not.toContain('"confidence"');
    await expect(readFile(join(result.artifacts.runDir, "report.md"), "utf8")).resolves.toContain(
      "Research-only note",
    );
    await expect(readFile(join(result.artifacts.runDir, "trace.json"), "utf8")).resolves.toContain(
      "codeVersion",
    );
    await expect(
      readFile(join(result.artifacts.runDir, "analytics.json"), "utf8"),
    ).resolves.toContain("codeVersion");
    await expect(readFile(join(result.artifacts.runDir, "trace.json"), "utf8")).resolves.toContain(
      "quick-test",
    );
    await expect(readFile(join(result.artifacts.runDir, "stages.json"), "utf8")).resolves.toContain(
      "spotlight-selection",
    );
  });

  test("persists resolved research subject sidecar", async () => {
    const dataDir = join(tmpdir(), `market-bot-research-subject-${Date.now()}`);
    dataDirs.push(dataDir);
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "chip stocks",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
      depth: "brief",
    } as const;
    const resolvedSubject = resolveResearchSubject(command)!;
    const result = await persistResearchJob({
      command,
      config: { ...config, dataDir },
      provider: providerReturning(
        JSON.stringify({
          summary: "Semiconductor evidence is sourced.",
          keyFindings: [{ text: "SMH is liquid.", sourceIds: ["market-smh"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "medium",
          dataGaps: [],
          predictions: [],
        }),
      ),
      collectedSources: collectedSourceBundle({
        resolvedSubject,
        marketSnapshots: [marketSnapshot({ sourceId: "market-smh", symbol: "SMH" })],
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const sidecar = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "resolved-subject.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(sidecar).toMatchObject({
      input: "chip stocks",
      normalizedInput: "chip stocks",
      status: "resolved",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
    });
  });

  test("skips completion when thematic research has no prediction proxy", async () => {
    const command = {
      jobType: "research",
      assetClass: "equity",
      subject: "AI capex",
      subjectKey: "ai-infrastructure",
      depth: "brief",
    } as const;
    const resolvedSubject = resolveResearchSubject(command)!;
    const result = await runResearchJob({
      command,
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "AI infrastructure evidence is sourced.",
          keyFindings: [{ text: "NVDA is liquid.", sourceIds: ["market-nvda"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          dataGaps: [],
          predictions: [],
        }),
      ),
      collectedSources: collectedSourceBundle({
        resolvedSubject,
        marketSnapshots: [marketSnapshot({ sourceId: "market-nvda", symbol: "NVDA" })],
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.trace.predictionCompletion).toBeUndefined();
    expect(result.report.dataGaps).toContain(
      "researchProxyForecastGate: subject ai-infrastructure has no listed prediction proxy; predictions cannot be emitted",
    );
  });

  test("persists ticker valuation comps sidecar", async () => {
    const dataDir = join(tmpdir(), `market-bot-valuation-comps-${Date.now()}`);
    dataDirs.push(dataDir);
    const result = await persistResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...config,
        dataDir,
      },
      provider: providerReturning(
        JSON.stringify({
          summary: "AAPL valuation evidence is cited.",
          keyFindings: [{ text: "AAPL valuation evidence is cited.", sourceIds: ["market-aapl"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "medium",
          dataGaps: [],
        }),
      ),
      collectedSources: collectedSourceBundle({
        marketSnapshots,
        newsSources,
        valuationComps: {
          version: 1,
          generatedAt: "2026-05-19T00:00:00.000Z",
          target: {
            symbol: "AAPL",
            sourceIds: ["market-aapl"],
            usable: true,
          },
          peers: [],
          excludedPeers: [],
          peerUniverseSourceIds: [],
          summary: {
            corePeerCount: 0,
            secondaryPeerCount: 0,
            usablePeerCount: 0,
            valuationSupportability: "screening-only",
          },
          sourceIds: ["market-aapl"],
          freshnessFlags: {
            targetQuoteFresh: true,
            targetSecFresh: true,
            peerQuoteFresh: true,
            peerSecFresh: true,
          },
        },
        financialLenses: {
          version: 1,
          generatedAt: "2026-05-19T00:00:00.000Z",
          symbol: "AAPL",
          lenses: [
            {
              name: "Quality",
              posture: "criteria-supported",
              metrics: [
                {
                  key: "grossMargin",
                  label: "Gross margin",
                  value: 0.4,
                  unit: "ratio-percent",
                  sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
                },
              ],
              sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
            },
          ],
          sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
        },
        extendedSources: [
          {
            id: "extended-sec-edgar-aapl-fundamentals",
            title: "AAPL SEC fundamentals",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            kind: "extended-evidence",
            assetClass: "equity",
            symbol: "AAPL",
            provider: "sec-edgar",
          },
        ],
        businessFramework: {
          version: 1,
          generatedAt: "2026-05-19T00:00:00.000Z",
          symbol: "AAPL",
          phase: "capital-return",
          sections: [
            {
              name: "Phase",
              posture: "criteria-supported",
              summary: "Phase criteria-supported (Phase capital-return)",
              metrics: [
                {
                  key: "phase",
                  label: "Phase",
                  value: "capital-return",
                  unit: "text",
                  sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
                },
              ],
              sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
              gaps: [],
            },
          ],
          sourceIds: ["extended-sec-edgar-aapl-fundamentals"],
          gaps: [],
        },
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const bundle = JSON.parse(
      await readFile(join(result.artifacts.runDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8"),
    ) as {
      readonly derived: {
        readonly valuationComps?: unknown;
        readonly financialLenses?: unknown;
        readonly businessFramework?: unknown;
      };
    };
    expect(bundle.derived.valuationComps).toMatchObject({
      summary: { valuationSupportability: "screening-only" },
    });
    expect(bundle.derived.financialLenses).toMatchObject({
      lenses: [expect.objectContaining({ posture: "criteria-supported" })],
    });
    expect(bundle.derived.businessFramework).toMatchObject({ phase: "capital-return" });
  });

  test("persists date-only summary without a numeric advisory or pruning", async () => {
    const { dataDir, result } = await persistDatedIntegrityJob(AMD_DATED_SUMMARY);
    expect(result.artifacts.runDir.startsWith(dataDir)).toBe(true);

    const {
      reportJson,
      report,
      traceAudit,
      analyticsIntegrity,
      traceAdvisories,
      analyticsAdvisories,
    } = await readIntegrityArtifacts(result.artifacts.runDir);

    expect(report.summary).toBe(AMD_DATED_SUMMARY);
    expect(reportJson).toContain(AMD_DATED_SUMMARY);
    expect(traceAdvisories).toEqual([WEAK_POSTURE_ADVISORY]);
    expect(analyticsAdvisories).toEqual([WEAK_POSTURE_ADVISORY]);
    expect(traceAdvisories).toEqual(analyticsAdvisories);
    expect(traceAudit.advisoryWarningCount).toBe(traceAdvisories.length);
    expect(analyticsIntegrity.advisoryWarningCount).toBe(analyticsAdvisories.length);
    expect(analyticsIntegrity.advisoryWarningCount).toBe(traceAudit.advisoryWarningCount);
    expect(traceAudit.prunedItemCount).toBe(0);
    expect(traceAudit.pruned).toEqual([]);
    expect(analyticsIntegrity.prunedItemCount).toBe(0);
    expect(report.reportIntegrity).toBe("high");
    expect(traceAudit.reportIntegrity).toBe("high");
    expect(analyticsIntegrity.label).toBe("high");
    expect(report.evidenceQuality).toBe("high");
    expect(report.researchQuality).toBe("high");
    expect(traceAudit.researchQuality).toBe("high");
    expect(analyticsIntegrity.researchQuality).toBe("high");
    expect(report.keyFindings.map((finding) => finding.text)).toEqual([
      CITED_FINDING,
      POSTURE_FINDING,
    ]);
    expect(report.keyFindings[0]?.sourceIds).toEqual(["market-aapl"]);
    expect(report.keyFindings[1]?.sourceIds).toEqual([HISTORY_SOURCE]);
    expect(report.predictions.map((prediction) => prediction.id)).toEqual(["pred-1", "pred-2"]);
    expect(
      report.predictions.every((prediction) => prediction.sourceIds.includes("market-aapl")),
    ).toBe(true);
    expect(report.dataGaps).toContain(COVERAGE_GAP);
  });

  test("persists a dated summary with a real numeric claim as advisory and prunes unsupported quantities", async () => {
    const summary = `${AMD_DATED_SUMMARY.slice(0, -1)}, including $10 billion.`;
    const { dataDir, result } = await persistDatedIntegrityJob(summary, [
      { text: NUMERIC_FINDING, sourceIds: [HISTORY_SOURCE] },
    ]);
    expect(result.artifacts.runDir.startsWith(dataDir)).toBe(true);

    const {
      reportJson,
      report,
      traceAudit,
      analyticsIntegrity,
      traceAdvisories,
      analyticsAdvisories,
    } = await readIntegrityArtifacts(result.artifacts.runDir);

    expect(report.summary).toBe(summary);
    expect(reportJson).toContain(summary);
    expect(traceAdvisories).toContainEqual(DATE_ONLY_ADVISORY);
    expect(analyticsAdvisories).toContainEqual(DATE_ONLY_ADVISORY);
    expect(traceAdvisories).toEqual(analyticsAdvisories);
    expect(traceAudit.advisoryWarningCount).toBe(traceAdvisories.length);
    expect(analyticsIntegrity.advisoryWarningCount).toBe(analyticsAdvisories.length);
    expect(analyticsIntegrity.advisoryWarningCount).toBe(traceAudit.advisoryWarningCount);
    expect(traceAudit.pruned).toEqual([PRUNED_NUMERIC_ITEM]);
    expect(report.keyFindings.map((finding) => finding.text)).toEqual([
      CITED_FINDING,
      POSTURE_FINDING,
    ]);
    expect(report.keyFindings.map((finding) => finding.text)).not.toContain(NUMERIC_FINDING);
    expect(report.keyFindings[0]?.sourceIds).toEqual(["market-aapl"]);
    expect(report.keyFindings[1]?.sourceIds).toEqual([HISTORY_SOURCE]);
    expect(report.predictions.map((prediction) => prediction.id)).toEqual(["pred-1", "pred-2"]);
    expect(report.dataGaps).toContain(COVERAGE_GAP);
    expect(traceAudit.prunedItemCount).toBe(traceAudit.pruned.length);
    expect(analyticsIntegrity.prunedItemCount).toBe(traceAudit.prunedItemCount);
  });
});
