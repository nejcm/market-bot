import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RESEARCH_SUBJECT_REGISTRY,
  normalizeResearchSubjectQuery,
  resolveResearchSubjectProxy,
  validateResearchSubjectRegistry,
  type ResearchSubjectRegistryEntry,
} from "../src/research/subject-registry";

const baseEntry: ResearchSubjectRegistryEntry = {
  subjectKey: "test-subject",
  displayName: "Test Subject",
  aliases: ["test subject"],
  assetClass: "equity",
  representativeInstruments: [
    {
      symbol: "TEST",
      name: "Test ETF",
      instrumentType: "listed-etf",
      sourceIds: ["test-source"],
    },
  ],
  predictionProxy: {
    symbol: "TEST",
    instrumentType: "listed-etf",
    sourceIds: ["test-source"],
  },
  sources: [{ sourceId: "test-source", title: "Test source" }],
};

describe("research subject registry", () => {
  test("default registry is valid", () => {
    expect(validateResearchSubjectRegistry(DEFAULT_RESEARCH_SUBJECT_REGISTRY)).toEqual({
      valid: true,
      errors: [],
    });
  });

  test("normalizes prompt subjects for deterministic alias matching", () => {
    expect(normalizeResearchSubjectQuery("  AI--Data Centers'  ")).toBe("ai data centers");
  });

  test("resolves aliases to a single listed prediction proxy", () => {
    const result = resolveResearchSubjectProxy("Chip stocks");

    expect(result).toMatchObject({
      status: "resolved",
      canEmitPredictions: true,
      predictionProxySymbol: "SMH",
      reason: "Resolved to checked-in single listed prediction proxy",
    });
    expect(result.subject?.subjectKey).toBe("semiconductors");
  });

  test("resolves known subjects without a proxy but keeps predictions disabled", () => {
    const result = resolveResearchSubjectProxy("AI capex");

    expect(result).toMatchObject({
      status: "resolved",
      canEmitPredictions: false,
      reason: "Subject has no single listed prediction proxy",
    });
    expect(result.subject?.subjectKey).toBe("ai-infrastructure");
    expect(result.predictionProxySymbol).toBeUndefined();
  });

  test("returns a no-proxy result when the subject is not checked in", () => {
    expect(resolveResearchSubjectProxy("unknown niche")).toEqual({
      input: "unknown niche",
      normalizedInput: "unknown niche",
      status: "unresolved",
      canEmitPredictions: false,
      reason: "No checked-in subject registry match",
    });
  });

  test("rejects duplicate aliases across subjects", () => {
    const result = validateResearchSubjectRegistry([
      baseEntry,
      {
        ...baseEntry,
        subjectKey: "duplicate-subject",
        displayName: "Duplicate Subject",
        aliases: ["Test Subject"],
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'duplicate-subject: alias "test subject" already belongs to test-subject',
    );
  });

  test("requires representative and proxy provenance", () => {
    const result = validateResearchSubjectRegistry([
      {
        ...baseEntry,
        representativeInstruments: [
          {
            symbol: "TEST",
            instrumentType: "listed-etf",
            sourceIds: ["missing-source"],
          },
        ],
        predictionProxy: {
          symbol: "TEST",
          instrumentType: "listed-etf",
          sourceIds: [],
        },
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("test-subject: unknown sourceId missing-source");
    expect(result.errors).toContain("test-subject: registry items must cite sourceIds");
  });
});
