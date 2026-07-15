import { describe, expect, test } from "bun:test";
import type { ResearchCommand } from "../src/cli/args";
import { sourceGap } from "../src/domain/source-gaps";
import {
  deterministicSourceGapEntries,
  deterministicSourceGaps,
} from "../src/research/deterministic-gaps";
import { resolveResearchSubject } from "../src/research/research-subject-identity";
import {
  collectedSources,
  marketSnapshot,
  newsSource,
  verifiedMarketSnapshot as verifiedSnapshotFixture,
} from "./support/fixtures";

describe("phase 2.2 — deterministicSourceGaps for missing representative snapshots", () => {
  test("keeps prompt-side source gap order while exposing structured impact entries", () => {
    const command: ResearchCommand = {
      jobType: "crypto",
      assetClass: "crypto",
      symbol: "BTC",
      depth: "brief",
    };
    const sources = collectedSources({
      marketSnapshots: [marketSnapshot({ assetClass: "crypto", symbol: "BTC" })],
      newsSources: [newsSource({ assetClass: "crypto" })],
      sourceGaps: [
        sourceGap({
          source: "optional-social",
          message: "optional social feed unavailable",
          evidenceQualityImpact: "no-cap",
        }),
        sourceGap({
          source: "coingecko",
          message: "core market data stale",
          evidenceQualityImpact: "core-cap",
        }),
      ],
    });

    expect(deterministicSourceGaps(command, sources)).toEqual([
      "optional-social: optional social feed unavailable",
      "coingecko: core market data stale",
    ]);
    expect(deterministicSourceGapEntries(command, sources)).toEqual([
      {
        text: "optional-social: optional social feed unavailable",
        impact: "no-cap",
      },
      {
        text: "coingecko: core market data stale",
        impact: "core-cap",
      },
    ]);
  });

  test("adds gap for each registry representative without a live snapshot", () => {
    const command: ResearchCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "chip stocks",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
      depth: "brief",
    };
    const resolvedSubject = resolveResearchSubject(command)!;
    // Only SMH has a snapshot; NVDA, AMD, AVGO are absent
    const gaps = deterministicSourceGaps(
      command,
      collectedSources({
        resolvedSubject,
        marketSnapshots: [marketSnapshot({ sourceId: "market-smh", symbol: "SMH" })],
        newsSources: [newsSource()],
      }),
    );

    const repGaps = gaps.filter((g) => g.startsWith("researchRepresentative:"));
    expect(repGaps.length).toBe(3);
    expect(repGaps.some((g) => g.includes("NVDA"))).toBe(true);
    expect(repGaps.some((g) => g.includes("AMD"))).toBe(true);
    expect(repGaps.some((g) => g.includes("AVGO"))).toBe(true);
  });

  test("does not add representative gap when verified snapshot is present", () => {
    const command: ResearchCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "chip stocks",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
      depth: "deep",
    };
    const resolvedSubject = resolveResearchSubject(command)!;
    const gaps = deterministicSourceGaps(
      command,
      collectedSources({
        resolvedSubject,
        marketSnapshots: [
          marketSnapshot({ sourceId: "market-smh", symbol: "SMH" }),
          marketSnapshot({ sourceId: "market-nvda", symbol: "NVDA" }),
        ],
        verifiedRepresentativeSnapshots: [
          verifiedSnapshotFixture({ symbol: "AMD" }),
          verifiedSnapshotFixture({ symbol: "AVGO" }),
        ],
        newsSources: [newsSource()],
      }),
    );

    expect(gaps.filter((g) => g.startsWith("researchRepresentative:"))).toHaveLength(0);
  });

  test("emits no representative gaps when all representatives have live snapshots", () => {
    const command: ResearchCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "chip stocks",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
      depth: "brief",
    };
    const gaps = deterministicSourceGaps(
      command,
      collectedSources({
        marketSnapshots: [
          marketSnapshot({ sourceId: "market-smh", symbol: "SMH" }),
          marketSnapshot({ sourceId: "market-nvda", symbol: "NVDA" }),
          marketSnapshot({ sourceId: "market-amd", symbol: "AMD" }),
          marketSnapshot({ sourceId: "market-avgo", symbol: "AVGO" }),
        ],
        newsSources: [newsSource()],
      }),
    );

    expect(gaps.filter((g) => g.startsWith("researchRepresentative:"))).toHaveLength(0);
  });

  test("emits no representative gaps for unresolved research subject", () => {
    const command: ResearchCommand = {
      jobType: "research",
      assetClass: "equity",
      subject: "unknown niche",
      depth: "brief",
    };
    const gaps = deterministicSourceGaps(
      command,
      collectedSources({ newsSources: [newsSource()] }),
    );

    expect(gaps.filter((g) => g.startsWith("researchRepresentative:"))).toHaveLength(0);
  });
});
