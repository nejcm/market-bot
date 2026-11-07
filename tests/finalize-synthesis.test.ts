import { describe, expect, test } from "bun:test";
import type { EvidenceQualityAssessment } from "../src/domain/evidence";
import type { KeyFinding } from "../src/domain/report";
import type { Source } from "../src/domain/sources";
import { finalizeSynthesis } from "../src/research/finalize-synthesis";
import {
  createPeerMedianAudit,
  type PeerMedianAudit,
  type PeerMedianAuditClause,
} from "../src/research/peer-median-audit";
import type { PeerMedianMetric } from "../src/research/post-synthesis-audit";
import { ModelReplayError } from "../src/replay/llm-cassette";
import type {
  ValuationCompsArtifact,
  ValuationCompsRow,
} from "../src/sources/extended-evidence/valuation-comps-contract";
import type { CollectedSources } from "../src/sources/types";
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

let auditCalls: (readonly PeerMedianAuditClause[])[] = [];
// Labels nothing, so every clause takes the regex fallback.
const regexOnly: PeerMedianAudit = async (clauses) => {
  auditCalls.push(clauses);
  return { labels: new Map(), warnings: [] };
};
const labeled =
  (labels: Readonly<Record<string, PeerMedianMetric>>): PeerMedianAudit =>
  async (clauses) => {
    auditCalls.push(clauses);
    return { labels: new Map(Object.entries(labels)), warnings: [] };
  };

function finalize(
  bearCase: readonly KeyFinding[],
  comps?: ValuationCompsArtifact,
  audit: PeerMedianAudit = regexOnly,
  collected: Partial<CollectedSources> = {},
) {
  auditCalls = [];
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
    collectedSources({ ...collected, ...(comps === undefined ? {} : { valuationComps: comps }) }),
    ASSESSMENT,
    audit,
  );
}

const codes = (result: Awaited<ReturnType<typeof finalize>>) =>
  result.postSynthesisWarnings.map((warning) => `${warning.code}@${warning.location}`);
const CLAIM = "The peer screen places AMD's EV/revenue above the peer median.";

describe("finalizeSynthesis peer-median citation check", () => {
  test("flags and prunes a peer-median claim citing no usable peer (run a008bf63 bearCase[1])", async () => {
    const text =
      "The peer screen places AMD’s EV/revenue above the peer median, but the limited peer comparability and mixed quote and balance-sheet dates constrain the inference. A risk-off market snapshot and recent weakness add market-context risks without establishing future direction.";
    const kept = { text: "Qualitative bear point.", sourceIds: ["market-amd"] };
    const result = await finalize(
      [kept, { text, sourceIds: ["market-amd", "market-nvda"] }],
      COMPS,
    );
    expect(codes(result)).toContain("peer-median-uncited@bearCase[1]");
    expect(result.report.bearCase).toEqual([kept]);
    expect(result.integrityAudit.pruned.map((item) => item.location)).toEqual(["bearCase[1]"]);
    expect(result.report.reportIntegrity).toBe("medium");
  });

  test("does not flag or prune a claim citing a usable peer", async () => {
    const result = await finalize(
      [{ text: CLAIM, sourceIds: ["market-amd", "market-avgo"] }],
      COMPS,
    );
    expect(codes(result)).toEqual([]);
    expect(result.report.bearCase).toHaveLength(1);
  });

  test.each([
    "AMD's P/E sits above the peer median.",
    "AMD's EV/EBITDA trails the peer median.",
    "Gross margin is below the peer median.",
    "EV/gross profit sits above the peer median.",
    "EV/EBIT trails the peer median.",
  ])("leaves medians of metrics the comps rows do not carry alone: %s", async (text) => {
    const result = await finalize([{ text, sourceIds: ["market-amd"] }], COMPS);
    expect(codes(result)).not.toContain("peer-median-uncited@bearCase[0]");
    expect(result.report.bearCase).toHaveLength(1);
  });

  test("checks an EV/revenue median even when another metric is also named", async () => {
    const text = "EV/sales is above the peer median while margins compress.";
    expect(codes(await finalize([{ text, sourceIds: ["market-amd"] }], COMPS))).toEqual([
      "peer-median-uncited@bearCase[0]",
    ]);
  });

  test("flags the claim when comps were collected but no peer is usable", async () => {
    const comps = { ...COMPS, peers: [row("NVDA", false), row("AVGO", false)] };
    expect(
      codes(await finalize([{ text: CLAIM, sourceIds: ["market-amd", "market-avgo"] }], comps)),
    ).toEqual(["peer-median-uncited@bearCase[0]"]);
  });

  test.each([
    "No peer median is available for AMD.",
    "Peer median could not be computed because the peer set is incomplete.",
    "The peer-median multiple is withheld for AMD.",
  ])("does not flag a claim that the peer median is absent: %s", async (text) => {
    expect(codes(await finalize([{ text, sourceIds: ["market-amd"] }], COMPS))).not.toContain(
      "peer-median-uncited@bearCase[0]",
    );
  });

  test.each([
    "The peer-median multiple is high; revenue growth accelerated.",
    "AMD trades above peer medians.",
    "The peer median is unavailable for P/E; EV/revenue is above the peer median.",
    "Evidence is unavailable; EV/revenue is above the peer median.",
  ])("checks a median whose clause names no other metric: %s", async (text) => {
    expect(codes(await finalize([{ text, sourceIds: ["market-amd"] }], COMPS))).toContain(
      "peer-median-uncited@bearCase[0]",
    );
  });

  test("prunes an uncited peer-median summary sentence only when comps exist", async () => {
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
        regexOnly,
      ).then((result) => result.report.summary);
    expect(await run(COMPS)).toBe("AMD faces cyclical demand.");
    expect(await run()).toBe(summary);
  });

  test("flags and prunes nothing without comps", async () => {
    const result = await finalize([{ text: CLAIM, sourceIds: ["market-amd"] }]);
    expect(codes(result)).toEqual([]);
    expect(result.report.bearCase).toHaveLength(1);
  });

  test("keeps the unsupported-numeric warning and prune for an uncited figure", async () => {
    const result = await finalize(
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

  test("does not call the audit without comps or without a peer-median clause", async () => {
    await finalize([{ text: CLAIM, sourceIds: ["market-amd"] }]);
    expect(auditCalls).toEqual([]);
    await finalize([{ text: "No peer median is available.", sourceIds: ["market-amd"] }], COMPS);
    expect(auditCalls).toEqual([]);
  });

  test("sends each candidate clause once with its first location", async () => {
    await finalize(
      [
        { text: "P/E is above the peer median; revenue grew.", sourceIds: ["market-amd"] },
        { text: "P/E is above the peer median.", sourceIds: ["market-amd"] },
      ],
      COMPS,
    );
    expect(auditCalls).toEqual([
      [{ location: "bearCase[0]", text: "P/E is above the peer median" }],
    ]);
  });
});

describe("finalizeSynthesis peer-median audit labels", () => {
  test.each([
    "AMD trades above the peer median given its margins.",
    "Given strong margins, AMD trades above the peer median.",
    "AMD trades above the peer median for its growth prospects.",
  ])("prunes a regex escape the audit labels ev-revenue: %s", async (text) => {
    const clause = text.replace(/\.$/u, "");
    expect(
      (await finalize([{ text, sourceIds: ["market-amd"] }], COMPS)).report.bearCase,
    ).toHaveLength(1);
    const result = await finalize(
      [{ text, sourceIds: ["market-amd"] }],
      COMPS,
      labeled({ [clause]: "ev-revenue" }),
    );
    expect(codes(result)).toEqual(["peer-median-uncited@bearCase[0]"]);
    expect(result.report.bearCase).toEqual([]);
  });

  test.each([
    "AMD trades above the peer median gross margin.",
    "AMD trades above the peer median (P/E).",
    "The peer median is lower than AMD's P/E.",
    "The peer median operating margin trails AMD.",
  ])("keeps a cited other-metric claim the audit labels other: %s", async (text) => {
    const result = await finalize(
      [{ text, sourceIds: ["market-amd"] }],
      COMPS,
      labeled({ [text.replace(/\.$/u, "")]: "other" }),
    );
    expect(codes(result)).toEqual([]);
    expect(result.report.bearCase).toHaveLength(1);
  });

  test("prunes a mixed claim on its EV/revenue clause", async () => {
    const result = await finalize(
      [
        {
          text: "P/E is above the peer median; EV/revenue is above the peer median.",
          sourceIds: ["market-amd"],
        },
      ],
      COMPS,
      labeled({
        "P/E is above the peer median": "other",
        "EV/revenue is above the peer median": "ev-revenue",
      }),
    );
    expect(result.report.bearCase).toEqual([]);
  });

  test("falls back to the regex for a clause the audit leaves unlabeled", async () => {
    const text = "P/E is above the peer median; AMD trades above peer medians.";
    const result = await finalize(
      [{ text, sourceIds: ["market-amd"] }],
      COMPS,
      labeled({ "P/E is above the peer median": "other" }),
    );
    expect(codes(result)).toEqual(["peer-median-uncited@bearCase[0]"]);
  });

  test("labels key a summary paragraph the integrity audit splits", async () => {
    const summary =
      "AMD trades above the peer median given its margins\n\nDemand remains resilient.";
    const result = await finalizeSynthesis(
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
      collectedSources({ valuationComps: COMPS }),
      ASSESSMENT,
      labeled({ "AMD trades above the peer median given its margins": "ev-revenue" }),
    );
    expect(result.report.summary).toBe("Demand remains resilient.");
  });

  test("labels prune the summary sentence too", async () => {
    const summary =
      "AMD faces cyclical demand. AMD trades above the peer median given its margins.";
    const result = await finalizeSynthesis(
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
      collectedSources({ valuationComps: COMPS }),
      ASSESSMENT,
      labeled({ "AMD trades above the peer median given its margins": "ev-revenue" }),
    );
    expect(result.report.summary).toBe("AMD faces cyclical demand.");
  });
});

const modelAudit = (generate: (content: string) => Promise<string>) =>
  createPeerMedianAudit({
    provider: {
      name: "stub",
      generate: async (request) => ({
        content: await generate(request.messages[1]?.content ?? ""),
        tokenEstimate: 10,
      }),
    },
    model: "quick",
    command: { jobType: "equity", symbol: "AMD", assetClass: "equity", depth: "deep" } as never,
  });

describe("createPeerMedianAudit", () => {
  const TEXT = "AMD trades above the peer median given its margins.";

  test("publishes labels from a valid response and records its stage output", async () => {
    let prompt: unknown;
    const result = await finalize(
      [{ text: TEXT, sourceIds: ["market-amd"] }],
      COMPS,
      modelAudit(async (content) => {
        prompt = JSON.parse(content);
        return '{"version":1,"clauses":[{"id":1,"metric":"ev-revenue"}]}';
      }),
    );
    expect(prompt).toMatchObject({
      stage: "peer-median-audit",
      compsMetrics: ["EV/revenue"],
      clauses: [{ id: 1, location: "bearCase[0]", text: TEXT.replace(/\.$/u, "") }],
    });
    expect(result.report.bearCase).toEqual([]);
    expect(result.peerMedianAuditOutput?.stage).toBe("peer-median-audit");
  });

  test("rejects conflicting labels for one id and falls back to the regex", async () => {
    const result = await finalize(
      [{ text: "EV/revenue is above the peer median.", sourceIds: ["market-amd"] }],
      COMPS,
      modelAudit(
        async (): Promise<string> =>
          '{"version":1,"clauses":[{"id":1,"metric":"ev-revenue"},{"id":1,"metric":"other"}]}',
      ),
    );
    expect(result.report.bearCase).toEqual([]);
  });

  test("rethrows a replay miss so strict replay fails", async () => {
    const run = finalize(
      [{ text: "EV/revenue is above the peer median.", sourceIds: ["market-amd"] }],
      COMPS,
      modelAudit(async (): Promise<string> => {
        throw new ModelReplayError("peer-median-audit|quick", "LLM cassette miss");
      }),
    );
    expect(run).rejects.toThrow("LLM cassette miss");
  });

  test("ignores an unknown label and falls back to the regex for that clause", async () => {
    const result = await finalize(
      [{ text: TEXT, sourceIds: ["market-amd"] }],
      COMPS,
      modelAudit(
        async () => '{"version":1,"clauses":[{"id":1,"metric":"p-e"},{"id":9,"metric":"other"}]}',
      ),
    );
    expect(codes(result)).toEqual([]);
    expect(result.report.bearCase).toHaveLength(1);
  });

  test.each([
    ["malformed", async (): Promise<string> => '{"version":1,"clauses":'],
    [
      "provider error",
      async (): Promise<string> => {
        throw new Error("timeout");
      },
    ],
  ] as const)("falls back to the regex with a warning on %s", async (_name, generate) => {
    const result = await finalize(
      [{ text: "EV/revenue is above the peer median.", sourceIds: ["market-amd"] }],
      COMPS,
      modelAudit(generate),
    );
    expect(codes(result)).toEqual([
      "peer-median-uncited@bearCase[0]",
      "peer-median-audit-unavailable@report",
    ]);
    expect(result.report.bearCase).toEqual([]);
  });
});

describe("finalizeSynthesis run currencies", () => {
  const bearCase = [
    { text: "Cited bear point.", sourceIds: ["market-amd"] },
    { text: "The dividend was R500.", sourceIds: ["history-report-1"] },
  ];

  test("prunes and warns on an uncited amount in the resolved quote currency", async () => {
    const result = await finalize(bearCase, undefined, regexOnly, {
      resolvedInstrumentIdentity: { quoteCurrency: "ZAR" },
    });
    expect(codes(result)).toContain("unsupported-numeric-claim@bearCase[1]");
    expect(result.integrityAudit.pruned.map((item) => item.location)).toEqual(["bearCase[1]"]);
  });

  test("keeps the token as a name without currency context", async () => {
    const result = await finalize(bearCase);
    expect(codes(result)).not.toContain("unsupported-numeric-claim@bearCase[1]");
    expect(result.integrityAudit.pruned).toEqual([]);
  });
});
