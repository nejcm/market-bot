import { describe, expect, test } from "bun:test";
import { resolveResearchSubject } from "../src/research/research-subject-identity";
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

  test("resolves from the raw subject instead of caller-provided identity", () => {
    const result = resolveResearchSubject({
      jobType: "research",
      assetClass: "equity",
      subject: "Chip stocks",
      subjectKey: "bogus-subject",
      predictionProxySymbol: "BOGUS",
      depth: "brief",
    });

    expect(result).toMatchObject({
      status: "resolved",
      subjectKey: "semiconductors",
      predictionProxySymbol: "SMH",
    });
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

  test("rejects duplicate subject keys", () => {
    const result = validateResearchSubjectRegistry([
      baseEntry,
      {
        ...baseEntry,
        displayName: "Duplicate Subject",
        aliases: ["duplicate subject"],
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("test-subject: duplicate subjectKey");
  });

  test("rejects duplicate normalized aliases within a subject", () => {
    const result = validateResearchSubjectRegistry([
      {
        ...baseEntry,
        aliases: ["small-cap stocks", "small cap stocks"],
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'test-subject: alias "small cap stocks" is duplicated within subject',
    );
  });

  test("rejects invalid registry shape", () => {
    const result = validateResearchSubjectRegistry([
      {
        ...baseEntry,
        subjectKey: "Bad Slug",
        aliases: [],
        assetClass: "crypto" as never,
        representativeInstruments: [],
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Bad Slug: subjectKey must be a lowercase slug");
    expect(result.errors).toContain("Bad Slug: v1 registry supports equity subjects only");
    expect(result.errors).toContain("Bad Slug: aliases must not be empty");
    expect(result.errors).toContain("Bad Slug: representativeInstruments must not be empty");
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

  test("requires a listed ETF proxy that is represented and has a valid symbol", () => {
    const result = validateResearchSubjectRegistry([
      {
        ...baseEntry,
        predictionProxy: {
          symbol: "BRK.",
          instrumentType: "listed-stock" as never,
          sourceIds: ["test-source"],
        },
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("test-subject: invalid prediction proxy symbol BRK.");
    expect(result.errors).toContain("test-subject: prediction proxy must be a listed ETF");
    expect(result.errors).toContain(
      "test-subject: prediction proxy symbol BRK. must be representative",
    );
  });

  test("rejects unused source provenance", () => {
    const result = validateResearchSubjectRegistry([
      {
        ...baseEntry,
        sources: [...baseEntry.sources, { sourceId: "unused-source", title: "Unused source" }],
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.errors).toContain("test-subject: unused sourceId unused-source");
  });
});
