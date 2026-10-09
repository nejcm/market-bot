import { describe, expect, test } from "bun:test";
import type { ResearchCommand } from "../src/cli/args";
import { sourceGap } from "../src/domain/source-gaps";
import type { Source } from "../src/domain/types";
import { buildEvidencePayload } from "../src/research/prompts/evidence-payload";
import { buildWebSubjectProfileStagePrompt } from "../src/research/prompts/web-subject-profile";
import type { CollectedSources } from "../src/sources/types";
import { profileCitableSources, subjectKindForCommand } from "../src/web-evidence";
import {
  collectedSources,
  marketSnapshot,
  newsSource,
  verifiedMarketSnapshot,
} from "./support/fixtures";
import { config, contextWithHistory } from "./support/research-context-helpers";

const fetchedAt = "2026-05-19T00:00:00.000Z";

function source(id: string, overrides: Partial<Source> = {}): Source {
  return {
    id,
    title: id,
    fetchedAt,
    kind: "extended-evidence",
    provider: "sec-edgar",
    assetClass: "equity",
    ...overrides,
  };
}

const webSource = source("web-allowed-1", { kind: "web", provider: "exa", snippet: "web text" });
const tenK = source("extended-sec-edgar-clfd-10k", { snippet: "[MD&A] Revenue was $1.0 million." });
const metadataOnlyTenQ = source("extended-sec-edgar-clfd-10q");
const eightK = source("extended-sec-edgar-clfd-8k-0001171843-26-005241", { snippet: "8-K text" });
const fundamentals = source("extended-fmp-fundamentals-clfd");

const disallowedIds = [
  metadataOnlyTenQ.id,
  eightK.id,
  fundamentals.id,
  "news-equity-1",
  "market-clfd",
  "verified-snapshot",
  "history-report",
  "profile-prior-web",
] as const;

const priorAnswer = { answer: "Prior answer", sourceIds: ["profile-prior-web"] };

function richSources(extendedSources: readonly Source[]): CollectedSources {
  return collectedSources({
    marketSnapshots: [marketSnapshot({ sourceId: "market-clfd", symbol: "CLFD" })],
    newsSources: [newsSource()],
    extendedSources,
    verifiedMarketSnapshot: verifiedMarketSnapshot({ symbol: "CLFD" }),
    marketContext: {
      assetClass: "equity",
      items: [],
      gaps: [],
    },
    extendedEvidence: {
      items: [
        {
          category: "sec-edgar",
          title: "8-K results",
          summary: "Quarter results",
          sourceIds: [eightK.id, fundamentals.id],
          observedAt: fetchedAt,
        },
      ],
      gaps: [],
    },
    webSubjectProfile: {
      version: 2,
      generatedAt: fetchedAt,
      subjectKind: "company",
      subjectId: "CLFD",
      symbol: "CLFD",
      subjectSummary: { answer: "Prior profile", sourceIds: ["profile-prior-web"] },
      questions: {
        whatItDoes: priorAnswer,
        howItMakesMoney: priorAnswer,
        customers: priorAnswer,
        geography: priorAnswer,
        purchaseRecurrence: priorAnswer,
        pricingPower: priorAnswer,
        recessionCyclicality: priorAnswer,
      },
      recentMaterialEvents: [],
      factLedger: [{ claim: "Prior fact", sourceIds: ["profile-prior-web"] }],
      openGaps: [],
      sourceIds: ["profile-prior-web"],
    },
    sourceGaps: [sourceGap({ source: "sec-edgar", message: "Missing SEC Risk Factors section" })],
  });
}

const commands: readonly ResearchCommand[] = [
  { jobType: "equity", assetClass: "equity", symbol: "CLFD", depth: "deep" },
  { jobType: "crypto", assetClass: "crypto", symbol: "BTC-USD", depth: "brief" },
  { jobType: "research", assetClass: "equity", subject: "chip stocks", depth: "brief" },
];

function citedIds(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => citedIds(entry));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, entry]) => {
    if (/^(?:id|sourceId)$|SourceIds?$|^sourceIds$/u.test(key)) {
      return Array.isArray(entry) ? entry.map(String) : [String(entry)];
    }
    return citedIds(entry);
  });
}

function profileEvidence(command: ResearchCommand, sources: CollectedSources) {
  const prompt = buildWebSubjectProfileStagePrompt({
    command,
    collectedSources: sources,
    config,
    context: contextWithHistory(command),
    loaded: { system: "Research only.", instruction: "Extract.", goal: "Profile." },
  });
  return {
    prompt,
    evidence: (JSON.parse(prompt) as { evidence: Record<string, unknown> }).evidence,
  };
}

describe("Web Subject Profile evidence payload", () => {
  for (const command of commands) {
    test(`${command.jobType} prompt cites only validator-admitted sources`, () => {
      const sources = richSources([webSource, tenK, metadataOnlyTenQ, eightK, fundamentals]);
      const { prompt, evidence } = profileEvidence(command, sources);
      const subjectKind = subjectKindForCommand(command) ?? "company";
      const allowed = new Set(
        profileCitableSources(sources.extendedSources, subjectKind).map(({ id }) => id),
      );

      expect(citedIds(evidence).filter((id) => !allowed.has(id))).toEqual([]);
      for (const id of disallowedIds) {
        expect(prompt).not.toContain(id);
      }
      expect(evidence.sourceGaps).toContain("sec-edgar: Missing SEC Risk Factors section");
      expect(Object.keys(evidence).toSorted()).toEqual([
        "analysisAsOf",
        "command",
        "deterministicCitationGuidance",
        "sourceGaps",
        "webSources",
      ]);
    });
  }

  test("company SEC-only path exposes the filing text and nothing else citable", () => {
    const { evidence } = profileEvidence(commands[0]!, richSources([tenK, eightK]));
    expect(evidence.webSources).toEqual([
      { id: tenK.id, title: tenK.id, fetchedAt, snippet: tenK.snippet },
    ]);
  });

  test("web-only and theme paths drop SEC filings", () => {
    const { evidence } = profileEvidence(commands[2]!, richSources([webSource, tenK]));
    expect(citedIds(evidence)).toEqual([webSource.id]);
  });

  test("empty evidence keeps an empty webSources list and the Source Gaps", () => {
    const { evidence } = profileEvidence(commands[0]!, richSources([eightK]));
    expect(evidence.webSources).toEqual([]);
    expect(evidence.sourceGaps).not.toEqual([]);
  });

  test("does not mutate collected sources", () => {
    const sources = richSources([webSource, tenK, eightK]);
    const before = structuredClone(sources);
    profileEvidence(commands[0]!, sources);
    expect(sources).toEqual(before);
  });

  test("non-profile payloads keep the full evidence surface", () => {
    const sources = richSources([webSource, tenK, eightK]);
    const payload = buildEvidencePayload(
      { includePriorCalibration: false, sourceGapView: "all", webSourceText: "metadata" },
      commands[0]!,
      sources,
      config,
      contextWithHistory(commands[0]!),
    );
    expect(payload.extendedEvidence).toBe(sources.extendedEvidence);
    expect(payload.verifiedMarketSnapshotSourceId).toBeDefined();
    expect(citedIds(payload.webSources)).toEqual([webSource.id]);
  });
});
