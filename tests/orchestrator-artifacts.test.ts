import { afterEach, describe, expect, test } from "bun:test";
import { persistResearchJob, runResearchJob } from "../src/research/orchestrator";
import { resolveResearchSubject } from "../src/research/research-subject-identity";
import { legacyMarketOverviewCommand } from "./support/commands";
import { collectedSources as collectedSourceBundle, marketSnapshot } from "./support/fixtures";
import { providerReturning } from "./support/mocks";
import {
  config,
  createDataDirRegistry,
  marketSnapshots,
  newsSources,
} from "./support/orchestrator-helpers";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { dataDirs, cleanupDataDirs } = createDataDirRegistry();

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

    await expect(
      readFile(join(result.artifacts.normalizedDir, "valuation-comps.json"), "utf8"),
    ).resolves.toContain('"valuationSupportability": "screening-only"');
    await expect(
      readFile(join(result.artifacts.normalizedDir, "financial-lenses.json"), "utf8"),
    ).resolves.toContain('"posture": "criteria-supported"');
    await expect(
      readFile(join(result.artifacts.normalizedDir, "business-framework.json"), "utf8"),
    ).resolves.toContain('"phase": "capital-return"');
  });
});
