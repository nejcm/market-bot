import { describe, expect, test } from "bun:test";
import {
  buildWebSubjectProfileEvidence,
  normalizedSubjectId,
} from "../src/sources/extended-evidence/web-subject-profile";
import type { Source } from "../src/domain/types";

const command = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
} as const;

const subject = {
  subjectKind: "company",
  subjectId: "AAPL",
  subjectLabel: "Apple Inc.",
  assetClass: "equity",
  symbol: "AAPL",
} as const;

const webSource: Source = {
  id: "web-aapl-12345678",
  title: "Apple company profile",
  fetchedAt: "2026-05-19T00:00:00.000Z",
  kind: "web",
  assetClass: "equity",
  symbol: "AAPL",
  provider: "exa",
};

function profilePayload(sourceId = webSource.id): string {
  const answer = { answer: "Apple sells devices and services.", sourceIds: [sourceId] };
  return JSON.stringify({
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
    },
    recentMaterialEvents: [{ claim: "Apple expanded services disclosure.", sourceIds: [sourceId] }],
    factLedger: [{ claim: "Apple sells iPhone, Mac, and services.", sourceIds: [sourceId] }],
    openGaps: ["Customer concentration remains unclear from gathered web sources."],
  });
}

describe("buildWebSubjectProfileEvidence", () => {
  test("normalizes subject IDs deterministically for theme reuse keys", () => {
    expect(normalizedSubjectId("AI infrastructure")).toBe(normalizedSubjectId("AI infrastructure"));
    expect(normalizedSubjectId("AI infrastructure")).toBe(
      normalizedSubjectId(" ai   infrastructure "),
    );
    expect(normalizedSubjectId("AI infrastructure")).toBe(normalizedSubjectId("AI Infrastructure"));
    expect(normalizedSubjectId("AI infrastructure")).not.toBe(
      normalizedSubjectId("biotech infrastructure"),
    );
  });

  test("accepts cited web facts and emits an extended evidence item", () => {
    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      modelContent: profilePayload(),
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.sourceGaps).toEqual([]);
    expect(result.artifact).toMatchObject({ subjectKind: "company", companyName: "Apple Inc." });
    expect(result.artifact?.sourceIds).toEqual([webSource.id]);
    expect(result.extendedEvidence?.items).toEqual([
      expect.objectContaining({
        category: "web-subject-profile",
        sourceIds: [webSource.id],
      }),
    ]);
  });

  test("rejects uncited facts and returns an empty profile with a gap", () => {
    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      modelContent: profilePayload("missing-source"),
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.artifact?.sourceIds).toEqual([]);
    expect(result.artifact?.factLedger).toEqual([]);
    expect(result.sourceGaps).toEqual([
      expect.objectContaining({
        source: "web-subject-profile",
        cause: "validation-failed",
      }),
    ]);
    expect(result.extendedEvidence?.gaps).toEqual(result.sourceGaps);
  });

  test("malformed JSON becomes a validation gap", () => {
    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      modelContent: "not-json",
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.artifact?.openGaps[0]).toContain("not valid JSON");
    expect(result.sourceGaps[0]).toMatchObject({ cause: "validation-failed" });
  });

  test("accepts crypto-asset questions with cited subject summary", () => {
    const cryptoSubject = {
      subjectKind: "crypto-asset",
      subjectId: "BTC",
      subjectLabel: "Bitcoin",
      assetClass: "crypto",
      symbol: "BTC",
    } as const;
    const source = {
      ...webSource,
      id: "web-btc-12345678",
      assetClass: "crypto",
      symbol: "BTC",
    } as const;
    const answer = {
      answer: "Bitcoin is a proof-of-work settlement network.",
      sourceIds: [source.id],
    };
    const result = buildWebSubjectProfileEvidence({
      command: { jobType: "crypto", assetClass: "crypto", symbol: "BTC", depth: "deep" },
      subject: cryptoSubject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      modelContent: JSON.stringify({
        subjectLabel: "Bitcoin",
        subjectSummary: answer,
        questions: {
          whatItDoes: answer,
          valueAccrual: answer,
          supplyIssuance: answer,
          usageAdoption: answer,
          governanceBuilders: answer,
          competitionMoat: answer,
          keyRisks: answer,
        },
        recentMaterialEvents: [],
        factLedger: [{ claim: "Bitcoin uses proof-of-work consensus.", sourceIds: [source.id] }],
        openGaps: [],
      }),
      webSources: [source],
      extendedEvidence: undefined,
    });

    expect(result.sourceGaps).toEqual([]);
    expect(result.artifact).toMatchObject({ subjectKind: "crypto-asset", subjectId: "BTC" });
  });

  test("rejects uncited subject summary", () => {
    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      modelContent: JSON.stringify({
        ...JSON.parse(profilePayload()),
        subjectSummary: { answer: "Uncited summary.", sourceIds: [] },
      }),
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.sourceGaps[0]).toMatchObject({ cause: "validation-failed" });
    expect(result.artifact?.sourceIds).toEqual([]);
  });
});
