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
  test("flags a peer-median claim citing no usable peer (run a008bf63 bearCase[1])", () => {
    const result = finalize([{ text: CLAIM, sourceIds: ["market-amd", "market-nvda"] }], COMPS);
    expect(codes(result)).toEqual(["peer-median-uncited@bearCase[0]"]);
    expect(result.report.bearCase[0]!.sourceIds).toEqual(["market-amd", "market-nvda"]);
  });

  test("does not flag a claim citing a usable peer", () => {
    expect(
      codes(finalize([{ text: CLAIM, sourceIds: ["market-amd", "market-avgo"] }], COMPS)),
    ).toEqual([]);
  });

  test("flags the claim when comps were collected but no peer is usable", () => {
    const comps = { ...COMPS, peers: [row("NVDA", false), row("AVGO", false)] };
    expect(
      codes(finalize([{ text: CLAIM, sourceIds: ["market-amd", "market-avgo"] }], comps)),
    ).toEqual(["peer-median-uncited@bearCase[0]"]);
  });

  test("flags nothing without comps", () => {
    expect(codes(finalize([{ text: CLAIM, sourceIds: ["market-amd"] }]))).toEqual([]);
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
    expect(codes(result)).toContain("unsupported-numeric-claim@bearCase[0]");
    expect(result.report.bearCase).toEqual([]);
  });
});
