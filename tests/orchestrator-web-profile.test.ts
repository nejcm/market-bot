import { afterEach, describe, expect, test } from "bun:test";
import { persistResearchJob, runResearchJob } from "../src/research/orchestrator";
import { isRecord } from "../src/sources/guards";
import { collectedSources as collectedSourceBundle } from "./support/fixtures";
import {
  config,
  createDataDirRegistry,
  evidenceConfig,
  marketSnapshots,
  modelReport,
  newsSources,
  secEvidenceFetch,
} from "./support/orchestrator-helpers";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Source } from "../src/domain/types";
import type { ModelProvider } from "../src/model/types";

const { cleanupDataDirs, tempDataDir } = createDataDirRegistry();

afterEach(cleanupDataDirs);

function firstWebSourceId(prompt: Record<string, unknown>): string {
  const evidence = isRecord(prompt.evidence) ? prompt.evidence : {};
  const sources = Array.isArray(evidence.webSources) ? evidence.webSources : [];
  const source = sources.find((item) => isRecord(item));
  const sourceId = source === undefined ? undefined : source.id;
  if (typeof sourceId === "string") {
    return sourceId;
  }
  const profile = isRecord(evidence.webSubjectProfile) ? evidence.webSubjectProfile : {};
  const profileSourceIds = Array.isArray(profile.sourceIds) ? profile.sourceIds : [];
  const profileSourceId = profileSourceIds.find((id) => typeof id === "string");
  if (typeof profileSourceId !== "string") {
    throw new TypeError("expected a web source in prompt evidence");
  }
  return profileSourceId;
}

describe("runResearchJob web subject profile", () => {
  test("normalizes thematic research to deep web evidence and coverage stages", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-gather") {
          return {
            content: JSON.stringify({
              requests: [
                {
                  tool: "web_search",
                  args: {
                    query: "biotech promising stocks analyst picks",
                    searchType: "current-subject",
                  },
                  rationale: "current sourced candidate evidence",
                },
              ],
            }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "web-subject-profile") {
          const sourceId = firstWebSourceId(prompt);
          const answer = {
            answer: "Biotech stock screens cite analyst upside and pipeline catalysts.",
            sourceIds: [sourceId],
          };
          return {
            content: JSON.stringify({
              subjectLabel: "Biotechnology",
              subjectSummary: answer,
              questions: {
                whatItIs: answer,
                whyNow: answer,
                beneficiaries: answer,
                headwinds: answer,
                keyDebates: answer,
                howItPlaysOut: answer,
              },
              recentMaterialEvents: [
                {
                  claim: "Analyst biotech screens identify current candidates.",
                  sourceIds: [sourceId],
                },
              ],
              factLedger: [
                {
                  claim: "Biotech screens cite analyst upside and pipeline catalysts.",
                  sourceIds: [sourceId],
                },
              ],
              openGaps: [],
            }),
            tokenEstimate: 12,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        const sourceId = firstWebSourceId(prompt);
        return {
          content: JSON.stringify({
            summary: "Biotech candidate evidence is sourced.",
            keyFindings: [
              { text: "Biotech candidate lists cite analyst upside.", sourceIds: [sourceId] },
              { text: "Pipeline catalysts remain central to the screen.", sourceIds: [sourceId] },
              {
                text: "Issuer-level evidence is still needed before ranking conviction.",
                sourceIds: [sourceId],
              },
            ],
            bullCase: [
              {
                text: "Current source evidence identifies candidate themes.",
                sourceIds: [sourceId],
              },
            ],
            bearCase: [
              { text: "Clinical and financing risk remain material.", sourceIds: [sourceId] },
            ],
            risks: [
              {
                text: "Biotech outcomes can change after trial or regulatory updates.",
                sourceIds: [sourceId],
              },
            ],
            catalysts: [
              {
                text: "Trial and analyst-update catalysts drive candidate attention.",
                sourceIds: [sourceId],
              },
            ],
            scenarios: [
              {
                name: "Evidence-backed screen",
                description: "Use cited sources to frame candidates without trade-action language.",
                sourceIds: [sourceId],
              },
            ],
            confidence: "medium",
            dataGaps: [],
            predictions: [],
          }),
          tokenEstimate: 10,
          costEstimateUsd: 0.001,
        };
      },
    };

    const result = await runResearchJob({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "Top-10 list of promising biotech stocks",
        subjectKey: "biotech",
        predictionProxySymbol: "XBI",
        depth: "brief",
      },
      config: {
        ...config,
        sourceOptions: { ...config.sourceOptions, exaApiKey: "exa-key" },
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle(),
      sourceFetchImpl: async () =>
        Response.json({
          results: [
            {
              id: "exa-search-1",
              url: "https://example.com/biotech-picks",
              title: "Biotech stock picks",
              summary: "Analyst biotech screens cite upside and pipeline catalysts.",
            },
          ],
        }),
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(prompts.map((prompt) => prompt.stage)).toContain("web-gather");
    expect(prompts.map((prompt) => prompt.stage)).toContain("web-subject-profile");
    expect(prompts.map((prompt) => prompt.stage)).toContain("instrument-evidence-analysis");
    expect(prompts.map((prompt) => prompt.stage)).toContain("market-behavior-analysis");
    expect(result.trace.depth).toBe("deep");
    expect(result.collectedSources.webSubjectProfile).toMatchObject({
      subjectKind: "theme",
      subjectLabel: "Biotechnology",
    });
  });

  test("extracts and persists Web Subject Profile after web gather", async () => {
    const dataDir = tempDataDir("market-bot-web-subject-profile");
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-gather") {
          return {
            content: JSON.stringify({
              requests: [
                {
                  tool: "web_search",
                  args: {
                    query: "AAPL Apple business model customers",
                    searchType: "background",
                  },
                  rationale: "company profile evidence",
                },
              ],
            }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "web-subject-profile") {
          const evidence = isRecord(prompt.evidence) ? prompt.evidence : {};
          const sources = Array.isArray(evidence.webSources) ? evidence.webSources : [];
          const source = sources.find((item) => isRecord(item)) ?? {};
          const sourceId = typeof source.id === "string" ? source.id : "missing-source";
          const answer = {
            answer: "Apple sells hardware, software, and services.",
            sourceIds: [sourceId],
          };
          return {
            content: JSON.stringify({
              companyName: "Apple Inc.",
              subjectSummary: answer,
              questions: {
                whatItDoes: answer,
                howItMakesMoney: answer,
                customers: answer,
                geography: answer,
                purchaseRecurrence: answer,
                pricingPower: answer,
                recessionCyclicality: answer,
                managementTrackRecord: answer,
                capitalAllocation: answer,
                companyKpis: answer,
                riskFactors: answer,
              },
              recentMaterialEvents: [
                { claim: "Apple reports services revenue.", sourceIds: [sourceId] },
              ],
              factLedger: [{ claim: "Apple sells hardware and services.", sourceIds: [sourceId] }],
              openGaps: [],
            }),
            tokenEstimate: 12,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await persistResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...config,
        dataDir,
        sourceOptions: { ...config.sourceOptions, exaApiKey: "exa-key" },
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle({ marketSnapshots, newsSources }),
      sourceFetchImpl: async () =>
        Response.json({
          results: [
            {
              id: "exa-search-1",
              url: "https://example.com/apple-profile",
              title: "Apple business profile",
              summary: "Apple sells hardware and services.",
            },
          ],
        }),
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(prompts.map((prompt) => prompt.stage)).toContain("web-subject-profile");
    expect(result.trace.webGatherLoop?.acceptedRequests).toHaveLength(1);
    expect(result.report.extras?.webSubjectProfile).toMatchObject({
      companyName: "Apple Inc.",
      factLedger: [expect.objectContaining({ claim: "Apple sells hardware and services." })],
    });
    await expect(
      readFile(join(result.artifacts.normalizedDir, "web-subject-profile.json"), "utf8"),
    ).resolves.toContain('"companyName": "Apple Inc."');
    const webGatherAudit = JSON.parse(
      await readFile(join(result.artifacts.normalizedDir, "web-gather-audit.json"), "utf8"),
    ) as {
      readonly acceptedRequests: readonly {
        readonly tool: string;
        readonly sanitizer?: { readonly sourceCount: number };
      }[];
      readonly sanitizer?: { readonly sourceCount: number };
    };
    expect(webGatherAudit.acceptedRequests[0]).toMatchObject({
      tool: "web_search",
      sanitizer: { sourceCount: 1 },
    });
    expect(webGatherAudit.sanitizer).toMatchObject({ sourceCount: 1 });
    await expect(readFile(join(result.artifacts.runDir, "report.md"), "utf8")).resolves.toContain(
      "## Web Subject Profile",
    );
  });

  test("builds a SEC-only company profile when Exa is absent on equity --deep", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-subject-profile") {
          const evidence = isRecord(prompt.evidence) ? prompt.evidence : {};
          const sources = Array.isArray(evidence.webSources) ? evidence.webSources : [];
          const source = sources.find((item) => isRecord(item)) ?? {};
          const sourceId = typeof source.id === "string" ? source.id : "missing-source";
          const answer = {
            answer: "Apple sells hardware and services per the filing.",
            sourceIds: [sourceId],
          };
          return {
            content: JSON.stringify({
              companyName: "Apple Inc.",
              subjectSummary: answer,
              questions: {
                whatItDoes: answer,
                howItMakesMoney: answer,
                customers: answer,
                geography: answer,
                purchaseRecurrence: answer,
                pricingPower: answer,
                recessionCyclicality: answer,
                managementTrackRecord: answer,
                capitalAllocation: answer,
                companyKpis: answer,
                riskFactors: answer,
              },
              recentMaterialEvents: [],
              factLedger: [{ claim: "Apple sells hardware and services.", sourceIds: [sourceId] }],
              openGaps: [],
            }),
            tokenEstimate: 12,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      sourceFetchImpl: secEvidenceFetch,
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const stages = prompts.map((prompt) => prompt.stage);
    expect(stages).toContain("web-subject-profile");
    expect(stages).not.toContain("web-gather");
    expect(result.collectedSources.webSubjectProfile).toMatchObject({
      companyName: "Apple Inc.",
      subjectKind: "company",
    });
    // The SEC-only profile cites the filing source.
    expect(result.collectedSources.webSubjectProfile?.sourceIds).toEqual([
      "extended-sec-edgar-aapl-10q",
    ]);
    expect(result.collectedSources.sourceGaps).toContainEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "search-unavailable: MARKET_BOT_EXA_API_KEY is not set; web gather skipped",
        cause: "missing-credential",
      }),
    );
    expect(result.markdown).toContain("## Web Subject Profile");
    expect(result.markdown).toContain("**Basis:** 10-Q for period 2026-03-31.");
  });

  test("does not build a SEC-only company profile from fundamentals-only SEC evidence", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-subject-profile") {
          throw new Error("unexpected web-subject-profile");
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config,
      provider,
      collectedSources: collectedSourceBundle({
        marketSnapshots,
        newsSources,
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
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(prompts.map((prompt) => prompt.stage)).not.toContain("web-subject-profile");
    expect(result.collectedSources.webSubjectProfile).toBeUndefined();
  });

  test("reuses fresh Web Subject Profile, gathers again, and skips profile extraction", async () => {
    const dataDir = tempDataDir("market-bot-web-subject-profile-reuse");
    const priorRunDir = join(dataDir, "prior-aapl");
    const priorWebSource: Source = {
      id: "web-aapl-prior",
      title: "Apple prior web profile",
      url: "https://example.com/apple-prior",
      fetchedAt: "2026-05-01T00:00:00.000Z",
      kind: "web",
      assetClass: "equity",
      symbol: "AAPL",
      provider: "exa",
    };
    const answer = {
      answer: "Apple sells hardware and services.",
      sourceIds: [priorWebSource.id],
    };
    await mkdir(join(priorRunDir, "normalized"), { recursive: true });
    await writeFile(
      join(priorRunDir, "report.json"),
      JSON.stringify({
        runId: "prior-aapl",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-01T00:00:00.000Z",
        summary: "Prior Apple web profile.",
        keyFindings: [],
        bullCase: [],
        bearCase: [],
        risks: [],
        catalysts: [],
        scenarios: [],
        confidence: "medium",
        dataGaps: [],
        predictions: [],
        sources: [priorWebSource],
        notFinancialAdvice: true,
        extras: { depth: "deep" },
      }),
      "utf8",
    );
    await writeFile(
      join(priorRunDir, "normalized", "web-subject-profile.json"),
      JSON.stringify({
        version: 3,
        generatedAt: "2026-05-01T00:00:00.000Z",
        subjectKind: "company",
        subjectId: "AAPL",
        subjectLabel: "Apple Inc.",
        symbol: "AAPL",
        companyName: "Apple Inc.",
        subjectSummary: answer,
        questions: {
          whatItDoes: answer,
          howItMakesMoney: answer,
          customers: answer,
          geography: answer,
          purchaseRecurrence: answer,
          pricingPower: answer,
          recessionCyclicality: answer,
          managementTrackRecord: answer,
          capitalAllocation: answer,
          companyKpis: answer,
          riskFactors: answer,
        },
        recentMaterialEvents: [],
        factLedger: [
          { claim: "Apple sells hardware and services.", sourceIds: [priorWebSource.id] },
        ],
        openGaps: [],
        sourceIds: [priorWebSource.id],
        secFilingBasisDate: "2026-05-01",
      }),
      "utf8",
    );

    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-subject-profile") {
          throw new Error(`unexpected ${String(prompt.stage)}`);
        }
        if (prompt.stage === "web-gather") {
          return {
            content: JSON.stringify({ requests: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        dataDir,
        sourceOptions: { ...evidenceConfig.sourceOptions, exaApiKey: "exa-key" },
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle({ marketSnapshots, newsSources }),
      sourceFetchImpl: secEvidenceFetch,
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(prompts.filter((prompt) => prompt.stage === "web-gather")).toHaveLength(1);
    expect(
      (
        prompts.find((prompt) => prompt.stage === "web-gather")?.evidence as {
          webGather?: { reusedProfileCoverage?: unknown };
        }
      )?.webGather?.reusedProfileCoverage,
    ).toEqual({
      present: true,
      topics: [
        "capitalAllocation",
        "companyKpis",
        "customers",
        "geography",
        "howItMakesMoney",
        "managementTrackRecord",
        "pricingPower",
        "purchaseRecurrence",
        "recessionCyclicality",
        "riskFactors",
        "whatItDoes",
      ],
    });
    expect(prompts.map((prompt) => prompt.stage)).not.toContain("web-subject-profile");
    expect(result.collectedSources.webSubjectProfile).toMatchObject({
      subjectKind: "company",
      companyName: "Apple Inc.",
    });
    expect(result.collectedSources.extendedSources).toContainEqual(priorWebSource);
    expect(result.report.dataGaps).toContain(
      "web-subject-profile: Reused web subject profile from 2026-05-01T00:00:00.000Z (18.0 days old); latest SEC filing basis 2026-05-01.",
    );
    expect(result.report.extras?.webSubjectProfile).toMatchObject({
      companyName: "Apple Inc.",
      sourceIds: [priorWebSource.id],
    });
  });

  test("does not reuse Web Subject Profile when web gather is disabled", async () => {
    const dataDir = tempDataDir("market-bot-web-subject-profile-reuse-disabled");
    const priorRunDir = join(dataDir, "prior-aapl");
    const priorWebSource: Source = {
      id: "web-aapl-prior",
      title: "Apple prior web profile",
      url: "https://example.com/apple-prior",
      fetchedAt: "2026-05-01T00:00:00.000Z",
      kind: "web",
      assetClass: "equity",
      symbol: "AAPL",
      provider: "exa",
    };
    const answer = {
      answer: "Apple sells hardware and services.",
      sourceIds: [priorWebSource.id],
    };
    await mkdir(join(priorRunDir, "normalized"), { recursive: true });
    await writeFile(
      join(priorRunDir, "report.json"),
      JSON.stringify({
        runId: "prior-aapl",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-01T00:00:00.000Z",
        summary: "Prior Apple web profile.",
        keyFindings: [],
        bullCase: [],
        bearCase: [],
        risks: [],
        catalysts: [],
        scenarios: [],
        confidence: "medium",
        dataGaps: [],
        predictions: [],
        sources: [priorWebSource],
        notFinancialAdvice: true,
        extras: { depth: "deep" },
      }),
      "utf8",
    );
    await writeFile(
      join(priorRunDir, "normalized", "web-subject-profile.json"),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-05-01T00:00:00.000Z",
        symbol: "AAPL",
        companyName: "Apple Inc.",
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
        factLedger: [
          { claim: "Apple sells hardware and services.", sourceIds: [priorWebSource.id] },
        ],
        openGaps: [],
        sourceIds: [priorWebSource.id],
        secFilingBasisDate: "2026-05-01",
      }),
      "utf8",
    );

    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-gather") {
          throw new Error(`unexpected ${String(prompt.stage)}`);
        }
        if (prompt.stage === "web-subject-profile") {
          const evidence = isRecord(prompt.evidence) ? prompt.evidence : {};
          const sources = Array.isArray(evidence.webSources) ? evidence.webSources : [];
          const source = sources.find((item) => isRecord(item)) ?? {};
          const sourceId = typeof source.id === "string" ? source.id : "missing-source";
          const freshAnswer = {
            answer: "Apple sells hardware and services per the latest filing.",
            sourceIds: [sourceId],
          };
          return {
            content: JSON.stringify({
              companyName: "Apple Inc.",
              subjectSummary: freshAnswer,
              questions: {
                whatItDoes: freshAnswer,
                howItMakesMoney: freshAnswer,
                customers: freshAnswer,
                geography: freshAnswer,
                purchaseRecurrence: freshAnswer,
                pricingPower: freshAnswer,
                recessionCyclicality: freshAnswer,
                managementTrackRecord: freshAnswer,
                capitalAllocation: freshAnswer,
                companyKpis: freshAnswer,
                riskFactors: freshAnswer,
              },
              recentMaterialEvents: [],
              factLedger: [{ claim: "Apple sells hardware and services.", sourceIds: [sourceId] }],
              openGaps: [],
            }),
            tokenEstimate: 12,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...evidenceConfig,
        dataDir,
        sourceOptions: { ...evidenceConfig.sourceOptions, exaApiKey: "exa-key" },
        webGatherDisabled: true,
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle({ marketSnapshots, newsSources }),
      sourceFetchImpl: secEvidenceFetch,
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    // Web gather stays disabled, but a fresh SEC-only profile is built — the prior
    // Profile must not be reused (its web source is never reattached).
    expect(prompts.map((prompt) => prompt.stage)).not.toContain("web-gather");
    expect(result.collectedSources.extendedSources).not.toContainEqual(priorWebSource);
    expect(result.collectedSources.webSubjectProfile?.sourceIds).toEqual([
      "extended-sec-edgar-aapl-10q",
    ]);
    expect(result.collectedSources.webSubjectProfile?.sourceIds).not.toContain(priorWebSource.id);
  });

  test("persists empty Web Subject Profile when extraction stage fails", async () => {
    const dataDir = tempDataDir("market-bot-web-subject-profile-failure");
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-gather") {
          return {
            content: JSON.stringify({
              requests: [
                {
                  tool: "web_search",
                  args: {
                    query: "AAPL Apple business model customers",
                    searchType: "background",
                  },
                  rationale: "company profile evidence",
                },
              ],
            }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "web-subject-profile") {
          throw new Error("profile timeout");
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await persistResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...config,
        dataDir,
        sourceOptions: { ...config.sourceOptions, exaApiKey: "exa-key" },
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle({ marketSnapshots, newsSources }),
      sourceFetchImpl: async () =>
        Response.json({
          results: [
            {
              id: "exa-search-1",
              url: "https://example.com/apple-profile",
              title: "Apple business profile",
              summary: "Apple sells hardware and services.",
            },
          ],
        }),
      sourceRetryDelaysMs: [],
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(prompts.map((prompt) => prompt.stage)).toContain("web-subject-profile");
    expect(result.collectedSources.webSubjectProfile).toMatchObject({
      sourceIds: [],
      factLedger: [],
      openGaps: [expect.stringContaining("profile timeout")],
    });
    expect(result.collectedSources.extendedEvidence?.gaps).toContainEqual(
      expect.objectContaining({
        source: "web-subject-profile",
        cause: "malformed-response",
      }),
    );
    await expect(
      readFile(join(result.artifacts.normalizedDir, "web-subject-profile.json"), "utf8"),
    ).resolves.toContain("profile timeout");
  });

  test("skips Web Subject Profile extraction when web gather produces no web sources", async () => {
    const prompts: Record<string, unknown>[] = [];
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "web-gather") {
          return {
            content: JSON.stringify({ requests: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0.001,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 10, costEstimateUsd: 0.001 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "deep" },
      config: {
        ...config,
        sourceOptions: { ...config.sourceOptions, exaApiKey: "exa-key" },
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      provider,
      collectedSources: collectedSourceBundle({ marketSnapshots, newsSources }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(prompts.map((prompt) => prompt.stage)).toContain("web-gather");
    expect(prompts.map((prompt) => prompt.stage)).not.toContain("web-subject-profile");
    expect(result.collectedSources.webSubjectProfile).toBeUndefined();
  });
});
