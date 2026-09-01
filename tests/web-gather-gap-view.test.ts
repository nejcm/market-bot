import { describe, expect, test } from "bun:test";
import type { ResearchCommand } from "../src/cli/args";
import { sourceGap } from "../src/domain/source-gaps";
import type { SourceGap } from "../src/domain/types";
import { deterministicSourceGapEntries } from "../src/research/deterministic-gaps";
import { buildEvidencePayload } from "../src/research/prompts/evidence-payload";
import type { SourceGapView } from "../src/research/prompts/source-gap-view";
import { assessSourcePlan, buildSourcePlan } from "../src/research/source-plan";
import {
  frameworkGaps,
  QUALITATIVE_GAPS,
} from "../src/sources/extended-evidence/business-framework";
import type { CollectedSources } from "../src/sources/types";
import {
  collectedSources,
  marketSnapshot,
  newsSource,
  verifiedMarketSnapshot,
} from "./support/fixtures";
import {
  config,
  contextWithHistory,
  stagePromptFromArgs,
} from "./support/research-context-helpers";

const command: ResearchCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
};
const generatedAt = "2026-05-19T00:00:00.000Z";

const unsupportedAnalystRange = sourceGap({
  source: "finnhub-analyst-range",
  message: "Analyst price-target distribution unavailable: request failed with status 403",
  cause: "unsupported-coverage",
  capability: "extended-evidence",
  evidenceQualityImpact: "no-cap",
});
const missingCredentialAnalystRange = sourceGap({
  source: "finnhub-analyst-range",
  message: "Analyst price-target distribution unavailable: missing Finnhub credential",
  cause: "missing-credential",
  capability: "extended-evidence",
  evidenceQualityImpact: "no-cap",
});
const analystConsensus = frameworkGaps(
  "AAPL",
  QUALITATIVE_GAPS.filter((gap) => gap.code === "analyst-consensus"),
)[0]!;
const segmentMix = frameworkGaps(
  "AAPL",
  QUALITATIVE_GAPS.filter((gap) => gap.code === "segment-mix"),
)[0]!;
const epsEstimate = sourceGap({
  source: "finnhub-eps-estimate",
  message: "Forward EPS estimate unavailable",
  capability: "extended-evidence",
  cause: "provider-data-missing",
});
const secCompanyFacts = sourceGap({
  source: "sec-edgar",
  message: "Company facts unavailable",
  capability: "extended-evidence",
  cause: "provider-data-missing",
});
const marketauxNews = sourceGap({
  source: "marketaux-news",
  message: "News unavailable",
  capability: "news",
  cause: "fetch-failed",
});

const droppedGaps = [unsupportedAnalystRange, analystConsensus] as const;
const allGaps = [
  segmentMix,
  unsupportedAnalystRange,
  epsEstimate,
  analystConsensus,
  secCompanyFacts,
  marketauxNews,
] as const;

function sourcesWithGaps(
  sourceGaps: readonly SourceGap[] = allGaps,
  overrides: Partial<CollectedSources> = {},
): CollectedSources {
  return collectedSources({
    marketSnapshots: [marketSnapshot()],
    newsSources: [newsSource()],
    verifiedMarketSnapshot: verifiedMarketSnapshot(),
    sourceGaps,
    ...overrides,
  });
}

function payload(view: SourceGapView, sources: CollectedSources): Record<string, unknown> {
  return buildEvidencePayload(
    { includePriorCalibration: false, sourceGapView: view, webSourceText: "metadata" },
    command,
    sources,
    config,
    contextWithHistory(command),
  );
}

function sourceGapTexts(value: Record<string, unknown>): readonly string[] {
  return value.sourceGaps as readonly string[];
}

describe("Web Gather Source Gap view", () => {
  test("drops every finnhub analyst-range variant from sourceGaps", () => {
    const texts = sourceGapTexts(
      payload(
        "web-gather",
        sourcesWithGaps([unsupportedAnalystRange, missingCredentialAnalystRange, segmentMix]),
      ),
    );

    expect(texts.some((text) => text.includes("finnhub-analyst-range"))).toBe(false);
    expect(texts.some((text) => text.includes("segment-mix"))).toBe(true);
  });

  test("drops the Business Framework analyst-consensus gap", () => {
    const texts = sourceGapTexts(
      payload("web-gather", sourcesWithGaps([analystConsensus, segmentMix])),
    );

    expect(texts.some((text) => text.includes("analyst-consensus"))).toBe(false);
    expect(texts.some((text) => text.includes("segment-mix"))).toBe(true);
  });

  test("keeps web-closable gaps", () => {
    const texts = sourceGapTexts(
      payload(
        "web-gather",
        sourcesWithGaps([
          ...frameworkGaps("AAPL", QUALITATIVE_GAPS),
          epsEstimate,
          secCompanyFacts,
          marketauxNews,
        ]),
      ),
    );

    for (const { code } of QUALITATIVE_GAPS) {
      expect(texts.some((text) => text.includes(code))).toBe(code !== "analyst-consensus");
    }
    for (const expected of ["finnhub-eps-estimate", "sec-edgar", "marketaux-news"]) {
      expect(texts.some((text) => text.includes(expected))).toBe(true);
    }
  });

  test("narrows extendedEvidence gaps while preserving sibling order", () => {
    const extendedGaps = (
      payload(
        "web-gather",
        sourcesWithGaps(allGaps, {
          extendedEvidence: {
            instrument: { symbol: "AAPL", assetClass: "equity" },
            items: [],
            gaps: allGaps,
          },
        }),
      ).extendedEvidence as { readonly gaps: readonly SourceGap[] }
    ).gaps;

    expect(extendedGaps).toEqual([segmentMix, epsEstimate, secCompanyFacts, marketauxNews]);
  });

  test("narrows marketContext gaps", () => {
    const marketContext = payload(
      "web-gather",
      sourcesWithGaps([], {
        marketContext: {
          assetClass: "equity",
          items: [],
          gaps: [unsupportedAnalystRange, segmentMix],
        },
      }),
    ).marketContext as { readonly gaps: readonly SourceGap[] };

    expect(marketContext.gaps).toEqual([segmentMix]);
  });

  test("leaves reused Web Subject Profile openGaps byte-identical", () => {
    const openGaps = [
      "The supplied excerpts do not provide customer concentration, repeat-purchase rates, pricing elasticity, or analyst consensus.",
    ];
    const sources = sourcesWithGaps(droppedGaps, {
      webSubjectProfile: {
        version: 2,
        generatedAt,
        subjectKind: "company",
        subjectId: "AAPL",
        symbol: "AAPL",
        subjectSummary: { answer: "Apple makes consumer devices.", sourceIds: ["web-aapl"] },
        recentMaterialEvents: [],
        factLedger: [],
        openGaps,
        sourceIds: ["web-aapl"],
        questions: {
          whatItDoes: { answer: "Devices.", sourceIds: ["web-aapl"] },
          howItMakesMoney: { answer: "Sales.", sourceIds: ["web-aapl"] },
          customers: { answer: "Consumers.", sourceIds: ["web-aapl"] },
          geography: { answer: "Global.", sourceIds: ["web-aapl"] },
          purchaseRecurrence: { answer: "Mixed.", sourceIds: ["web-aapl"] },
          pricingPower: { answer: "Unknown.", sourceIds: ["web-aapl"] },
          recessionCyclicality: { answer: "Unknown.", sourceIds: ["web-aapl"] },
        },
      },
    });
    const allOpenGaps = (payload("all", sources).webSubjectProfile as { openGaps: string[] })
      .openGaps;
    const gatherOpenGaps = (
      payload("web-gather", sources).webSubjectProfile as { openGaps: string[] }
    ).openGaps;

    expect(JSON.stringify(gatherOpenGaps)).toBe(JSON.stringify(allOpenGaps));
    expect(gatherOpenGaps).toBe(openGaps);
  });

  test("keeps both dropped gaps visible to every other prompt stage", () => {
    const sources = sourcesWithGaps(droppedGaps, {
      extendedEvidence: {
        instrument: { symbol: "AAPL", assetClass: "equity" },
        items: [],
        gaps: droppedGaps,
      },
    });

    for (const stage of [
      "final-synthesis",
      "evidence-request",
      "specialist-analysis",
      "web-subject-profile",
    ] as const) {
      const parsed = JSON.parse(
        stagePromptFromArgs(stage, command, sources, config, contextWithHistory(command), {
          system: "Research only.",
          instruction: "Analyze.",
          goal: "Find evidence.",
        }),
      ) as {
        evidence: {
          sourceGaps: readonly string[];
          extendedEvidence: { readonly gaps: readonly SourceGap[] };
        };
      };

      expect(
        parsed.evidence.sourceGaps.some((text) => text.includes("finnhub-analyst-range")),
      ).toBe(true);
      expect(parsed.evidence.sourceGaps.some((text) => text.includes("analyst-consensus"))).toBe(
        true,
      );
      expect(parsed.evidence.extendedEvidence.gaps).toEqual(droppedGaps);
    }
  });

  test("does not mutate or hide gaps from deterministic report projection", () => {
    const sourceGaps = [...droppedGaps];
    const sources = sourcesWithGaps(sourceGaps);

    payload("web-gather", sources);

    const reportGaps = deterministicSourceGapEntries(command, sources).map((gap) => gap.text);
    expect(reportGaps.some((text) => text.includes("finnhub-analyst-range"))).toBe(true);
    expect(reportGaps.some((text) => text.includes("analyst-consensus"))).toBe(true);
    expect(sources.sourceGaps).toBe(sourceGaps);
    expect(sources.sourceGaps).toHaveLength(2);
  });

  test("keeps an empty sourceGaps key under both views", () => {
    const sources = sourcesWithGaps([]);

    for (const view of ["all", "web-gather"] as const) {
      expect(payload(view, sources)).toHaveProperty("sourceGaps", []);
    }
  });

  test("drops both gaps from web-gather while the all view keeps them", () => {
    const sources = sourcesWithGaps([
      unsupportedAnalystRange,
      missingCredentialAnalystRange,
      analystConsensus,
    ]);
    const gather = payload("web-gather", sources);
    const all = payload("all", sources);
    const allTexts = sourceGapTexts(all);

    expect(gather).toHaveProperty("sourceGaps", []);
    expect(allTexts).toHaveLength(3);
    expect(allTexts.some((text) => text.includes("request failed with status 403"))).toBe(true);
    expect(allTexts.some((text) => text.includes("missing Finnhub credential"))).toBe(true);
    expect(allTexts.some((text) => text.includes("analyst-consensus"))).toBe(true);
  });

  test("does not assign dropped gaps to Source Plan lanes", () => {
    const sources = sourcesWithGaps(droppedGaps);
    const assessed = assessSourcePlan(buildSourcePlan(command, generatedAt), sources, generatedAt);
    const laneGapText = assessed.evidenceLanes.lanes.flatMap((lane) => lane.gapText);

    for (const gap of droppedGaps) {
      expect(laneGapText.some((text) => text.includes(gap.message))).toBe(false);
    }
  });
});
