import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AppConfig } from "../src/config";
import type { Source } from "../src/domain/types";
import type { StageOutput } from "../src/research/final-synthesis";
import type { ResearchContext } from "../src/research/research-context";
import { runWebEvidencePhase } from "../src/research/web-evidence-phase";
import { collectedSources, marketSnapshot } from "./support/fixtures";

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tempRunsDir(): string {
  const dir = join(
    tmpdir(),
    `market-bot-web-evidence-phase-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "runs",
  );
  tmpDirs.push(dirname(dir));
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

const context: ResearchContext = {
  depthProfile: {
    depth: "deep",
    analystStyle: "fuller analyst-style",
    minimumKeyFindings: 5,
    minimumScenarios: 3,
    targetPredictions: 6,
    defaultPredictionHorizon: 10,
    predictionSubjects: ["BTC"],
    focus: [],
    targetKindMix: { favored: ["direction"] },
  },
  runParams: {
    quickModel: "quick-test",
    synthesisModel: "synthesis-test",
    modelParams: undefined,
    minimumKeyFindings: 5,
    minimumScenarios: 3,
    targetPredictions: 6,
    defaultPredictionHorizon: 10,
    predictionSubjects: ["BTC"],
    focus: [],
    analystStyle: "fuller analyst-style",
    targetKindMix: { favored: ["direction"] },
  },
  marketRegime: {
    assetClass: "crypto",
    label: "insufficient-data",
    proxyCount: 0,
    drivers: [],
    sourceIds: [],
  },
  calibrationContext: undefined,
};

function config(dataDir: string): AppConfig {
  return {
    provider: "openai",
    quickModel: "quick-test",
    synthesisModel: "synthesis-test",
    modelTimeoutMs: 120_000,
    dataDir,
    promptDir: "prompts",
    sourceOptions: {
      equityMoverLimit: 2,
      cryptoMoverLimit: 2,
      newsLimit: 2,
      sourceTimeoutMs: 1000,
      exaApiKey: "exa-key",
    },
    evidenceRequestOptions: { maxRounds: 0, maxToolCalls: 0, sourceBudget: 0 },
    webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
    webGatherDisabled: false,
    webProfileReuseDaysBySubjectKind: { company: 30, "crypto-asset": 7, theme: 7 },
    alphaSearchOptions: {
      apeWisdomFilter: "all-stocks",
      apeWisdomBriefPageLimit: 5,
      apeWisdomDeepPageLimit: 10,
      validationCandidateLimit: 25,
      leadLimit: 15,
      topCandidateLimit: 15,
      secDiscoveryLimit: 25,
      secFormTypes: ["S-1", "F-1", "8-K", "6-K"],
      minPrice: 0.5,
      minVolume: 100_000,
      minMarketCap: 50_000_000,
      maxMarketCap: 10_000_000_000,
    },
  };
}

describe("Web Evidence phase", () => {
  test("gathers with cited reuse coverage while attaching the profile and skipping extraction", async () => {
    const dataDir = tempRunsDir();
    const runDir = join(dataDir, "prior-btc");
    const source: Source = {
      id: "web-btc-prior",
      title: "Bitcoin protocol profile",
      url: "https://example.com/bitcoin",
      fetchedAt: "2026-05-17T00:00:00.000Z",
      kind: "web",
      assetClass: "crypto",
      symbol: "BTC",
      provider: "exa",
    };
    const citedAnswer = {
      answer: "Bitcoin is a decentralized monetary network.",
      sourceIds: [source.id],
    };
    const uncitedAnswer = { answer: "Supply follows a fixed schedule.", sourceIds: [] };
    await writeJson(join(runDir, "report.json"), {
      runId: "prior-btc",
      jobType: "crypto",
      assetClass: "crypto",
      symbol: "BTC",
      generatedAt: "2026-05-17T00:00:00.000Z",
      summary: "Prior Bitcoin profile.",
      keyFindings: [],
      bullCase: [],
      bearCase: [],
      risks: [],
      catalysts: [],
      scenarios: [],
      confidence: "medium",
      dataGaps: [],
      predictions: [],
      sources: [source],
      notFinancialAdvice: true,
      extras: { depth: "deep" },
    });
    await writeJson(join(runDir, "normalized", "web-subject-profile.json"), {
      version: 2,
      generatedAt: "2026-05-17T00:00:00.000Z",
      subjectKind: "crypto-asset",
      subjectId: "BTC",
      subjectLabel: "Bitcoin",
      symbol: "BTC",
      subjectSummary: citedAnswer,
      questions: {
        whatItDoes: citedAnswer,
        valueAccrual: citedAnswer,
        supplyIssuance: uncitedAnswer,
        usageAdoption: citedAnswer,
        governanceBuilders: citedAnswer,
        competitionMoat: citedAnswer,
        keyRisks: citedAnswer,
      },
      recentMaterialEvents: [],
      factLedger: [{ claim: citedAnswer.answer, sourceIds: citedAnswer.sourceIds }],
      openGaps: [],
      sourceIds: [source.id],
    });

    const stages: StageOutput[] = [];
    const result = await runWebEvidencePhase({
      command: { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "deep" },
      config: config(dataDir),
      collectedSources: collectedSources({
        marketSnapshots: [marketSnapshot({ assetClass: "crypto", symbol: "BTC" })],
      }),
      context,
      generatedAt: "2026-05-19T00:00:00.000Z",
      now: new Date("2026-05-19T00:00:00.000Z"),
      generateStage: async (stage, _sources, stageContext) => {
        expect(stage).toBe("web-gather");
        expect(stageContext.webGather?.reusedProfileCoverage).toEqual({
          present: true,
          topics: [
            "competitionMoat",
            "governanceBuilders",
            "keyRisks",
            "usageAdoption",
            "valueAccrual",
            "whatItDoes",
          ],
        });
        const output: StageOutput = {
          stage,
          content: JSON.stringify({ requests: [] }),
          tokenEstimate: 10,
          costEstimateUsd: 0.001,
        };
        stages.push(output);
        return output;
      },
    });

    expect(stages.map((stage) => stage.stage)).toEqual(["web-gather"]);
    expect(result.webSubjectProfile).toBeUndefined();
    expect(result.collectedSources.webSubjectProfile).toMatchObject({
      subjectKind: "crypto-asset",
      symbol: "BTC",
    });
    expect(result.collectedSources.extendedSources).toContainEqual(source);
  });
});
