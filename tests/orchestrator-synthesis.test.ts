import { afterEach, describe, expect, test } from "bun:test";
import { sourceGap } from "../src/domain/source-gaps";
import { persistResearchJob, runResearchJob } from "../src/research/orchestrator";
import { FinalSynthesisRejectedError } from "../src/research/final-synthesis";
import { readNewsSeenEntries } from "../src/sources/news-seen";
import { legacyMarketOverviewCommand } from "./support/commands";
import { collectedSources as collectedSourceBundle, newsSource } from "./support/fixtures";
import { providerReturning } from "./support/mocks";
import { modelPayloadLanguageViolations } from "../src/research/model-payload-language";
import { readerDirectedAdviceClauses } from "./support/research-language-prompt";
import {
  config,
  createDataDirRegistry,
  marketSnapshots,
  mockPredictions,
  modelReport,
  newsSources,
} from "./support/orchestrator-helpers";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "../src/model/types";

const { dataDirs, cleanupDataDirs, tempDataDir } = createDataDirRegistry();

const baseWebSubjectProfile = {
  version: 2 as const,
  generatedAt: "2026-05-18T00:00:00.000Z",
  subjectKind: "company" as const,
  subjectId: "AAPL",
  symbol: "AAPL",
  subjectSummary: { answer: "Apple sells devices.", sourceIds: ["market-aapl"] },
  questions: {
    whatItDoes: { answer: "Consumer electronics.", sourceIds: ["market-aapl"] },
    howItMakesMoney: { answer: "Hardware and services.", sourceIds: ["market-aapl"] },
    customers: { answer: "Global consumers.", sourceIds: ["market-aapl"] },
    geography: { answer: "Worldwide.", sourceIds: ["market-aapl"] },
    purchaseRecurrence: { answer: "High.", sourceIds: ["market-aapl"] },
    pricingPower: { answer: "Premium.", sourceIds: ["market-aapl"] },
    recessionCyclicality: { answer: "Moderate.", sourceIds: ["market-aapl"] },
  },
  recentMaterialEvents: [{ claim: "Launched a device.", sourceIds: ["market-aapl"] }],
  factLedger: [{ claim: "Revenue grew.", sourceIds: ["market-aapl"] }],
  sourceIds: ["market-aapl"],
};

// The wording that failed deep AAPL run 2026-09-07T09-51-24-783Z-a23bf02b: an absence declaration
// The profile stage wrote, which no final-synthesis draft can rewrite.
const poisonedWebSubjectProfile = {
  ...baseWebSubjectProfile,
  openGaps: ["Analyst consensus and price targets are not available in the supplied web sources."],
};

const cleanWebSubjectProfile = {
  ...baseWebSubjectProfile,
  openGaps: ["No segment split is disclosed."],
};

afterEach(cleanupDataDirs);

describe("runResearchJob synthesis retry and source gaps", () => {
  test("re-prompts synthesis once when report findings omit source IDs", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
        }

        if (prompt.stage === "final-synthesis" && finalCalls === 1) {
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "AAPL moved.", sourceIds: [] }],
              bullCase: [{ text: "Supplier news supports breadth.", sourceIds: [] }],
              bearCase: [{ text: "Single-name breadth is limited.", sourceIds: [] }],
              risks: [{ text: "Breadth can reverse.", sourceIds: [] }],
              catalysts: [{ text: "Supplier demand is visible.", sourceIds: [] }],
              scenarios: [
                {
                  name: "Base",
                  description: "Momentum continues if liquidity persists.",
                  sourceIds: [],
                },
              ],
              confidence: "medium",
              dataGaps: [],
              predictions: mockPredictions(2),
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        return {
          content: modelReport("SPY"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const retryPrompt = finalPrompts[1] ?? {};

    expect(finalPrompts).toHaveLength(2);
    expect(result.report.keyFindings[0]?.sourceIds).toEqual(["market-aapl"]);
    expect(result.trace.stages).toEqual([
      "source-collection",
      "spotlight-selection",
      "playbook-selection",
      "specialist-analysis",
      "critique",
      "final-synthesis",
      "final-synthesis",
    ]);
    expect(retryPrompt.reportValidationErrors).toContain(
      "keyFindings[0] must reference at least one source ID; bullCase[0] must reference at least one source ID; bearCase[0] must reference at least one source ID; risks[0] must reference at least one source ID; catalysts[0] must reference at least one source ID; scenarios[0] must reference at least one source ID",
    );
    expect(retryPrompt.allowedSourceIds).toEqual(["market-aapl", "news-equity-1"]);
    expect(result.trace.reportValidationRetryErrors).toEqual([
      "keyFindings[0] must reference at least one source ID; bullCase[0] must reference at least one source ID; bearCase[0] must reference at least one source ID; risks[0] must reference at least one source ID; catalysts[0] must reference at least one source ID; scenarios[0] must reference at least one source ID",
    ]);
  });

  test("repairs a research-only language violation on reprompt", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const violatingReport = JSON.stringify({
      summary: "Evidence is sourced and investors should accumulate exposure here.",
      keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
      bullCase: [{ text: "Breadth is supported.", sourceIds: ["market-aapl"] }],
      bearCase: [{ text: "Breadth is limited.", sourceIds: ["market-aapl"] }],
      risks: [{ text: "Breadth can reverse.", sourceIds: ["market-aapl"] }],
      catalysts: [{ text: "Demand is visible.", sourceIds: ["market-aapl"] }],
      scenarios: [{ name: "Base", description: "Momentum continues.", sourceIds: ["market-aapl"] }],
      confidence: "medium",
      dataGaps: [],
      predictions: mockPredictions(2),
    });
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);
        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
          return {
            content: finalCalls === 1 ? violatingReport : modelReport("SPY"),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        return { content: modelReport("SPY"), tokenEstimate: 100, costEstimateUsd: 0.01 };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const retryPrompt = finalPrompts[1] ?? {};
    expect(finalPrompts).toHaveLength(2);
    const repair = String(retryPrompt.reportLanguageRepair);
    const clauses = readerDirectedAdviceClauses('"');
    expect(repair).toContain("research-only");
    expect(repair).toContain(`${clauses.subject};`);
    expect(repair).toContain(`${clauses.imperative}.`);
    expect(result.trace.reportValidationRetryErrors?.[0]).toContain("trade-action language");
    expect(result.report.summary).not.toContain("investors should");
  });

  test("fails with a clear error when the language violation persists", async () => {
    let finalCalls = 0;
    const violatingReport = JSON.stringify({
      summary: "Investors should accumulate exposure across the breadth setup.",
      keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
      bullCase: [{ text: "Breadth is supported.", sourceIds: ["market-aapl"] }],
      bearCase: [{ text: "Breadth is limited.", sourceIds: ["market-aapl"] }],
      risks: [{ text: "Breadth can reverse.", sourceIds: ["market-aapl"] }],
      catalysts: [{ text: "Demand is visible.", sourceIds: ["market-aapl"] }],
      scenarios: [{ name: "Base", description: "Momentum continues.", sourceIds: ["market-aapl"] }],
      confidence: "medium",
      dataGaps: [],
      predictions: mockPredictions(2),
    });
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
          return { content: violatingReport, tokenEstimate: 100, costEstimateUsd: 0.01 };
        }
        return { content: modelReport("SPY"), tokenEstimate: 100, costEstimateUsd: 0.01 };
      },
    };

    let rejection: unknown;
    try {
      await runResearchJob({
        command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
        config,
        provider,
        collectedSources: collectedSourceBundle({
          rawSnapshots: [],
          marketSnapshots,
          newsSources,
          sourceGaps: [],
        }),
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
    } catch (error: unknown) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(FinalSynthesisRejectedError);
    const rejected = rejection as FinalSynthesisRejectedError;
    expect(rejected.message).toMatch(
      /Report failed validation after 4 final-synthesis call\(s\) \(3 report-repair reprompt\(s\)\)/u,
    );
    expect(rejected.stageOutputs).toHaveLength(4);
    expect(rejected.stageOutputs.map((output) => output.attempt)).toEqual([1, 2, 3, 4]);
    expect(rejected.reportValidationErrors).toHaveLength(1);
    expect(rejected.reportValidationErrors[0]).toContain("trade-action language");
    expect(rejected.predictionErrors).toEqual([]);
    expect(rejected.payload).toEqual(JSON.parse(violatingReport));
    // Initial synthesis + one report-validation reprompt + two bounded repair reprompts.
    expect(finalCalls).toBe(4);
  });

  test("fails fast, spending no repair reprompt, when the wording is not in the model draft", async () => {
    let finalCalls = 0;
    const cleanReport = modelReport("SPY");
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
        }
        return { content: cleanReport, tokenEstimate: 100, costEstimateUsd: 0.01 };
      },
    };

    let rejection: unknown;
    try {
      await runResearchJob({
        command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
        config,
        provider,
        collectedSources: collectedSourceBundle({
          rawSnapshots: [],
          marketSnapshots,
          newsSources,
          sourceGaps: [],
          webSubjectProfile: poisonedWebSubjectProfile,
        }),
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
    } catch (error: unknown) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(FinalSynthesisRejectedError);
    const rejected = rejection as FinalSynthesisRejectedError;
    // One final-synthesis call, zero repair reprompts: the doomed signature is recognized at the
    // Point the first reprompt would have been sent.
    expect(finalCalls).toBe(1);
    expect(rejected.totalCalls).toBe(1);
    expect(rejected.reportRepairReprompts).toBe(0);
    expect(rejected.message).toContain("repair stopped early");
    expect(rejected.message).toContain('"price targets"');
    expect(rejected.message).toContain("extras.webSubjectProfile.openGaps[0]");
    expect(rejected.reportValidationErrors[0]).toContain("trade-action language");
    // The draft itself is clean, which is exactly what failure.json records as languageViolations.
    expect(modelPayloadLanguageViolations(rejected.payload)).toEqual([]);
  });

  /*
   * The sentence-initial pattern eats the boundary character before the verb, so the joined scan
   * returns ".\nBuy" here while the openGaps field alone returns "Buy" -- factLedger's
   * "Revenue grew." is the segment immediately before it. Attribution has to see through that
   * consumed delimiter, or the digest field goes unnamed and the run burns its whole repair
   * budget on profile wording no draft can reach.
   */
  test("fails fast when a trade verb opens the digest field right after a field ending in a period", async () => {
    let finalCalls = 0;
    const cleanReport = modelReport("SPY");
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
        }
        return { content: cleanReport, tokenEstimate: 100, costEstimateUsd: 0.01 };
      },
    };

    let rejection: unknown;
    try {
      await runResearchJob({
        command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
        config,
        provider,
        collectedSources: collectedSourceBundle({
          rawSnapshots: [],
          marketSnapshots,
          newsSources,
          sourceGaps: [],
          webSubjectProfile: {
            ...baseWebSubjectProfile,
            openGaps: ["Buy the dip is the only framing the supplied sources offer."],
          },
        }),
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
    } catch (error: unknown) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(FinalSynthesisRejectedError);
    const rejected = rejection as FinalSynthesisRejectedError;
    expect(finalCalls).toBe(1);
    expect(rejected.totalCalls).toBe(1);
    expect(rejected.reportRepairReprompts).toBe(0);
    expect(rejected.message).toContain("repair stopped early");
    expect(rejected.message).toContain("extras.webSubjectProfile.openGaps[0]");
    expect(modelPayloadLanguageViolations(rejected.payload)).toEqual([]);
  });

  test("still repairs when the model draft carries the violation alongside a clean profile", async () => {
    let finalCalls = 0;
    const violatingReport = JSON.stringify({
      summary: "Evidence is sourced and investors should accumulate exposure here.",
      keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
      bullCase: [{ text: "Breadth is supported.", sourceIds: ["market-aapl"] }],
      bearCase: [{ text: "Breadth is limited.", sourceIds: ["market-aapl"] }],
      risks: [{ text: "Breadth can reverse.", sourceIds: ["market-aapl"] }],
      catalysts: [{ text: "Demand is visible.", sourceIds: ["market-aapl"] }],
      scenarios: [{ name: "Base", description: "Momentum continues.", sourceIds: ["market-aapl"] }],
      confidence: "medium",
      dataGaps: [],
      predictions: mockPredictions(2),
    });
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
          return { content: violatingReport, tokenEstimate: 100, costEstimateUsd: 0.01 };
        }
        return { content: modelReport("SPY"), tokenEstimate: 100, costEstimateUsd: 0.01 };
      },
    };

    let rejection: unknown;
    try {
      await runResearchJob({
        command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
        config,
        provider,
        collectedSources: collectedSourceBundle({
          rawSnapshots: [],
          marketSnapshots,
          newsSources,
          sourceGaps: [],
          webSubjectProfile: cleanWebSubjectProfile,
        }),
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
    } catch (error: unknown) {
      rejection = error;
    }

    const rejected = rejection as FinalSynthesisRejectedError;
    expect(rejected.message).not.toContain("repair stopped early");
    expect(rejected.reportRepairReprompts).toBe(3);
    // Initial synthesis + one report-validation reprompt + two bounded repair reprompts.
    expect(finalCalls).toBe(4);
  });

  test("keeps the full repair budget when the failure is not a language violation", async () => {
    let finalCalls = 0;
    const uncitedReport = JSON.stringify({
      summary: "Evidence is sourced.",
      keyFindings: [{ text: "AAPL moved.", sourceIds: [] }],
      bullCase: [{ text: "Breadth is supported.", sourceIds: [] }],
      bearCase: [{ text: "Breadth is limited.", sourceIds: [] }],
      risks: [{ text: "Breadth can reverse.", sourceIds: [] }],
      catalysts: [{ text: "Demand is visible.", sourceIds: [] }],
      scenarios: [{ name: "Base", description: "Momentum continues.", sourceIds: [] }],
      confidence: "medium",
      dataGaps: [],
      predictions: mockPredictions(2),
    });
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
          return { content: uncitedReport, tokenEstimate: 100, costEstimateUsd: 0.01 };
        }
        return { content: modelReport("SPY"), tokenEstimate: 100, costEstimateUsd: 0.01 };
      },
    };

    let rejection: unknown;
    try {
      await runResearchJob({
        command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
        config,
        provider,
        collectedSources: collectedSourceBundle({
          rawSnapshots: [],
          marketSnapshots,
          newsSources,
          sourceGaps: [],
          webSubjectProfile: poisonedWebSubjectProfile,
        }),
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
    } catch (error: unknown) {
      rejection = error;
    }

    const rejected = rejection as FinalSynthesisRejectedError;
    // Source-ID errors are raised before the language gate, so the doomed profile wording never
    // Surfaces and the fail-fast guard stays out of the way: the repairable failure keeps its
    // Whole budget.
    expect(rejected.message).not.toContain("repair stopped early");
    expect(rejected.reportValidationErrors[0]).toContain("must reference at least one source ID");
    expect(rejected.reportRepairReprompts).toBe(3);
    expect(finalCalls).toBe(4);
  });

  // The sentence-initial shape the payload scan used to miss (AGENTS.md: keep the newline
  // Delimiter). The wording is the draft's own, so it is repairable and must keep every reprompt.
  test("keeps the full repair budget when the draft's own prose opens with a trade verb", async () => {
    let finalCalls = 0;
    const buyTheDipReport = JSON.stringify({
      summary: "Buy the dip while breadth is still supported.",
      keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
      bullCase: [{ text: "Breadth is supported.", sourceIds: ["market-aapl"] }],
      bearCase: [{ text: "Breadth is limited.", sourceIds: ["market-aapl"] }],
      risks: [{ text: "Breadth can reverse.", sourceIds: ["market-aapl"] }],
      catalysts: [{ text: "Demand is visible.", sourceIds: ["market-aapl"] }],
      scenarios: [{ name: "Base", description: "Momentum continues.", sourceIds: ["market-aapl"] }],
      confidence: "medium",
      dataGaps: [],
      predictions: mockPredictions(2),
    });
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
          return { content: buyTheDipReport, tokenEstimate: 100, costEstimateUsd: 0.01 };
        }
        return { content: modelReport("SPY"), tokenEstimate: 100, costEstimateUsd: 0.01 };
      },
    };

    let rejection: unknown;
    try {
      await runResearchJob({
        command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
        config,
        provider,
        collectedSources: collectedSourceBundle({
          rawSnapshots: [],
          marketSnapshots,
          newsSources,
          sourceGaps: [],
          webSubjectProfile: cleanWebSubjectProfile,
        }),
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
    } catch (error: unknown) {
      rejection = error;
    }

    const rejected = rejection as FinalSynthesisRejectedError;
    expect(rejected.message).not.toContain("repair stopped early");
    expect(rejected.reportRepairReprompts).toBe(3);
    expect(finalCalls).toBe(4);
    // The diagnostic sees the same wording the report gate did, so failure.json cannot claim the
    // Draft was clean.
    expect(modelPayloadLanguageViolations(rejected.payload)).toEqual([
      { field: "summary", match: "Buy" },
    ]);
  });

  // Assembly text a draft can replace is repairable: mergeSpotlightsExtra lets the synthesis draft
  // Overwrite the selection rationale, so a violating selector rationale keeps the full budget even
  // Though the current draft omits spotlights entirely.
  test("keeps the full repair budget when the wording is in draft-overridable assembly text", async () => {
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "spotlight-selection") {
          return {
            content: JSON.stringify({
              rationale: "Ranked on where the peer price target spread is widest.",
              selections: [
                {
                  symbol: "AAPL",
                  rationale: "Liquid positive mover with current market evidence.",
                  sourceIds: ["market-aapl"],
                },
              ],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
        }
        return { content: modelReport("SPY"), tokenEstimate: 100, costEstimateUsd: 0.01 };
      },
    };

    let rejection: unknown;
    try {
      await runResearchJob({
        command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
        config,
        provider,
        collectedSources: collectedSourceBundle({
          rawSnapshots: [],
          marketSnapshots,
          newsSources,
          sourceGaps: [],
          webSubjectProfile: cleanWebSubjectProfile,
        }),
        now: new Date("2026-05-19T00:00:00.000Z"),
      });
    } catch (error: unknown) {
      rejection = error;
    }

    const rejected = rejection as FinalSynthesisRejectedError;
    expect(rejected.reportValidationErrors[0]).toContain("price target");
    expect(rejected.message).not.toContain("repair stopped early");
    expect(rejected.reportRepairReprompts).toBe(3);
    expect(finalCalls).toBe(4);
    // The draft never carried the wording, and that alone is not grounds to stop repairing.
    expect(modelPayloadLanguageViolations(rejected.payload)).toEqual([]);
  });

  /*
   * No Web Subject Profile was collected, so projectExtendedEvidenceReportExtras omits the key and
   * Assembly keeps `extras.webSubjectProfile` straight from the draft -- the model's own prose,
   * Which the next draft can simply not write. Classifying the key as code-assembled without
   * Checking that a digest was actually collected stopped the repair here after one call
   * ("Absence is a finding, not a no-op", AGENTS.md).
   */
  test("keeps the full repair budget when the draft authored a profile the run never collected", async () => {
    let finalCalls = 0;
    const draftAuthoredProfileReport = JSON.stringify({
      ...(JSON.parse(modelReport("SPY")) as Record<string, unknown>),
      extras: { webSubjectProfile: { openGaps: ["No price targets available."] } },
    });
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
          return {
            content: finalCalls === 1 ? draftAuthoredProfileReport : modelReport("SPY"),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }
        return { content: modelReport("SPY"), tokenEstimate: 100, costEstimateUsd: 0.01 };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    // One repair reprompt spent and the run completes: the rejection was repairable after all.
    expect(finalCalls).toBe(2);
    expect(result.trace.reportValidationRetryErrors?.join(" ")).toContain("trade-action language");
    expect(result.report.extras?.webSubjectProfile).toBeUndefined();
  });

  test("discloses absent Tradier options as a data gap without source-id retry", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0,
          };
        }

        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
          const allowedSourceIds = Array.isArray(prompt.allowedSourceIds)
            ? prompt.allowedSourceIds.filter((value): value is string => typeof value === "string")
            : [];
          const guidance =
            typeof prompt.sourceIdGuidance === "string" ? prompt.sourceIdGuidance : "";
          const hasGapGuidance =
            allowedSourceIds.includes("market-aapl") &&
            !allowedSourceIds.includes("tradier-options") &&
            guidance.includes("tradier-options") &&
            guidance.includes("dataGaps");

          return {
            content: JSON.stringify({
              summary: "AAPL evidence is sourced.",
              keyFindings: [
                {
                  text: "AAPL has a current market snapshot.",
                  sourceIds: [hasGapGuidance ? "market-aapl" : "tradier-options"],
                },
              ],
              bullCase: [
                { text: "Market evidence supports the setup.", sourceIds: ["market-aapl"] },
              ],
              bearCase: [{ text: "Options IV evidence is absent.", sourceIds: ["market-aapl"] }],
              risks: [
                { text: "Options coverage remains unavailable.", sourceIds: ["market-aapl"] },
              ],
              catalysts: [
                { text: "Market data is the visible input.", sourceIds: ["market-aapl"] },
              ],
              scenarios: [
                {
                  name: "Base",
                  description: "Evidence remains limited without options IV.",
                  sourceIds: ["market-aapl"],
                },
              ],
              confidence: "medium",
              dataGaps: hasGapGuidance
                ? ["tradier-options: missing MARKET_BOT_TRADIER_API_TOKEN"]
                : [],
              predictions: mockPredictions(2, "AAPL"),
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        return {
          content: modelReport("AAPL"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config: { ...config, dataDir: tempDataDir("market-bot-tradier-gap") },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [
          sourceGap({
            source: "tradier-options",
            message: "missing MARKET_BOT_TRADIER_API_TOKEN",
            capability: "extended-evidence",
            cause: "missing-credential",
            evidenceQualityImpact: "extended-evidence-cap",
          }),
        ],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const finalPrompt = finalPrompts[0] ?? {};

    expect(finalCalls).toBe(1);
    expect(finalPrompts).toHaveLength(1);
    expect(finalPrompt.allowedSourceIds).toEqual(["market-aapl", "news-equity-1"]);
    expect(finalPrompt.sourceIdGuidance).toContain("dataGaps");
    expect(result.trace.reportValidationRetryErrors).toBeUndefined();
    expect(result.report.dataGaps).toContain(
      "tradier-options: missing MARKET_BOT_TRADIER_API_TOKEN",
    );
    expect(result.report.keyFindings[0]?.sourceIds).toEqual(["market-aapl"]);
  });

  test("keeps prediction retry guidance when report validation also retries synthesis", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const invalidRelativePrediction = {
      id: "bad-relative",
      claim: "QQQ outperforms SPY over 5 trading days.",
      kind: "relative",
      subject: "DIA",
      measurableAs: "close(QQQ, +5)/close(QQQ, 0) > close(SPY, +5)/close(SPY, 0)",
      horizonTradingDays: 5,
      probability: 0.55,
      sourceIds: ["market-aapl"],
    };
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
        }

        if (prompt.stage === "final-synthesis" && finalCalls === 1) {
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [invalidRelativePrediction, ...mockPredictions(1)],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        if (prompt.stage === "final-synthesis" && (finalCalls === 2 || finalCalls === 3)) {
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "AAPL moved.", sourceIds: [] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [invalidRelativePrediction, ...mockPredictions(1)],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        return {
          content: modelReport("SPY"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const reportRetryPrompt = finalPrompts[3] ?? {};

    expect(finalPrompts).toHaveLength(4);
    expect(reportRetryPrompt.reportValidationErrors).toContain(
      "keyFindings[0] must reference at least one source ID",
    );
    expect(reportRetryPrompt.predictionRepromptErrors).toContain(
      "Prediction bad-relative: subject does not match measurableAs",
    );
    // The validation error keeps the reprompt alive; a count shortfall never does (ADR 0003).
    expect(
      (reportRetryPrompt.predictionRepromptErrors as readonly string[] | undefined)?.some(
        (reason) => reason.includes("predictionShortfall"),
      ),
    ).toBe(false);
    expect(result.trace.predictionRetryErrors).toContain(
      "Prediction bad-relative: subject does not match measurableAs",
    );
    const finalOutputs = result.stageOutputs.filter((output) => output.stage === "final-synthesis");
    expect(finalOutputs[0]?.attempt).toBe(1);
    expect(finalOutputs[0]?.repromptReason).toBeUndefined();
    // Attempt 1 records the primary prediction steering and no repair steering.
    expect(finalOutputs[0]?.steering).toContain(
      "predictions using subjects from predictionSubjects",
    );
    expect(finalOutputs[0]?.steering).not.toContain("fixing the flagged predictions");
    expect(finalOutputs[1]?.attempt).toBe(2);
    expect(finalOutputs[1]?.repromptReason?.predictionErrors).toContain(
      "Prediction bad-relative: subject does not match measurableAs",
    );
    // Attempt 2 is a prediction reprompt, so its steering carries the repair instruction.
    expect(finalOutputs[1]?.steering).toContain("fixing the flagged predictions");
    const traceFinalRecords = result.trace.stageRecords?.filter(
      (record) => record.stage === "final-synthesis",
    );
    expect(traceFinalRecords?.[0]?.attempt).toBe(1);
    expect(traceFinalRecords?.[1]?.attempt).toBe(2);
    const analyticsFinalRecords = result.analytics.runShape.stages.filter(
      (record) => record.stage === "final-synthesis",
    );
    expect(analyticsFinalRecords[0]?.attempt).toBe(1);
    expect(analyticsFinalRecords[1]?.repromptReason?.predictionErrors).toContain(
      "Prediction bad-relative: subject does not match measurableAs",
    );
  });

  test("normalizes duplicate and overlapping source gaps before source planning and analytics", async () => {
    const grossProfitGap = sourceGap({
      source: "sec-edgar",
      message: "Missing SEC company facts: grossProfit",
      capability: "extended-evidence",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });
    const grossProfitDuplicate = sourceGap({
      source: "sec-edgar",
      message: " Missing SEC   company facts: grossProfit ",
      capability: "extended-evidence",
      cause: "validation-failed",
      evidenceQualityImpact: "core-cap",
    });
    const overlappingGap = sourceGap({
      source: "sec-edgar",
      message: "Missing SEC company facts: grossProfit, capex",
      capability: "extended-evidence",
      cause: "provider-data-missing",
      evidenceQualityImpact: "extended-evidence-cap",
    });
    const macroContextGap = sourceGap({
      source: "fred-market-context",
      message: "Missing macro context: DGS10",
      capability: "market-context",
      cause: "provider-data-missing",
    });
    const macroContextDuplicate = sourceGap({
      source: "fred-market-context",
      message: " Missing macro   context: DGS10 ",
      capability: "market-context",
      cause: "validation-failed",
    });
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        if (prompt.stage === "playbook-selection") {
          return {
            content: JSON.stringify({ selections: [] }),
            tokenEstimate: 10,
            costEstimateUsd: 0,
          };
        }
        return { content: modelReport("AAPL"), tokenEstimate: 100, costEstimateUsd: 0.01 };
      },
    };

    const result = await runResearchJob({
      command: { jobType: "equity", assetClass: "equity", symbol: "AAPL", depth: "brief" },
      config: { ...config, dataDir: tempDataDir("market-bot-source-gap-dedupe") },
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        extendedEvidence: {
          instrument: { symbol: "AAPL", assetClass: "equity" },
          items: [],
          gaps: [grossProfitGap, grossProfitDuplicate, overlappingGap],
        },
        marketContext: {
          assetClass: "equity",
          items: [],
          gaps: [macroContextGap, macroContextDuplicate],
        },
        sourceGaps: [grossProfitGap, grossProfitDuplicate, overlappingGap],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const regulatoryLane = result.evidenceLanes.lanes.find(
      (lane) => lane.lane === "regulatory-filings",
    );

    // The exact-context duplicate is deduped and the nested grossProfit gap is folded into
    // The wider grossProfit, capex gap, leaving a single consolidated sec-edgar gap.
    // Missing statement sourcing still blocks completeness, but does not establish issuer staleness.
    expect(result.collectedSources.sourceGaps).toEqual([{ ...overlappingGap, triage: "material" }]);
    expect(result.collectedSources.extendedEvidence?.gaps).toEqual([overlappingGap]);
    expect(result.collectedSources.marketContext?.gaps).toEqual([macroContextGap]);
    expect(regulatoryLane?.gapText).toEqual([
      "sec-edgar: Missing SEC company facts: grossProfit, capex",
    ]);
    expect(regulatoryLane?.gapIds).toHaveLength(1);
    expect(result.analytics.sourceFunnel.sourceGaps).toEqual({
      total: 1,
      bySource: { "sec-edgar": 1 },
      byTriage: { material: 1 },
    });
    expect(result.analytics.evidenceQuality.extendedEvidence.gapCount).toBe(1);
    expect(result.analytics.evidenceQuality.marketContext.gapCount).toBe(1);
    expect(result.analytics.evidenceLanes?.gapCount).toBe(result.evidenceLanes.summary.gapCount);
    expect(result.trace.evidenceLanes?.gapCount).toBe(result.evidenceLanes.summary.gapCount);
    expect(result.report.dataGaps).toContain(
      "sec-edgar: Missing SEC company facts: grossProfit, capex",
    );
    expect(result.report.dataGaps).not.toContain(
      "sec-edgar: Missing SEC company facts: grossProfit",
    );
  });

  test("re-prompts when report validation retry regresses prediction validity", async () => {
    const prompts: Record<string, unknown>[] = [];
    let finalCalls = 0;
    const invalidRelativePrediction = {
      id: "bad-relative",
      claim: "QQQ outperforms SPY over 5 trading days.",
      kind: "relative",
      subject: "DIA",
      measurableAs: "close(QQQ, +5)/close(QQQ, 0) > close(SPY, +5)/close(SPY, 0)",
      horizonTradingDays: 5,
      probability: 0.55,
      sourceIds: ["market-aapl"],
    };
    const provider: ModelProvider = {
      name: "mock",
      generate: async (request) => {
        const prompt = JSON.parse(request.messages[1]?.content ?? "{}") as Record<string, unknown>;
        prompts.push(prompt);

        if (prompt.stage === "final-synthesis") {
          finalCalls += 1;
        }

        if (prompt.stage === "final-synthesis" && finalCalls === 1) {
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "AAPL moved.", sourceIds: [] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: mockPredictions(2),
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        if (prompt.stage === "final-synthesis" && finalCalls === 2) {
          return {
            content: JSON.stringify({
              summary: "Evidence is sourced.",
              keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
              bullCase: [],
              bearCase: [],
              risks: [],
              catalysts: [],
              scenarios: [],
              confidence: "medium",
              dataGaps: [],
              predictions: [invalidRelativePrediction, ...mockPredictions(1)],
            }),
            tokenEstimate: 100,
            costEstimateUsd: 0.01,
          };
        }

        return {
          content: modelReport("SPY"),
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        };
      },
    };

    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider,
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });
    const finalPrompts = prompts.filter((prompt) => prompt.stage === "final-synthesis");
    const combinedRetryPrompt = finalPrompts[2] ?? {};

    expect(finalPrompts).toHaveLength(3);
    expect(combinedRetryPrompt.reportValidationErrors).toContain(
      "keyFindings[0] must reference at least one source ID",
    );
    expect(combinedRetryPrompt.predictionRepromptErrors).toContain(
      "Prediction bad-relative: subject does not match measurableAs",
    );
    expect(result.report.predictions.length).toBeGreaterThanOrEqual(2);
  });

  test("logs prediction validation errors to trace when malformed predictions are dropped", async () => {
    const result = await runResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config,
      provider: providerReturning(
        JSON.stringify({
          summary: "Evidence is sourced.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [],
          bearCase: [],
          risks: [],
          catalysts: [],
          scenarios: [],
          confidence: "medium",
          dataGaps: [],
          predictions: [
            {
              id: "bad-1",
              kind: "invalid-kind",
              claim: "x",
              subject: "SPY",
              measurableAs: "close(SPY, +5) > close(SPY, 0)",
              horizonTradingDays: 5,
              probability: 0.6,
              sourceIds: [],
            },
            {
              id: "bad-2",
              kind: "direction",
              claim: "x",
              subject: "SPY",
              measurableAs: "close(SPY, +5) > close(SPY, 0)",
              horizonTradingDays: 30,
              probability: 0.6,
              sourceIds: [],
            },
            ...mockPredictions(2),
          ],
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources,
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    expect(result.report.predictions).toHaveLength(2);
    expect(result.trace.predictionErrors).toBeDefined();
    expect(result.trace.predictionErrors?.length).toBe(2);
  });

  test("records attached report news in the seen index after persistence", async () => {
    const dataDir = join(
      tmpdir(),
      `market-bot-news-seen-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const newsSeenPath = join(dataDir, "news-seen.json");
    dataDirs.push(dataDir);

    const result = await persistResearchJob({
      command: legacyMarketOverviewCommand("daily", { assetClass: "equity", depth: "brief" }),
      config: {
        ...config,
        dataDir,
        sourceOptions: {
          ...config.sourceOptions,
          newsSeenPath,
          newsSeenRetentionDays: 30,
        },
      },
      provider: providerReturning(
        JSON.stringify({
          summary: "Core market evidence is available.",
          keyFindings: [{ text: "AAPL moved.", sourceIds: ["market-aapl"] }],
          bullCase: [{ text: "Supplier news supports breadth.", sourceIds: ["news-equity-1"] }],
          bearCase: [{ text: "Single-name breadth is limited.", sourceIds: ["market-aapl"] }],
          risks: [{ text: "Breadth can reverse.", sourceIds: ["market-aapl"] }],
          catalysts: [{ text: "Supplier demand is visible.", sourceIds: ["news-equity-1"] }],
          scenarios: [
            {
              name: "Base",
              description: "Momentum continues if liquidity persists.",
              sourceIds: ["market-aapl"],
            },
          ],
          confidence: "high",
          dataGaps: [],
          predictions: mockPredictions(2),
        }),
      ),
      collectedSources: collectedSourceBundle({
        rawSnapshots: [],
        marketSnapshots,
        newsSources: [
          newsSource({
            title: "Apple supplier demand improves",
            url: "https://example.test/apple-suppliers?utm_source=feed",
            provider: "yahoo-news",
          }),
        ],
        sourceGaps: [],
      }),
      now: new Date("2026-05-19T00:00:00.000Z"),
    });

    const entries = await readNewsSeenEntries(newsSeenPath);

    expect(await Bun.file(join(result.artifacts.runDir, "report.json")).exists()).toBe(true);
    expect(entries).toMatchObject([
      {
        lane: "market-overview:equity",
        canonicalUrl: "https://example.test/apple-suppliers",
        title: "Apple supplier demand improves",
        provider: "yahoo-news",
        firstRunId: result.report.runId,
        lastRunId: result.report.runId,
      },
    ]);
  });
});
