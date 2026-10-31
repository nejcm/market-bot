import { describe, expect, test } from "bun:test";
import type { EvidenceQualityAssessment } from "../src/domain/evidence";
import type { KeyFinding } from "../src/domain/report";
import type { Source } from "../src/domain/sources";
import { finalizeSynthesis } from "../src/research/finalize-synthesis";
import type {
  ValuationCompsArtifact,
  ValuationCompsRow,
} from "../src/sources/extended-evidence/valuation-comps-contract";
import { collectedSources, researchReport } from "./support/fixtures";

const IDS = ["market-amd", "market-nvda", "market-avgo", "history-report-1"];
const ASSESSMENT: EvidenceQualityAssessment = {
  version: 1,
  rubricVersion: 3,
  label: "high",
  checks: [],
  limitingReasons: [],
  advisoryReasons: [],
};

function source(id: string): Source {
  return { id, title: id, fetchedAt: "2026-10-24T00:00:00.000Z", kind: "market-data" };
}

function row(symbol: string, usable: boolean): ValuationCompsRow {
  return { symbol, sourceIds: [`market-${symbol.toLowerCase()}`], usable };
}

const COMPS: ValuationCompsArtifact = {
  version: 1,
  generatedAt: "2026-10-24T00:00:00.000Z",
  target: row("AMD", true),
  peers: [row("NVDA", false), row("AVGO", true)],
  excludedPeers: [],
  peerUniverseSourceIds: [],
  summary: {
    corePeerCount: 2,
    secondaryPeerCount: 0,
    usablePeerCount: 1,
    peerMedianEvToAnnualizedRevenue: 9.2,
    valuationSupportability: "supported",
  },
  sourceIds: [],
  freshnessFlags: {
    targetQuoteFresh: true,
    targetSecFresh: true,
    peerQuoteFresh: true,
    peerSecFresh: true,
  },
};

function finalize(bearCase: readonly KeyFinding[], comps?: ValuationCompsArtifact) {
  return finalizeSynthesis(
    {
      report: researchReport({
        jobType: "equity",
        symbol: "AMD",
        bearCase,
        sources: IDS.map(source),
      }),
      sourceGaps: [],
      stageOutputs: [],
      predictionRetryErrors: [],
      predictionTrimWarnings: [],
      predictionErrors: [],
      reportValidationErrors: [],
      relocatedGapClaims: [],
    },
    collectedSources(comps === undefined ? {} : { valuationComps: comps }),
    ASSESSMENT,
  );
}

const codes = (result: ReturnType<typeof finalize>) =>
  result.postSynthesisWarnings.map((warning) => `${warning.code}@${warning.location}`);
const CLAIM = "The peer screen places AMD's EV/revenue above the peer median.";

describe("finalizeSynthesis peer-median citation check", () => {
  test("flags and prunes a peer-median claim citing no usable peer (run a008bf63 bearCase[1])", () => {
    const text =
      "The peer screen places AMD’s EV/revenue above the peer median, but the limited peer comparability and mixed quote and balance-sheet dates constrain the inference. A risk-off market snapshot and recent weakness add market-context risks without establishing future direction.";
    const kept = { text: "Qualitative bear point.", sourceIds: ["market-amd"] };
    const result = finalize([kept, { text, sourceIds: ["market-amd", "market-nvda"] }], COMPS);
    expect(codes(result)).toContain("peer-median-uncited@bearCase[1]");
    expect(result.report.bearCase).toEqual([kept]);
    expect(result.integrityAudit.pruned.map((item) => item.location)).toEqual(["bearCase[1]"]);
    expect(result.report.reportIntegrity).toBe("medium");
  });

  test("does not flag or prune a claim citing a usable peer", () => {
    const result = finalize([{ text: CLAIM, sourceIds: ["market-amd", "market-avgo"] }], COMPS);
    expect(codes(result)).toEqual([]);
    expect(result.report.bearCase).toHaveLength(1);
  });

  test.each([
    "AMD's P/E sits above the peer median.",
    "AMD's EV/EBITDA trails the peer median.",
    "Gross margin is below the peer median.",
    "EV/gross profit sits above the peer median.",
    "EV/EBIT trails the peer median.",
  ])("leaves medians of metrics the comps rows do not carry alone: %s", (text) => {
    const result = finalize([{ text, sourceIds: ["market-amd"] }], COMPS);
    expect(codes(result)).not.toContain("peer-median-uncited@bearCase[0]");
    expect(result.report.bearCase).toHaveLength(1);
  });

  test("checks an EV/revenue median even when another metric is also named", () => {
    const text = "EV/sales is above the peer median while margins compress.";
    expect(codes(finalize([{ text, sourceIds: ["market-amd"] }], COMPS))).toEqual([
      "peer-median-uncited@bearCase[0]",
    ]);
  });

  test("flags the claim when comps were collected but no peer is usable", () => {
    const comps = { ...COMPS, peers: [row("NVDA", false), row("AVGO", false)] };
    expect(
      codes(finalize([{ text: CLAIM, sourceIds: ["market-amd", "market-avgo"] }], comps)),
    ).toEqual(["peer-median-uncited@bearCase[0]"]);
  });

  test.each([
    "No peer median is available for AMD.",
    "Peer median could not be computed because the peer set is incomplete.",
    "The peer-median multiple is withheld for AMD.",
  ])("does not flag a claim that the peer median is absent: %s", (text) => {
    expect(codes(finalize([{ text, sourceIds: ["market-amd"] }], COMPS))).not.toContain(
      "peer-median-uncited@bearCase[0]",
    );
  });

  test.each([
    "The peer-median multiple is high; revenue growth accelerated.",
    "AMD trades above peer medians.",
    "The peer median is unavailable for P/E; EV/revenue is above the peer median.",
    "Evidence is unavailable; EV/revenue is above the peer median.",
  ])("checks a median whose clause names no other metric: %s", (text) => {
    expect(codes(finalize([{ text, sourceIds: ["market-amd"] }], COMPS))).toContain(
      "peer-median-uncited@bearCase[0]",
    );
  });

  test("prunes an uncited peer-median summary sentence only when comps exist", () => {
    const summary = "AMD faces cyclical demand. EV/revenue sits above the peer median.";
    const run = (comps?: ValuationCompsArtifact) =>
      finalizeSynthesis(
        {
          report: researchReport({
            jobType: "equity",
            symbol: "AMD",
            summary,
            sources: IDS.map(source),
          }),
          sourceGaps: [],
          stageOutputs: [],
          predictionRetryErrors: [],
          predictionTrimWarnings: [],
          predictionErrors: [],
          reportValidationErrors: [],
          relocatedGapClaims: [],
        },
        collectedSources(comps === undefined ? {} : { valuationComps: comps }),
        ASSESSMENT,
      ).report.summary;
    expect(run(COMPS)).toBe("AMD faces cyclical demand.");
    expect(run()).toBe(summary);
  });

  test("flags and prunes nothing without comps", () => {
    const result = finalize([{ text: CLAIM, sourceIds: ["market-amd"] }]);
    expect(codes(result)).toEqual([]);
    expect(result.report.bearCase).toHaveLength(1);
  });

  test("keeps the unsupported-numeric warning and prune for an uncited figure", () => {
    const result = finalize(
      [
        {
          text: "No peer median is available. AMD revenue grew 999%.",
          sourceIds: ["history-report-1"],
        },
      ],
      COMPS,
    );
    expect(codes(result)).toEqual([
      "unsupported-numeric-claim@bearCase[0]",
      "weak-evidence-posture-missing@bearCase[0]",
    ]);
    expect(result.report.bearCase).toEqual([]);
  });
});
