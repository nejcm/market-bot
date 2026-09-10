import { describe, expect, spyOn, test } from "bun:test";
import {
  buildWebSubjectProfileEvidence,
  buildWebSubjectProfileFailureEvidence,
  buildWebSubjectProfileReuseEvidence,
  isCompanyProfileSecSource,
  normalizedSubjectId,
} from "../src/web-evidence/web-subject-profile";
import {
  isWebSubjectProfileWithheldAnswer,
  WEB_SUBJECT_PROFILE_WITHHELD_ANSWER_NOTICE,
  WEB_SUBJECT_PROFILE_WITHHELD_MARKER,
  WEB_SUBJECT_PROFILE_WITHHELD_SUBJECT_SUMMARY_NOTICE,
} from "../src/web-evidence/contract";
import {
  assertSafeReportLanguage,
  ReportLanguageViolationError,
  validateResearchReport,
} from "../src/report/schema";
import { renderWebSubjectProfile } from "../src/report/markdown-profile-sections";
import { sourceGap } from "../src/domain/source-gaps";
import { researchReport } from "./support/fixtures";
import type { Source } from "../src/domain/types";
import { violatesResearchOnly } from "../src/domain/research-language";

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

function reuseFreshnessGap() {
  return sourceGap({
    source: "web-subject-profile",
    message: "Reused Web Subject Profile is 3 days old.",
    provider: "market-bot",
    capability: "extended-evidence",
    cause: "reused-in-window",
  });
}

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
      managementTrackRecord: answer,
      capitalAllocation: answer,
      companyKpis: answer,
      riskFactors: answer,
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
      runId: "test-run",
      modelContent: profilePayload(),
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.sourceGaps).toEqual([]);
    expect(result.artifact).toMatchObject({
      version: 3,
      subjectKind: "company",
      companyName: "Apple Inc.",
      originRunDirName: "test-run",
    });
    expect(result.artifact?.sourceIds).toEqual([webSource.id]);
    expect(result.extendedEvidence?.items).toEqual([
      expect.objectContaining({
        category: "web-subject-profile",
        sourceIds: [webSource.id],
      }),
    ]);
  });

  test("accepts answers that cite SEC filing sources alongside web sources", () => {
    const secTenK: Source = {
      id: "extended-sec-edgar-aapl-10k",
      title: "AAPL SEC 10-K",
      fetchedAt: "2026-05-19T00:00:00.000Z",
      kind: "extended-evidence",
      assetClass: "equity",
      symbol: "AAPL",
      provider: "sec-edgar",
    };
    const secTenQ: Source = {
      ...secTenK,
      id: "extended-sec-edgar-aapl-10q",
      title: "AAPL SEC 10-Q",
    };
    const secAnswer = {
      answer: "Hardware drove the majority of revenue per the 10-K MDA.",
      sourceIds: [secTenK.id, secTenQ.id],
    };
    const webAnswer = { answer: "Apple sells devices and services.", sourceIds: [webSource.id] };
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: webAnswer,
      questions: {
        whatItDoes: webAnswer,
        howItMakesMoney: secAnswer,
        customers: webAnswer,
        geography: secAnswer,
        purchaseRecurrence: webAnswer,
        pricingPower: secAnswer,
        recessionCyclicality: secAnswer,
        managementTrackRecord: webAnswer,
        capitalAllocation: webAnswer,
        companyKpis: webAnswer,
        riskFactors: secAnswer,
      },
      recentMaterialEvents: [],
      factLedger: [{ claim: "Hardware is the largest segment.", sourceIds: [secTenK.id] }],
      openGaps: [],
    });

    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource, secTenK, secTenQ],
      extendedEvidence: undefined,
    });

    expect(result.sourceGaps).toEqual([]);
    expect(result.artifact?.sourceIds).toEqual([webSource.id, secTenK.id, secTenQ.id].toSorted());
  });

  test("rejects uncited facts and returns an empty profile with a gap", () => {
    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent: profilePayload("missing-source"),
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.artifact?.sourceIds).toEqual([]);
    expect(result.artifact?.originRunDirName).toBe("test-run");
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
      runId: "test-run",
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
      runId: "test-run",
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

  test("salvages a mostly-valid profile: one disallowed event survives as one gap, rest of the profile is retained (B3.1)", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: [webSource.id] };
    const questions = Object.fromEntries(
      [
        "whatItDoes",
        "howItMakesMoney",
        "customers",
        "geography",
        "purchaseRecurrence",
        "pricingPower",
        "recessionCyclicality",
        "managementTrackRecord",
        "capitalAllocation",
        "companyKpis",
        "riskFactors",
      ].map((key) => [key, answer]),
    );
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: answer,
      questions,
      recentMaterialEvents: [
        { claim: "Apple announced a services event.", sourceIds: ["disallowed-source"] },
      ],
      factLedger: [
        { claim: "Apple sells iPhone, Mac, and services.", sourceIds: [webSource.id] },
        { claim: "Apple grew services revenue.", sourceIds: [webSource.id] },
        { claim: "Apple expanded retail footprint.", sourceIds: [webSource.id] },
        { claim: "Apple invests in silicon design.", sourceIds: [webSource.id] },
        { claim: "Apple returns capital via buybacks.", sourceIds: [webSource.id] },
        { claim: "Apple discloses segment revenue.", sourceIds: [webSource.id] },
        { claim: "Apple reports quarterly earnings.", sourceIds: [webSource.id] },
      ],
      openGaps: [],
    });

    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    // All 11 questions and 7 ledger facts survive; only the disallowed event is rejected.
    expect(
      Object.values(result.artifact?.questions ?? {}).filter((q) => q.sourceIds.length > 0),
    ).toHaveLength(11);
    expect(result.artifact?.factLedger).toHaveLength(7);
    expect(result.artifact?.recentMaterialEvents).toEqual([]);
    expect(result.artifact?.sourceIds).toEqual([webSource.id]);

    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]).toMatchObject({
      source: "web-subject-profile",
      cause: "validation-failed",
      evidenceQualityImpact: "no-cap",
    });
    expect(result.sourceGaps[0]?.message).toContain("recentMaterialEvents[0]");
    expect(result.sourceGaps[0]?.message).not.toContain("disallowed-source");
    expect(result.sourceGaps[0]?.message).toContain("1 of 20 items rejected");
  });

  test("every fact invalid still yields the empty artifact, unchanged (B3.2)", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: [webSource.id] };
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: answer,
      questions: Object.fromEntries(
        [
          "whatItDoes",
          "howItMakesMoney",
          "customers",
          "geography",
          "purchaseRecurrence",
          "pricingPower",
          "recessionCyclicality",
          "managementTrackRecord",
          "capitalAllocation",
          "companyKpis",
          "riskFactors",
        ].map((key) => [key, answer]),
      ),
      recentMaterialEvents: [],
      factLedger: [
        { claim: "Uncited claim one.", sourceIds: ["missing-source-1"] },
        { claim: "Uncited claim two.", sourceIds: ["missing-source-2"] },
      ],
      openGaps: [],
    });

    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.artifact?.factLedger).toEqual([]);
    expect(result.artifact?.questions).toEqual(
      expect.objectContaining({
        whatItDoes: { answer: "", sourceIds: [] },
      }),
    );
    expect(result.artifact?.sourceIds).toEqual([]);
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]).toMatchObject({
      source: "web-subject-profile",
      cause: "validation-failed",
      evidenceQualityImpact: "extended-evidence-cap",
      message: expect.stringContaining(
        "Web Subject Profile invalid for AAPL: factLedger must contain at least one cited fact",
      ),
    });
  });

  test("allowlist guard: a disallowed source id never reaches profileSourceIds under partial acceptance (B3.3)", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: [webSource.id] };
    const mixedIdsAnswer = {
      answer: "Mixed citation answer.",
      sourceIds: [webSource.id, "disallowed-in-answer"],
    };
    const questions = Object.fromEntries(
      [
        "whatItDoes",
        "howItMakesMoney",
        "customers",
        "geography",
        "purchaseRecurrence",
        "pricingPower",
        "recessionCyclicality",
        "managementTrackRecord",
        "capitalAllocation",
        "companyKpis",
      ].map((key) => [key, answer]),
    );
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: answer,
      questions: { ...questions, riskFactors: mixedIdsAnswer },
      recentMaterialEvents: [
        { claim: "Event with mixed source ids.", sourceIds: [webSource.id, "disallowed-event-id"] },
        { claim: "Valid event.", sourceIds: [webSource.id] },
      ],
      factLedger: [
        { claim: "Ledger fact with disallowed id only.", sourceIds: ["disallowed-fact-id"] },
        { claim: "Valid ledger fact one.", sourceIds: [webSource.id] },
      ],
      openGaps: [],
    });

    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    const allSourceIds = [
      ...(result.artifact?.sourceIds ?? []),
      ...(result.extendedEvidence?.items[0]?.sourceIds ?? []),
    ];
    expect(allSourceIds).not.toContain("disallowed-in-answer");
    expect(allSourceIds).not.toContain("disallowed-event-id");
    expect(allSourceIds).not.toContain("disallowed-fact-id");
    // The mixed-id answer and mixed-id event are rejected in full (no partial
    // Admission of a mixed valid/invalid sourceIds list within one item).
    const resultQuestions =
      result.artifact?.subjectKind === "company" ? result.artifact.questions : undefined;
    expect(resultQuestions?.riskFactors).toEqual({ answer: "", sourceIds: [] });
    expect(result.artifact?.recentMaterialEvents).toEqual([
      { claim: "Valid event.", sourceIds: [webSource.id] },
    ]);
    expect(result.artifact?.factLedger).toEqual([
      { claim: "Valid ledger fact one.", sourceIds: [webSource.id] },
    ]);
    expect(result.artifact?.sourceIds).toEqual([webSource.id]);
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]?.message).toContain(
      "questions.riskFactors: answer cited 1 unknown sourceId",
    );
    expect(result.sourceGaps[0]?.message).not.toContain("disallowed-in-answer");
    expect(result.sourceGaps[0]?.message).not.toContain("disallowed-event-id");
    expect(result.sourceGaps[0]?.message).not.toContain("disallowed-fact-id");
  });

  const ALL_COMPANY_QUESTION_KEYS = [
    "whatItDoes",
    "howItMakesMoney",
    "customers",
    "geography",
    "purchaseRecurrence",
    "pricingPower",
    "recessionCyclicality",
    "managementTrackRecord",
    "capitalAllocation",
    "companyKpis",
    "riskFactors",
  ] as const;

  test("a rejection caused by a missing claim never names an allowlisted source id as offending (finding 1)", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: [webSource.id] };
    const questions = Object.fromEntries(ALL_COMPANY_QUESTION_KEYS.map((key) => [key, answer]));
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: answer,
      questions,
      recentMaterialEvents: [],
      factLedger: [
        { claim: "Apple sells iPhone, Mac, and services.", sourceIds: [webSource.id] },
        { claim: "Apple grew services revenue.", sourceIds: [webSource.id] },
        // Missing claim, but the sourceIds it does carry are fully allowlisted.
        { sourceIds: [webSource.id] },
      ],
      openGaps: [],
    });

    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.artifact?.factLedger).toHaveLength(2);
    expect(result.sourceGaps).toHaveLength(1);
    // The rejected item's only sourceId is allowlisted, so nothing is
    // "offending" — the message must not claim otherwise.
    expect(result.sourceGaps[0]?.message).not.toContain("offending sourceIds");
    expect(result.sourceGaps[0]?.message).not.toContain(webSource.id);
    expect(result.sourceGaps[0]?.message).toContain("factLedger[2]");
    expect(result.sourceGaps[0]?.evidenceQualityImpact).toBe("no-cap");
  });

  test("escalates to extended-evidence-cap when fewer than half the questions survive (finding 2)", () => {
    const goodAnswer = { answer: "Apple sells devices and services.", sourceIds: [webSource.id] };
    const badAnswer = { answer: "Uncited answer.", sourceIds: [] };
    // Only 3 of 11 questions answered — well under the 50% floor.
    const questions = Object.fromEntries(
      ALL_COMPANY_QUESTION_KEYS.map((key, index) => [key, index < 3 ? goodAnswer : badAnswer]),
    );
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: goodAnswer,
      questions,
      recentMaterialEvents: [],
      factLedger: [
        { claim: "Apple sells iPhone, Mac, and services.", sourceIds: [webSource.id] },
        { claim: "Apple grew services revenue.", sourceIds: [webSource.id] },
      ],
      openGaps: [],
    });

    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    // The profile is still retained (facts and answered questions survive)...
    expect(result.artifact?.factLedger).toHaveLength(2);
    expect(result.artifact?.sourceIds).toEqual([webSource.id]);
    // ...but disclosure escalates because too little of the profile is usable.
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]?.message).toContain(
      "questions.geography: answer cited no sourceIds",
    );
    expect(result.sourceGaps[0]?.evidenceQualityImpact).toBe("extended-evidence-cap");
  });

  test("escalates to extended-evidence-cap when only the bare single-fact floor survives (finding 2)", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: [webSource.id] };
    const questions = Object.fromEntries(ALL_COMPANY_QUESTION_KEYS.map((key) => [key, answer]));
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: answer,
      questions,
      recentMaterialEvents: [],
      // Only one surviving fact total (the parseProfile hard floor), below
      // The MIN_SURVIVING_FACT_COUNT substantive-body threshold of 2.
      factLedger: [{ claim: "Apple sells iPhone, Mac, and services.", sourceIds: [webSource.id] }],
      openGaps: [],
    });

    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.artifact?.factLedger).toHaveLength(1);
    expect(result.sourceGaps).toEqual([]);
  });

  test("uses the same sanitized rejection summary for the SourceGap and reusable artifact", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: [webSource.id] };
    const questions = Object.fromEntries(ALL_COMPANY_QUESTION_KEYS.map((key) => [key, answer]));
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: answer,
      questions,
      recentMaterialEvents: [
        { claim: "Apple announced a services event.", sourceIds: ["disallowed-source"] },
      ],
      factLedger: [
        { claim: "Apple sells iPhone, Mac, and services.", sourceIds: [webSource.id] },
        { claim: "Apple grew services revenue.", sourceIds: [webSource.id] },
      ],
      openGaps: ["Pre-existing model-reported gap."],
    });

    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]?.message).toBe(
      "Web Subject Profile: 1 of 15 items rejected for source-citation errors " +
        "(recentMaterialEvents[0]).",
    );
    expect(result.artifact?.openGaps).toEqual([
      "Pre-existing model-reported gap.",
      result.sourceGaps[0]!.message,
    ]);
    expect(result.sourceGaps[0]?.message).not.toContain("disallowed-source");
  });

  test("rejection disclosures never contain model-controlled trade-action source ids", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: [webSource.id] };
    const questions = Object.fromEntries(ALL_COMPANY_QUESTION_KEYS.map((key) => [key, answer]));
    // A model that emits a source title/sentence instead of an id is the
    // Exact failure mode that produces a disallowed id — and the id text can
    // Itself look like trade-action prose ("Hold rating...", "Sell side...").
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: answer,
      questions,
      recentMaterialEvents: [
        {
          claim: "BofA reiterated its rating.",
          sourceIds: ["BUY AAPL"],
        },
      ],
      factLedger: [
        { claim: "Apple sells iPhone, Mac, and services.", sourceIds: [webSource.id] },
        {
          claim: "Analyst note on Microsoft exposure.",
          sourceIds: ["Sell side note on Microsoft"],
        },
        { claim: "Apple grew services revenue.", sourceIds: [webSource.id] },
      ],
      openGaps: [],
    });

    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]?.message).not.toContain("BUY AAPL");
    expect(result.sourceGaps[0]?.message).not.toContain("Sell side note on Microsoft");
    expect(violatesResearchOnly(result.sourceGaps[0]!.message)).toBeNull();

    for (const gapText of result.artifact?.openGaps ?? []) {
      expect(gapText).not.toContain("BUY AAPL");
      expect(gapText).not.toContain("Sell side note on Microsoft");
      // The required assertion: the sanitized text must not trip the
      // Research-language scanner that assertSafeReportLanguage runs.
      expect(violatesResearchOnly(gapText)).toBeNull();
    }
  });

  test("separators kept in the sanitized summary cannot themselves prime the trade-action pattern", () => {
    // Field paths for every question key and both fact arrays, so the
    // Truncation ("and N more") and every ": "/"; "/", " separator the
    // Template can emit are exercised at least once.
    const answer = { answer: "Apple sells devices and services.", sourceIds: [] as string[] };
    const questions = Object.fromEntries(ALL_COMPANY_QUESTION_KEYS.map((key) => [key, answer]));
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: { answer: "Apple sells devices and services.", sourceIds: [webSource.id] },
      questions,
      recentMaterialEvents: [],
      factLedger: [
        { claim: "Apple sells iPhone, Mac, and services.", sourceIds: [webSource.id] },
        { claim: "Apple grew services revenue.", sourceIds: [webSource.id] },
      ],
      openGaps: [],
    });

    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    for (const gapText of result.artifact?.openGaps ?? []) {
      expect(violatesResearchOnly(gapText)).toBeNull();
    }
  });

  test("truncates rejected field paths with an accurate overflow count", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: [webSource.id] };
    const questions = Object.fromEntries(ALL_COMPANY_QUESTION_KEYS.map((key) => [key, answer]));
    // 12 rejected facts exceed MAX_DETAILED_REJECTIONS (5).
    const rejectedFacts = Array.from({ length: 12 }, (_, index) => ({
      claim: `Rejected claim ${index}.`,
      sourceIds: [`disallowed-id-${String(index).padStart(2, "0")}`],
    }));
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: answer,
      questions,
      recentMaterialEvents: [],
      factLedger: [
        { claim: "Apple sells iPhone, Mac, and services.", sourceIds: [webSource.id] },
        { claim: "Apple grew services revenue.", sourceIds: [webSource.id] },
        ...rejectedFacts,
      ],
      openGaps: [],
    });

    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.artifact?.factLedger).toHaveLength(2);
    expect(result.sourceGaps).toHaveLength(1);
    const gapMessage = result.sourceGaps[0]?.message ?? "";
    // 12 total rejections stated up front...
    expect(gapMessage).toContain("12 of 26 items rejected");
    // ...but only 5 detailed entries shown, with the remaining 7 counted...
    expect(gapMessage).toContain("factLedger[6]");
    expect(gapMessage).not.toContain("factLedger[7]");
    expect(gapMessage).toContain(", and 7 more");
    expect(gapMessage).not.toContain("disallowed-id-");

    // The sanitized openGaps summary truncates its field-path list the same
    // Way, and states the true total (12 of 26: 1 summary + 11 questions +
    // 2 surviving facts + 12 rejected facts).
    const openGap = result.artifact?.openGaps.at(-1) ?? "";
    expect(openGap).toContain("12 of 26 items rejected");
    expect(openGap).toContain("factLedger[6]");
    expect(openGap).not.toContain("factLedger[7]");
    expect(openGap).toContain(", and 7 more");
  });

  test("names the malformed field in the array-shape error (finding 5)", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: [webSource.id] };
    const questions = Object.fromEntries(ALL_COMPANY_QUESTION_KEYS.map((key) => [key, answer]));
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: answer,
      questions,
      recentMaterialEvents: "not-an-array",
      factLedger: [{ claim: "Apple sells iPhone, Mac, and services.", sourceIds: [webSource.id] }],
      openGaps: [],
    });

    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.sourceGaps[0]?.message).toContain("recentMaterialEvents must be an array");
  });

  test("degrades an uncited subject summary without discarding the profile", () => {
    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent: JSON.stringify({
        ...JSON.parse(profilePayload()),
        subjectSummary: { answer: "Uncited summary.", sourceIds: [] },
      }),
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.sourceGaps[0]).toMatchObject({
      cause: "validation-failed",
      evidenceQualityImpact: "extended-evidence-cap",
      message: expect.stringContaining("subjectSummary: answer cited no sourceIds"),
    });
    expect(result.artifact?.subjectSummary).toEqual({ answer: "", sourceIds: [] });
    expect(result.artifact?.sourceIds).toEqual([webSource.id]);
  });

  test("degrades a subject summary citing snapshot sourceIds and preserves the fact ledger", () => {
    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent: JSON.stringify({
        ...JSON.parse(profilePayload()),
        subjectSummary: {
          answer: "Summary with unknown citations.",
          sourceIds: ["verified-snapshot-AAPL", "verified-snapshot-SPY"],
        },
      }),
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.artifact?.subjectSummary).toEqual({ answer: "", sourceIds: [] });
    expect(result.artifact?.factLedger).toEqual([
      { claim: "Apple sells iPhone, Mac, and services.", sourceIds: [webSource.id] },
    ]);
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]).toMatchObject({
      cause: "validation-failed",
      evidenceQualityImpact: "extended-evidence-cap",
    });
    const gapMessage = result.sourceGaps[0]?.message ?? "";
    expect(gapMessage).toContain("subjectSummary: answer cited 2 unknown sourceIds");
    expect(gapMessage).not.toContain("verified-snapshot-AAPL");
  });

  test("counts repeated unknown sourceIds once", () => {
    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent: JSON.stringify({
        ...JSON.parse(profilePayload()),
        subjectSummary: {
          answer: "Summary with repeated unknown citations.",
          sourceIds: ["repeated-unknown", "repeated-unknown", "repeated-unknown"],
        },
      }),
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    expect(result.sourceGaps[0]?.message).toContain("answer cited 1 unknown sourceId");
  });
});

function metadataOnlySecFilingSource(overrides: Partial<Source> = {}): Source {
  return {
    id: "extended-sec-edgar-msft-10k",
    title: "MSFT SEC 10-K",
    fetchedAt: "2026-08-05T00:00:00.000Z",
    kind: "extended-evidence",
    assetClass: "equity",
    symbol: "MSFT",
    provider: "sec-edgar",
    ...overrides,
  };
}

describe("isCompanyProfileSecSource", () => {
  const secSource = metadataOnlySecFilingSource;

  test("accepts a text-backed 10-K/10-Q filing source", () => {
    expect(isCompanyProfileSecSource(secSource({ snippet: "[Business] Some filing text." }))).toBe(
      true,
    );
    expect(
      isCompanyProfileSecSource(
        secSource({ id: "extended-sec-edgar-msft-10q", snippet: "[MD&A] Some filing text." }),
      ),
    ).toBe(true);
  });

  // A1's metadata-only fallback reuses the same id shape and provider so
  // FilingPackets/latestSecFilingDate keep working when filing-text ingestion
  // Fails, but it carries no snippet. It must never become citable evidence for
  // A text-grounded stage merely because its id matches the 10-K/10-Q pattern.
  test("rejects a metadata-only filing source with no snippet", () => {
    expect(isCompanyProfileSecSource(secSource())).toBe(false);
    expect(isCompanyProfileSecSource(secSource({ id: "extended-sec-edgar-msft-10q" }))).toBe(false);
  });

  test("rejects sources that are not extended-evidence sec-edgar 10-K/10-Q filings", () => {
    expect(
      isCompanyProfileSecSource(
        secSource({ id: "extended-sec-edgar-msft-fundamentals", snippet: "text" }),
      ),
    ).toBe(false);
    expect(isCompanyProfileSecSource(secSource({ kind: "web", snippet: "text" }))).toBe(false);
    expect(isCompanyProfileSecSource(secSource({ provider: "yahoo", snippet: "text" }))).toBe(
      false,
    );
  });
});

/*
 * F3: the profile stage's own gap prose reaches `assertSafeReportLanguage` through the
 * `codeAssembledDigest` projection, where no synthesis draft can rewrite it. Deep AAPL run
 * 2026-09-07T09-51-24-783Z-a23bf02b died that way. The screen runs where the wording is produced.
 */
describe("Web Subject Profile openGaps research-only screen", () => {
  // The exact sentence the live run wrote into openGaps[4].
  const LIVE_GAP_SENTENCE =
    "Analyst consensus, price targets, options data, dividend history, and split history are not available in the supplied web sources.";

  const COMPANY_QUESTION_KEYS = [
    "whatItDoes",
    "howItMakesMoney",
    "customers",
    "geography",
    "purchaseRecurrence",
    "pricingPower",
    "recessionCyclicality",
    "managementTrackRecord",
    "capitalAllocation",
    "companyKpis",
    "riskFactors",
  ] as const;

  function payloadWithGaps(openGaps: readonly string[], sourceId = webSource.id): string {
    const answer = { answer: "Apple sells devices and services.", sourceIds: [sourceId] };
    return JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: answer,
      questions: Object.fromEntries(COMPANY_QUESTION_KEYS.map((key) => [key, answer])),
      recentMaterialEvents: [],
      factLedger: [{ claim: "Apple sells iPhone, Mac, and services.", sourceIds: [sourceId] }],
      openGaps,
    });
  }

  function buildWithGaps(openGaps: readonly string[]) {
    return buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent: payloadWithGaps(openGaps),
      webSources: [webSource],
      extendedEvidence: undefined,
    });
  }

  test("withholds the live gap sentence and declares the withholding", () => {
    const result = buildWithGaps([
      "The supplied excerpts do not provide region-by-region revenue percentages.",
      LIVE_GAP_SENTENCE,
    ]);

    const gaps = result.artifact?.openGaps ?? [];
    expect(gaps).not.toContain(LIVE_GAP_SENTENCE);
    expect(gaps).toContain(
      "The supplied excerpts do not provide region-by-region revenue percentages.",
    );
    // Absence is a finding: the withholding is declared in the artifact and as a Source Gap.
    expect(gaps.at(-1)).toContain("1 of 2 declared open gaps withheld");
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]?.source).toBe("web-subject-profile");
    expect(result.sourceGaps[0]?.message).toContain("1 of 2 declared open gaps withheld");
  });

  test("leaves the assembled report clean where the unscreened artifact would fail the gate", () => {
    const screened = buildWithGaps([LIVE_GAP_SENTENCE]).artifact;
    expect(screened).toBeDefined();
    expect(() =>
      assertSafeReportLanguage(researchReport({ extras: { webSubjectProfile: screened } })),
    ).not.toThrow();
    // Negative control: the same artifact with the original wording is exactly what killed the run.
    expect(() =>
      assertSafeReportLanguage(
        researchReport({
          extras: { webSubjectProfile: { ...screened, openGaps: [LIVE_GAP_SENTENCE] } },
        }),
      ),
    ).toThrow(ReportLanguageViolationError);
  });

  test("drops an asserted price target instead of laundering it into the report", () => {
    const asserted = "Our price target is 240 USD, well above spot.";
    const result = buildWithGaps([asserted]);

    const gaps = result.artifact?.openGaps ?? [];
    expect(gaps).not.toContain(asserted);
    // Not reworded, not partially retained: no fragment of the assertion survives.
    expect(gaps.join("\n")).not.toContain("240");
    expect(gaps).toEqual([
      expect.stringContaining("1 of 1 declared open gaps withheld"),
    ] as unknown as string[]);
    expect(() =>
      assertSafeReportLanguage(researchReport({ extras: { webSubjectProfile: result.artifact } })),
    ).not.toThrow();
  });

  test("keeps the code-generated rejection summary beside a withheld model entry", () => {
    const answer = { answer: "Apple sells devices and services.", sourceIds: [webSource.id] };
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: answer,
      questions: Object.fromEntries(COMPANY_QUESTION_KEYS.map((key) => [key, answer])),
      recentMaterialEvents: [],
      factLedger: [
        { claim: "Apple sells iPhone, Mac, and services.", sourceIds: [webSource.id] },
        { claim: "Uncited claim.", sourceIds: ["unknown-source-id"] },
      ],
      openGaps: [LIVE_GAP_SENTENCE],
    });
    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });

    const gaps = result.artifact?.openGaps ?? [];
    // Model entry withheld; the code-generated entry (the mixed array's other origin) survives.
    expect(gaps).not.toContain(LIVE_GAP_SENTENCE);
    expect(gaps.some((gap) => gap.includes("rejected for source-citation errors"))).toBe(true);
    expect(gaps.some((gap) => gap.includes("1 of 1 declared open gaps withheld"))).toBe(true);
    expect(result.sourceGaps).toHaveLength(2);
    for (const gap of gaps) {
      expect(violatesResearchOnly(gap)).toBeNull();
    }
  });

  test("leaves a clean profile untouched and keeps an empty array empty", () => {
    const clean = ["The supplied excerpts do not provide customer concentration."];
    const kept = buildWithGaps(clean);
    expect(kept.artifact?.openGaps).toEqual(clean);
    expect(kept.sourceGaps).toEqual([]);

    // `undefined` and `[]` are different: an absent gap list must not grow a withheld notice.
    const empty = buildWithGaps([]);
    expect(empty.artifact?.openGaps).toEqual([]);
    expect(empty.sourceGaps).toEqual([]);
  });

  test("replaces failure detail that trips the gate, keeping the detail on the Source Gap", () => {
    const message = 'Web Subject Profile stage failed (model returned "price target" text)';
    const result = buildWebSubjectProfileFailureEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      message,
      cause: "malformed-response",
      extendedEvidence: undefined,
    });

    expect(result.artifact?.openGaps).toEqual([
      "Web Subject Profile unavailable; the stage failure detail was withheld for research-only wording.",
    ]);
    // The SourceGap is outside the report-language scan, so the diagnostic detail is not lost.
    expect(result.sourceGaps[0]?.message).toBe(message);
  });

  test("keeps a clean failure message verbatim", () => {
    const message = "Web Subject Profile stage failed (request timed out)";
    const result = buildWebSubjectProfileFailureEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      message,
      cause: "malformed-response",
      extendedEvidence: undefined,
    });
    expect(result.artifact?.openGaps).toEqual([message]);
  });

  test("screens a reused artifact persisted before the screen existed", () => {
    const origin = buildWithGaps([
      "The supplied excerpts do not provide customer concentration.",
    ]).artifact;
    expect(origin).toBeDefined();
    const legacy = {
      ...origin,
      openGaps: [...(origin?.openGaps ?? []), LIVE_GAP_SENTENCE],
    } as NonNullable<typeof origin>;

    const freshnessGap = sourceGap({
      source: "web-subject-profile",
      message: "Reused Web Subject Profile is 3 days old.",
      provider: "market-bot",
      capability: "extended-evidence",
      cause: "reused-in-window",
    });
    const result = buildWebSubjectProfileReuseEvidence({
      command,
      subject,
      artifact: legacy,
      extendedEvidence: undefined,
      freshnessGap,
    });

    expect(result.artifact?.openGaps).not.toContain(LIVE_GAP_SENTENCE);
    expect(result.artifact?.openGaps.at(-1)).toContain("1 of 2 declared open gaps withheld");
    expect(result.sourceGaps).toHaveLength(2);
    expect(() =>
      assertSafeReportLanguage(researchReport({ extras: { webSubjectProfile: result.artifact } })),
    ).not.toThrow();
  });

  test("keeps a clean reused artifact byte-identical", () => {
    const origin = buildWithGaps([
      "The supplied excerpts do not provide customer concentration.",
    ]).artifact;
    expect(origin).toBeDefined();
    const freshnessGap = sourceGap({
      source: "web-subject-profile",
      message: "Reused Web Subject Profile is 3 days old.",
      provider: "market-bot",
      capability: "extended-evidence",
      cause: "reused-in-window",
    });
    const result = buildWebSubjectProfileReuseEvidence({
      command,
      subject,
      artifact: origin as NonNullable<typeof origin>,
      extendedEvidence: undefined,
      freshnessGap,
    });
    expect(result.artifact).toEqual(origin as NonNullable<typeof origin>);
    expect(result.sourceGaps).toEqual([freshnessGap]);
  });
});

describe("Web Subject Profile withheld-notice detection", () => {
  test("keys off the stable marker, not the full notice wording", () => {
    expect(WEB_SUBJECT_PROFILE_WITHHELD_ANSWER_NOTICE).toContain(
      WEB_SUBJECT_PROFILE_WITHHELD_MARKER,
    );
    expect(WEB_SUBJECT_PROFILE_WITHHELD_SUBJECT_SUMMARY_NOTICE).toContain(
      WEB_SUBJECT_PROFILE_WITHHELD_MARKER,
    );
    expect(isWebSubjectProfileWithheldAnswer(WEB_SUBJECT_PROFILE_WITHHELD_MARKER)).toBe(true);
    expect(
      isWebSubjectProfileWithheldAnswer(
        `Persisted notice ${WEB_SUBJECT_PROFILE_WITHHELD_MARKER} with later wording.`,
      ),
    ).toBe(true);
    expect(
      isWebSubjectProfileWithheldAnswer(
        WEB_SUBJECT_PROFILE_WITHHELD_ANSWER_NOTICE.replaceAll(
          WEB_SUBJECT_PROFILE_WITHHELD_MARKER,
          "",
        ),
      ),
    ).toBe(false);
    expect(isWebSubjectProfileWithheldAnswer("Apple sells devices and services.")).toBe(false);
  });
});

/*
 * The four model-authored fields 9a43283 left unscreened. Each reaches `assertSafeReportLanguage`
 * through the same `codeAssembledDigest` projection as `openGaps`. Real gate matches, not
 * contrived: `buy AI` / `overvalued` / `buy LNG` / `you should`.
 */
describe("Web Subject Profile model-authored field research-only screen", () => {
  const COMPANY_QUESTION_KEYS = [
    "whatItDoes",
    "howItMakesMoney",
    "customers",
    "geography",
    "purchaseRecurrence",
    "pricingPower",
    "recessionCyclicality",
    "managementTrackRecord",
    "capitalAllocation",
    "companyKpis",
    "riskFactors",
  ] as const;
  const CRYPTO_QUESTION_KEYS = [
    "whatItDoes",
    "valueAccrual",
    "supplyIssuance",
    "usageAdoption",
    "governanceBuilders",
    "competitionMoat",
    "keyRisks",
  ] as const;
  const THEME_QUESTION_KEYS = [
    "whatItIs",
    "whyNow",
    "beneficiaries",
    "headwinds",
    "keyDebates",
    "howItPlaysOut",
  ] as const;

  const BUY_AI = "Customers buy AI accelerators from the company.";
  const OVERVALUED = "The filing discusses whether the group is overvalued.";
  const BUY_LNG = "Utilities buy LNG cargoes under long contracts.";
  const YOU_SHOULD = "The 10-K states you should consider these risks.";
  const BUY_ETH = "Users buy ETH through exchanges and self-custody wallets.";
  const CLEAN_ANSWER = "Apple sells devices and services.";
  const CLEAN_FACT = "Apple sells iPhone, Mac, and services.";

  function companyPayload(overrides: {
    readonly subjectSummary?: string;
    readonly questions?: Readonly<Record<string, string>>;
    readonly recentMaterialEvents?: readonly string[];
    readonly factLedger?: readonly string[];
    readonly openGaps?: readonly string[];
  }): string {
    const answer = { answer: CLEAN_ANSWER, sourceIds: [webSource.id] };
    const questions = Object.fromEntries(
      COMPANY_QUESTION_KEYS.map((key) => [
        key,
        overrides.questions?.[key] === undefined
          ? answer
          : { answer: overrides.questions[key], sourceIds: [webSource.id] },
      ]),
    );
    return JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary:
        overrides.subjectSummary === undefined
          ? answer
          : { answer: overrides.subjectSummary, sourceIds: [webSource.id] },
      questions,
      recentMaterialEvents: (overrides.recentMaterialEvents ?? []).map((claim) => ({
        claim,
        sourceIds: [webSource.id],
      })),
      factLedger: (overrides.factLedger ?? [CLEAN_FACT]).map((claim) => ({
        claim,
        sourceIds: [webSource.id],
      })),
      openGaps: overrides.openGaps ?? [],
    });
  }

  function buildCompany(overrides: Parameters<typeof companyPayload>[0] = {}) {
    return buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent: companyPayload(overrides),
      webSources: [webSource],
      extendedEvidence: undefined,
    });
  }

  test("replaces a tripping subjectSummary and keeps the required shape", () => {
    const result = buildCompany({ subjectSummary: OVERVALUED });
    expect(result.artifact?.subjectSummary.answer).not.toContain("overvalued");
    expect(result.artifact?.subjectSummary.answer).toContain("subject summary withheld");
    expect(result.artifact?.subjectSummary.sourceIds).toEqual([webSource.id]);
    expect(result.sourceGaps).toHaveLength(1);
    expect(result.sourceGaps[0]).toMatchObject({
      source: "web-subject-profile",
      cause: "validation-failed",
    });
    expect(result.sourceGaps[0]?.message).toContain("subject summary withheld");
    expect(() =>
      assertSafeReportLanguage(researchReport({ extras: { webSubjectProfile: result.artifact } })),
    ).not.toThrow();
    expect(() =>
      assertSafeReportLanguage(
        researchReport({
          extras: {
            webSubjectProfile: {
              ...result.artifact,
              subjectSummary: { answer: OVERVALUED, sourceIds: [webSource.id] },
            },
          },
        }),
      ),
    ).toThrow(ReportLanguageViolationError);
  });

  test("replaces a tripping company question answer rather than dropping the key", () => {
    const result = buildCompany({ questions: { whatItDoes: BUY_AI } });
    const whatItDoes =
      result.artifact?.subjectKind === "company" ? result.artifact.questions.whatItDoes : undefined;
    const howItMakesMoney =
      result.artifact?.subjectKind === "company"
        ? result.artifact.questions.howItMakesMoney
        : undefined;
    expect(whatItDoes?.answer).not.toContain("buy AI");
    expect(whatItDoes?.answer).toContain("this answer withheld");
    expect(whatItDoes?.sourceIds).toEqual([webSource.id]);
    expect(howItMakesMoney?.answer).toBe(CLEAN_ANSWER);
    expect(Object.keys(result.artifact?.questions ?? {})).toEqual([...COMPANY_QUESTION_KEYS]);
    expect(result.sourceGaps[0]?.message).toContain("1 of 11 question answers withheld");
    expect(() =>
      assertSafeReportLanguage(researchReport({ extras: { webSubjectProfile: result.artifact } })),
    ).not.toThrow();
  });

  test("treats marker-plus-violation as a violation rather than a withheld notice", () => {
    const probe =
      "The consensus price target was withheld for research-only wording by the source.";
    const result = buildCompany({
      questions: { whatItDoes: probe },
      factLedger: [CLEAN_FACT, probe],
      openGaps: ["Segment mix is not broken out in the cited sources.", probe],
    });
    const whatItDoes =
      result.artifact?.subjectKind === "company" ? result.artifact.questions.whatItDoes : undefined;

    expect(whatItDoes?.answer).not.toBe(probe);
    expect(whatItDoes?.answer).toBe(WEB_SUBJECT_PROFILE_WITHHELD_ANSWER_NOTICE);
    expect(result.artifact?.factLedger.map((fact) => fact.claim)).not.toContain(probe);
    expect(result.artifact?.openGaps).not.toContain(probe);
    expect(JSON.stringify(result.artifact)).not.toContain("price target");
    expect(result.sourceGaps.some((gap) => gap.message.includes("question answers withheld"))).toBe(
      true,
    );
    expect(
      result.sourceGaps.some((gap) => gap.message.includes("fact-ledger claims withheld")),
    ).toBe(true);
    expect(
      result.sourceGaps.some((gap) => gap.message.includes("declared open gaps withheld")),
    ).toBe(true);
    expect(() =>
      assertSafeReportLanguage(researchReport({ extras: { webSubjectProfile: result.artifact } })),
    ).not.toThrow();
  });

  test("drops a tripping recent material event and appends a withheld-count notice", () => {
    const cleanEvent = "Apple expanded services disclosure.";
    const result = buildCompany({
      recentMaterialEvents: [cleanEvent, YOU_SHOULD],
    });
    const events = result.artifact?.recentMaterialEvents ?? [];
    expect(events.map((event) => event.claim)).not.toContain(YOU_SHOULD);
    expect(events[0]?.claim).toBe(cleanEvent);
    expect(events.at(-1)?.claim).toContain("1 of 2 recent material events withheld");
    expect(events.at(-1)?.sourceIds).toEqual([webSource.id]);
    expect(result.sourceGaps[0]?.message).toContain("1 of 2 recent material events withheld");
    expect(() =>
      assertSafeReportLanguage(researchReport({ extras: { webSubjectProfile: result.artifact } })),
    ).not.toThrow();
  });

  test("drops a tripping fact-ledger claim and keeps the array non-empty", () => {
    const result = buildCompany({ factLedger: [BUY_LNG] });
    const facts = result.artifact?.factLedger ?? [];
    expect(facts.map((fact) => fact.claim)).not.toContain(BUY_LNG);
    expect(facts.map((fact) => fact.claim).join("\n")).not.toContain("LNG");
    expect(facts).toHaveLength(1);
    expect(facts[0]?.claim).toContain("1 of 1 fact-ledger claims withheld");
    expect(result.sourceGaps[0]?.message).toContain("1 of 1 fact-ledger claims withheld");
    expect(() =>
      assertSafeReportLanguage(researchReport({ extras: { webSubjectProfile: result.artifact } })),
    ).not.toThrow();
  });

  test("replaces a crypto-asset usageAdoption answer that trips buy ETH", () => {
    const cryptoSubject = {
      subjectKind: "crypto-asset",
      subjectId: "ETH",
      subjectLabel: "Ethereum",
      assetClass: "crypto",
      symbol: "ETH",
    } as const;
    const source = {
      ...webSource,
      id: "web-eth-12345678",
      assetClass: "crypto",
      symbol: "ETH",
    } as const;
    const answer = {
      answer: "Ethereum is a smart-contract settlement network.",
      sourceIds: [source.id],
    };
    const result = buildWebSubjectProfileEvidence({
      command: { jobType: "crypto", assetClass: "crypto", symbol: "ETH", depth: "deep" },
      subject: cryptoSubject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent: JSON.stringify({
        subjectLabel: "Ethereum",
        subjectSummary: answer,
        questions: Object.fromEntries(
          CRYPTO_QUESTION_KEYS.map((key) => [
            key,
            key === "usageAdoption" ? { answer: BUY_ETH, sourceIds: [source.id] } : answer,
          ]),
        ),
        recentMaterialEvents: [],
        factLedger: [{ claim: "Ethereum uses proof-of-stake consensus.", sourceIds: [source.id] }],
        openGaps: [],
      }),
      webSources: [source],
      extendedEvidence: undefined,
    });

    expect(result.artifact?.subjectKind).toBe("crypto-asset");
    const usage =
      result.artifact?.subjectKind === "crypto-asset"
        ? result.artifact.questions.usageAdoption
        : undefined;
    expect(usage?.answer).not.toContain("buy ETH");
    expect(usage?.answer).toContain("this answer withheld");
    expect(result.sourceGaps[0]?.message).toContain("1 of 7 question answers withheld");
    expect(() =>
      assertSafeReportLanguage(researchReport({ extras: { webSubjectProfile: result.artifact } })),
    ).not.toThrow();
  });

  test("replaces a theme question answer that trips overvalued", () => {
    const themeSubject = {
      subjectKind: "theme",
      subjectId: "ai-infrastructure",
      subjectLabel: "AI infrastructure",
    } as const;
    const source = { ...webSource, id: "web-theme-12345678" };
    const answer = {
      answer: "AI infrastructure is a listed-market research theme.",
      sourceIds: [source.id],
    };
    const result = buildWebSubjectProfileEvidence({
      command: {
        jobType: "research",
        assetClass: "equity",
        subject: "AI infrastructure",
        depth: "deep",
      },
      subject: themeSubject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent: JSON.stringify({
        subjectLabel: "AI infrastructure",
        subjectSummary: answer,
        questions: Object.fromEntries(
          THEME_QUESTION_KEYS.map((key) => [
            key,
            key === "keyDebates" ? { answer: OVERVALUED, sourceIds: [source.id] } : answer,
          ]),
        ),
        recentMaterialEvents: [],
        factLedger: [{ claim: "Listed proxies track the theme.", sourceIds: [source.id] }],
        openGaps: [],
      }),
      webSources: [source],
      extendedEvidence: undefined,
    });

    expect(result.artifact?.subjectKind).toBe("theme");
    const debate =
      result.artifact?.subjectKind === "theme" ? result.artifact.questions.keyDebates : undefined;
    expect(debate?.answer).not.toContain("overvalued");
    expect(debate?.answer).toContain("this answer withheld");
    expect(result.sourceGaps[0]?.message).toContain("1 of 6 question answers withheld");
  });

  test("throws rather than laundering a code-generated withheld notice that trips the gate", async () => {
    const languageModule = await import("../src/domain/research-language");
    const original = languageModule.violatesResearchOnly;
    const languageSpy = spyOn(languageModule, "violatesResearchOnly").mockImplementation(
      (text: string) => {
        if (text.includes("withheld for research-only wording")) {
          return { match: "price target" };
        }
        return original(text);
      },
    );
    try {
      expect(() => buildCompany({ questions: { whatItDoes: BUY_AI } })).toThrow(
        /code-assembled and must not carry research-only wording: "price target"/u,
      );
    } finally {
      languageSpy.mockRestore();
    }
  });

  test("screens a reused artifact whose question answer was persisted before the screen", () => {
    const origin = buildCompany().artifact;
    expect(origin).toBeDefined();
    expect(origin?.subjectKind).toBe("company");
    const legacy = {
      ...origin,
      questions: {
        ...origin?.questions,
        whatItDoes: { answer: BUY_AI, sourceIds: [webSource.id] },
      },
    } as NonNullable<typeof origin>;

    const result = buildWebSubjectProfileReuseEvidence({
      command,
      subject,
      artifact: legacy,
      extendedEvidence: undefined,
      freshnessGap: reuseFreshnessGap(),
    });

    const whatItDoes =
      result.artifact?.subjectKind === "company" ? result.artifact.questions.whatItDoes : undefined;
    expect(whatItDoes?.answer).not.toContain("buy AI");
    expect(whatItDoes?.answer).toContain("this answer withheld");
    expect(result.sourceGaps).toHaveLength(2);
    expect(result.sourceGaps[1]?.message).toContain("question answers withheld");
    expect(() =>
      assertSafeReportLanguage(researchReport({ extras: { webSubjectProfile: result.artifact } })),
    ).not.toThrow();
  });

  test("re-emits withheld SourceGaps when reusing a notice-bearing profile", () => {
    const origin = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent: JSON.stringify({
        companyName: "Apple Inc.",
        subjectSummary: { answer: OVERVALUED, sourceIds: [webSource.id] },
        questions: Object.fromEntries(
          COMPANY_QUESTION_KEYS.map((key) => [key, { answer: BUY_AI, sourceIds: [webSource.id] }]),
        ),
        recentMaterialEvents: [],
        factLedger: [{ claim: CLEAN_FACT, sourceIds: [webSource.id] }],
        openGaps: [],
      }),
      webSources: [webSource],
      extendedEvidence: undefined,
    }).artifact;
    expect(origin).toBeDefined();

    const result = buildWebSubjectProfileReuseEvidence({
      command,
      subject,
      artifact: origin as NonNullable<typeof origin>,
      extendedEvidence: undefined,
      freshnessGap: reuseFreshnessGap(),
    });

    expect(result.sourceGaps[0]).toEqual(reuseFreshnessGap());
    expect(result.sourceGaps.some((gap) => gap.message.includes("subject summary withheld"))).toBe(
      true,
    );
    expect(
      result.sourceGaps.some((gap) => gap.message.includes("11 of 11 question answers withheld")),
    ).toBe(true);
    expect(
      result.sourceGaps.some(
        (gap) =>
          gap.source === "web-subject-profile" &&
          gap.cause === "validation-failed" &&
          gap.evidenceQualityImpact === "extended-evidence-cap",
      ),
    ).toBe(true);
    expect(result.artifact?.subjectSummary.answer).toBe(
      WEB_SUBJECT_PROFILE_WITHHELD_SUBJECT_SUMMARY_NOTICE,
    );
  });

  test("counts only real entries in withheld denominators and re-emits both gaps", () => {
    const origin = buildCompany().artifact;
    expect(origin).toBeDefined();
    const factNotice = buildCompany({ factLedger: [BUY_LNG] }).artifact?.factLedger.at(-1);
    const gapNotice = buildCompany({ openGaps: [YOU_SHOULD] }).artifact?.openGaps.at(-1);
    expect(factNotice?.claim).toContain("fact-ledger claims withheld");
    expect(gapNotice).toContain("declared open gaps withheld");

    const mixed = {
      ...origin,
      factLedger: [
        { claim: CLEAN_FACT, sourceIds: [webSource.id] },
        factNotice!,
        { claim: BUY_LNG, sourceIds: [webSource.id] },
      ],
      openGaps: ["A remaining qualitative gap.", gapNotice!, YOU_SHOULD],
    } as NonNullable<typeof origin>;

    const result = buildWebSubjectProfileReuseEvidence({
      command,
      subject,
      artifact: mixed,
      extendedEvidence: undefined,
      freshnessGap: reuseFreshnessGap(),
    });

    expect(result.artifact?.factLedger.map((fact) => fact.claim)).not.toContain(BUY_LNG);
    expect(result.artifact?.openGaps).not.toContain(YOU_SHOULD);
    expect(
      result.sourceGaps.some((gap) => gap.message.includes("1 of 2 fact-ledger claims withheld")),
    ).toBe(true);
    expect(
      result.sourceGaps.some((gap) => gap.message.includes("1 of 2 declared open gaps withheld")),
    ).toBe(true);
    expect(result.sourceGaps.some((gap) => gap.message === factNotice?.claim)).toBe(true);
    expect(result.sourceGaps.some((gap) => gap.message === gapNotice)).toBe(true);
    expect(result.sourceGaps.some((gap) => gap.message.includes("1 of 3"))).toBe(false);
  });

  test("screens reused fact-ledger and recent-event claims the same way", () => {
    const origin = buildCompany().artifact;
    expect(origin).toBeDefined();
    const legacy = {
      ...origin,
      recentMaterialEvents: [{ claim: YOU_SHOULD, sourceIds: [webSource.id] }],
      factLedger: [{ claim: BUY_LNG, sourceIds: [webSource.id] }],
    } as NonNullable<typeof origin>;

    const result = buildWebSubjectProfileReuseEvidence({
      command,
      subject,
      artifact: legacy,
      extendedEvidence: undefined,
      freshnessGap: reuseFreshnessGap(),
    });

    expect(result.artifact?.recentMaterialEvents.map((event) => event.claim)).not.toContain(
      YOU_SHOULD,
    );
    expect(result.artifact?.factLedger.map((fact) => fact.claim)).not.toContain(BUY_LNG);
    expect(result.artifact?.factLedger).toHaveLength(1);
    expect(result.sourceGaps.length).toBeGreaterThanOrEqual(3);
  });

  test("keeps a clean reused artifact byte-identical across the new fields", () => {
    const origin = buildCompany({
      recentMaterialEvents: ["Apple expanded services disclosure."],
    }).artifact;
    expect(origin).toBeDefined();
    const result = buildWebSubjectProfileReuseEvidence({
      command,
      subject,
      artifact: origin as NonNullable<typeof origin>,
      extendedEvidence: undefined,
      freshnessGap: reuseFreshnessGap(),
    });
    expect(result.artifact).toEqual(origin as NonNullable<typeof origin>);
    expect(result.sourceGaps).toEqual([reuseFreshnessGap()]);
  });

  test("leaves empty event arrays empty and does not mint a withheld notice", () => {
    const result = buildCompany({ recentMaterialEvents: [], openGaps: [] });
    expect(result.artifact?.recentMaterialEvents).toEqual([]);
    expect(result.artifact?.openGaps).toEqual([]);
    expect(result.sourceGaps).toEqual([]);
  });

  test("does not replace an already-empty required answer", () => {
    const answer = { answer: CLEAN_ANSWER, sourceIds: [webSource.id] };
    const modelContent = JSON.stringify({
      companyName: "Apple Inc.",
      subjectSummary: { answer: "", sourceIds: [] },
      questions: Object.fromEntries(
        COMPANY_QUESTION_KEYS.map((key) => [
          key,
          key === "whatItDoes" ? { answer: "", sourceIds: [] } : answer,
        ]),
      ),
      recentMaterialEvents: [],
      factLedger: [{ claim: CLEAN_FACT, sourceIds: [webSource.id] }],
      openGaps: [],
    });
    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent,
      webSources: [webSource],
      extendedEvidence: undefined,
    });
    const whatItDoes =
      result.artifact?.subjectKind === "company" ? result.artifact.questions.whatItDoes : undefined;
    expect(result.artifact?.subjectSummary).toEqual({ answer: "", sourceIds: [] });
    expect(whatItDoes).toEqual({ answer: "", sourceIds: [] });
    expect(result.sourceGaps.every((gap) => !gap.message.includes("withheld"))).toBe(true);
  });

  test("does not emit a filing-basis line when every company answer was withheld", () => {
    const secTenK: Source = {
      id: "extended-sec-edgar-aapl-10k",
      title: "AAPL SEC 10-K",
      fetchedAt: "2026-05-19T00:00:00.000Z",
      kind: "extended-evidence",
      assetClass: "equity",
      symbol: "AAPL",
      provider: "sec-edgar",
      snippet: "[MD&A] Some filing text.",
    };
    const withheld = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent: JSON.stringify({
        companyName: "Apple Inc.",
        subjectSummary: { answer: OVERVALUED, sourceIds: [secTenK.id] },
        questions: Object.fromEntries(
          COMPANY_QUESTION_KEYS.map((key) => [key, { answer: BUY_AI, sourceIds: [secTenK.id] }]),
        ),
        recentMaterialEvents: [],
        factLedger: [{ claim: CLEAN_FACT, sourceIds: [webSource.id] }],
        openGaps: [],
      }),
      webSources: [webSource, secTenK],
      extendedEvidence: undefined,
    });
    expect(withheld.artifact).toBeDefined();
    expect(withheld.artifact?.subjectSummary.answer).toContain("subject summary withheld");
    const markdown = renderWebSubjectProfile(
      researchReport({
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        sources: [webSource, secTenK],
        extendedEvidence: {
          instrument: { assetClass: "equity", symbol: "AAPL" },
          items: [
            {
              category: "sec-edgar",
              title: "AAPL SEC 10-K",
              summary: "10-K filed 2025-11-01 for period 2025-09-30.",
              sourceIds: [secTenK.id],
              observedAt: "2025-11-01T00:00:00.000Z",
              metrics: { form: "10-K", filingDate: "2025-11-01", reportDate: "2025-09-30" },
            },
          ],
          gaps: [],
        },
        extras: { webSubjectProfile: withheld.artifact },
      }),
    );
    expect(markdown).toContain("## Web Subject Profile");
    expect(markdown).not.toContain("**Basis:**");
  });

  test("still emits a filing-basis line when a clean answer cites the filing", () => {
    const secTenK: Source = {
      id: "extended-sec-edgar-aapl-10k",
      title: "AAPL SEC 10-K",
      fetchedAt: "2026-05-19T00:00:00.000Z",
      kind: "extended-evidence",
      assetClass: "equity",
      symbol: "AAPL",
      provider: "sec-edgar",
      snippet: "[MD&A] Some filing text.",
    };
    const clean = { answer: CLEAN_ANSWER, sourceIds: [secTenK.id] };
    const result = buildWebSubjectProfileEvidence({
      command,
      subject,
      generatedAt: "2026-05-19T00:00:00.000Z",
      runId: "test-run",
      modelContent: JSON.stringify({
        companyName: "Apple Inc.",
        subjectSummary: { answer: OVERVALUED, sourceIds: [secTenK.id] },
        questions: Object.fromEntries(
          COMPANY_QUESTION_KEYS.map((key) => [
            key,
            key === "whatItDoes" ? clean : { answer: BUY_AI, sourceIds: [secTenK.id] },
          ]),
        ),
        recentMaterialEvents: [],
        factLedger: [{ claim: CLEAN_FACT, sourceIds: [webSource.id] }],
        openGaps: [],
      }),
      webSources: [webSource, secTenK],
      extendedEvidence: undefined,
    });
    const markdown = renderWebSubjectProfile(
      researchReport({
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        sources: [webSource, secTenK],
        extendedEvidence: {
          instrument: { assetClass: "equity", symbol: "AAPL" },
          items: [
            {
              category: "sec-edgar",
              title: "AAPL SEC 10-K",
              summary: "10-K filed 2025-11-01 for period 2025-09-30.",
              sourceIds: [secTenK.id],
              observedAt: "2025-11-01T00:00:00.000Z",
              metrics: { form: "10-K", filingDate: "2025-11-01", reportDate: "2025-09-30" },
            },
          ],
          gaps: [],
        },
        extras: { webSubjectProfile: result.artifact },
      }),
    );
    expect(markdown).toContain("**Basis:** 10-K filed 2025-11-01 (period 2025-09-30).");
  });

  test("replaces a tripping uncited reused answer with EMPTY_ANSWER", () => {
    const origin = buildCompany().artifact;
    expect(origin).toBeDefined();
    const legacy = {
      ...origin,
      questions: {
        ...origin?.questions,
        whatItDoes: { answer: BUY_AI, sourceIds: [] },
      },
    } as NonNullable<typeof origin>;
    const result = buildWebSubjectProfileReuseEvidence({
      command,
      subject,
      artifact: legacy,
      extendedEvidence: undefined,
      freshnessGap: reuseFreshnessGap(),
    });
    const whatItDoes =
      result.artifact?.subjectKind === "company" ? result.artifact.questions.whatItDoes : undefined;
    expect(whatItDoes).toEqual({ answer: "", sourceIds: [] });
    expect(result.sourceGaps.some((gap) => gap.message.includes("question answers withheld"))).toBe(
      true,
    );
    expect(() =>
      validateResearchReport(
        researchReport({
          extras: { webSubjectProfile: result.artifact },
          sources: [webSource],
        }),
      ),
    ).not.toThrow();
  });
});
