import { describe, expect, test } from "bun:test";
import {
  readBusinessFrameworkExtra,
  readWebSubjectProfileAnswer,
  readWebSubjectProfileExtra,
  readWebSubjectProfileFacts,
  webSubjectProfileQuestionKeys,
} from "../src/report/report-extras-contract";
import { renderMarkdownReport } from "../src/report/markdown";
import { researchReport } from "./support/fixtures";
import { readGoldenOutput } from "./support/run-fixtures/artifacts";

// These readers replaced ad-hoc isRecord walks in src/report/markdown.ts, so the
// Spec is what those walks accepted, not what the producer emits. Each test below
// Pins one row of that acceptance table; a stricter reader silently drops
// Citations or a whole section from a report the schema still validates.

async function goldenExtra(fixture: string, key: string): Promise<Record<string, unknown>> {
  const golden = await readGoldenOutput(fixture);
  const report = golden.report as Record<string, unknown>;
  const extras = report.extras as Record<string, unknown>;
  const extra = extras[key];
  expect(extra).toBeDefined();
  return extra as Record<string, unknown>;
}

function withReplacedRow(
  extra: Record<string, unknown>,
  key: string,
  index: number,
  row: unknown,
): Record<string, unknown> {
  const rows = extra[key] as readonly unknown[];
  return { ...extra, [key]: rows.map((item, position) => (position === index ? row : item)) };
}

describe("business framework extra", () => {
  test("round-trips the equity-aapl-deep golden payload", async () => {
    const extra = await goldenExtra("equity-aapl-deep", "businessFramework");
    const sections = extra.sections as readonly Record<string, unknown>[];
    const parsed = readBusinessFrameworkExtra(extra);
    expect(parsed).toBeDefined();
    expect(parsed?.version).toBe(2);
    expect(parsed?.phase).toBe(extra.phase as string);
    expect(parsed?.sourceIds).toEqual(extra.sourceIds as readonly string[]);
    expect(parsed?.gaps).toEqual(extra.gaps as never);
    expect(parsed?.sections?.map((section) => section.name)).toEqual(
      sections.map((section) => section.name) as never,
    );
    expect(parsed?.sections?.map((section) => section.metrics.length)).toEqual(
      sections.map((section) => (section.metrics as readonly unknown[]).length),
    );
    expect(parsed?.sections?.map((section) => section.gaps)).toEqual(
      sections.map((section) => section.gaps) as never,
    );
  });

  test("keeps the reconciliation block when present", async () => {
    const extra = await goldenExtra("equity-web-fallback-deep", "businessFramework");
    expect(readBusinessFrameworkExtra(extra)?.reconciliation).toEqual(
      extra.reconciliation as never,
    );
  });

  // Entry: a record is enough. Version and phase are not identity requirements.
  test("parses a framework with no version and an unrecognized phase", () => {
    const parsed = readBusinessFrameworkExtra({
      phase: "not-a-phase",
      sections: [{ name: "Moat", text: "Moat judgement.", sourceIds: ["src-1"] }],
    });
    expect(parsed?.version).toBeUndefined();
    expect(parsed?.phase).toBe("not-a-phase");
    expect(parsed?.sections).toHaveLength(1);
    expect(readBusinessFrameworkExtra({ sections: [] })?.phase).toBeUndefined();
    expect(readBusinessFrameworkExtra("nope")).toBeUndefined();
  });

  // A missing `sections` array is not the same as an empty one: the renderer
  // Omits the whole section for the former and emits a bare header for the latter.
  test("keeps an absent sections array distinguishable from an empty one", () => {
    expect(readBusinessFrameworkExtra({ version: 2, phase: "decline" })?.sections).toBeUndefined();
    expect(readBusinessFrameworkExtra({ sections: "nope" })?.sections).toBeUndefined();
    expect(readBusinessFrameworkExtra({ sections: [] })?.sections).toEqual([]);
  });

  // Section fields other than `name` are optional; posture and summary are
  // Artifact-only and the schema does not require them.
  test("keeps a section with only a name, and a text-only section", () => {
    const parsed = readBusinessFrameworkExtra({
      sections: [
        { name: "Moat", posture: "criteria-supported", text: "Moat.", sourceIds: ["src-1"] },
        { name: "Unit Economics", summary: "Unit economics." },
        { name: "Bare" },
        { name: 42 },
        "nope",
      ],
    });
    expect(parsed?.sections?.map((section) => section.name)).toEqual([
      "Moat",
      "Unit Economics",
      "Bare",
    ]);
    expect(parsed?.sections?.[0]?.summary).toBeUndefined();
    expect(parsed?.sections?.[1]?.text).toBeUndefined();
    expect(parsed?.sections?.[2]?.posture).toBeUndefined();
  });

  // The renderer needs a name, the source traversal does not. HEAD's traversal
  // Walked every record section, so dropping a nameless row here would quietly
  // Move its source into the "uncited" inventory line.
  test("keeps a nameless section so its sources stay cited", () => {
    const parsed = readBusinessFrameworkExtra({
      sections: [{ summary: "No name.", sourceIds: ["src-nameless"] }],
    });
    expect(parsed?.sections).toHaveLength(1);
    expect(parsed?.sections?.[0]?.name).toBeUndefined();
    expect(parsed?.sections?.[0]?.sourceIds).toEqual(["src-nameless"]);

    const markdown = renderMarkdownReport(
      researchReport({
        jobType: "crypto",
        sources: [
          {
            id: "src-nameless",
            title: "Nameless section source",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            kind: "web",
            assetClass: "equity",
          },
        ],
        extras: {
          businessFramework: {
            phase: "decline",
            sections: [
              { summary: "No name.", sourceIds: ["src-nameless"] },
              { name: "Moat", summary: "Moat.", sourceIds: [] },
            ],
          },
        },
      }),
    );
    expect(markdown).toContain("- **Moat**: Moat.");
    expect(markdown).not.toContain("No name.");
    // Cited, so it is listed rather than counted as an uncited omission.
    expect(markdown).toContain("- [src-nameless] Nameless section source");
    expect(markdown).not.toContain("uncited normalized source");
  });

  test("keeps an unrecognized posture verbatim", () => {
    const parsed = readBusinessFrameworkExtra({
      sections: [{ name: "Moat", posture: "nonsense", summary: "Moat." }],
    });
    expect(parsed?.sections?.[0]?.posture).toBe("nonsense");
  });

  // HEAD's markdown treated a mixed array as wholly malformed; HEAD's Console
  // Kept the valid entries. The reader keeps both facts so each consumer decides.
  test("keeps the valid entries of a mixed sourceIds array and flags it", async () => {
    const extra = await goldenExtra("equity-aapl-deep", "businessFramework");
    const parsed = readBusinessFrameworkExtra({
      ...extra,
      sourceIds: [...(extra.sourceIds as readonly string[]), 42],
      sections: withReplacedRow(extra, "sections", 0, {
        ...(extra.sections as readonly Record<string, unknown>[])[0],
        sourceIds: ["sec-1", 42],
      }).sections,
    });
    expect(parsed?.sourceIds).toEqual(extra.sourceIds as readonly string[]);
    expect(parsed?.sourceIdsComplete).toBe(false);
    expect(parsed?.sections?.[0]?.sourceIds).toEqual(["sec-1"]);
    expect(parsed?.sections?.[0]?.sourceIdsComplete).toBe(false);
    // A clean array is complete.
    expect(readBusinessFrameworkExtra({ sourceIds: ["a"] })?.sourceIdsComplete).toBe(true);
    expect(readBusinessFrameworkExtra({})?.sourceIdsComplete).toBe(true);
  });

  // The other half of the same rule: markdown must still cite nothing.
  test("cites nothing from a mixed sourceIds array in markdown", () => {
    const markdown = renderMarkdownReport(
      researchReport({
        jobType: "crypto",
        sources: [
          {
            id: "src-mixed",
            title: "Mixed array source",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            kind: "web",
            assetClass: "equity",
          },
        ],
        extras: {
          businessFramework: {
            phase: "decline",
            sourceIds: ["src-mixed", 7],
            sections: [{ name: "Moat", summary: "Moat.", sourceIds: ["src-mixed", 7] }],
          },
        },
      }),
    );
    expect(markdown).toContain("- **Moat**: Moat.");
    expect(markdown).not.toContain("[src-mixed]");
    expect(markdown).toContain("uncited normalized source");
  });

  test("keeps the text of a gap whose code is unrecognized", () => {
    const parsed = readBusinessFrameworkExtra({
      gaps: [
        { code: "not-a-code", text: "Segment mix is undisclosed" },
        { text: "No code" },
        "Bare string",
        { code: "segment-mix" },
      ],
    });
    expect(parsed?.gaps).toEqual([
      { text: "Segment mix is undisclosed" },
      { text: "No code" },
      "Bare string",
    ]);
  });
});

describe("web subject profile extra", () => {
  test("round-trips the equity-web-fallback-deep golden payload", async () => {
    const extra = await goldenExtra("equity-web-fallback-deep", "webSubjectProfile");
    const questions = extra.questions as Record<string, unknown>;
    const parsed = readWebSubjectProfileExtra(extra);
    expect(parsed).toBeDefined();
    expect(parsed?.version).toBe(3);
    expect(parsed?.subjectKind).toBe("company");
    expect(parsed?.subjectId).toBe(extra.subjectId as string);
    expect(parsed?.symbol).toBe(extra.symbol as string);
    expect(parsed?.companyName).toBe(extra.companyName as string);
    expect(parsed?.subjectSummary).toEqual({
      ...(extra.subjectSummary as object),
      sourceIdsComplete: true,
    } as never);
    expect(Object.keys(parsed?.questions ?? {})).toEqual(Object.keys(questions));
    expect(parsed?.questions).toEqual(
      Object.fromEntries(
        Object.entries(questions).map(([key, answer]) => [
          key,
          { ...(answer as object), sourceIdsComplete: true },
        ]),
      ) as never,
    );
    expect(parsed?.recentMaterialEvents).toEqual(
      (extra.recentMaterialEvents as readonly object[]).map((fact) => ({
        ...fact,
        sourceIdsComplete: true,
      })) as never,
    );
    expect(parsed?.factLedger).toEqual(
      (extra.factLedger as readonly object[]).map((fact) => ({
        ...fact,
        sourceIdsComplete: true,
      })) as never,
    );
    expect(parsed?.openGaps).toEqual(extra.openGaps as readonly string[]);
    expect(parsed?.sourceIds).toEqual(extra.sourceIds as readonly string[]);
  });

  // Entry: a record is enough. Version, kind and id are not identity requirements.
  test("parses a profile with no version, kind or subject id", () => {
    const parsed = readWebSubjectProfileExtra({
      questions: { whatItDoes: { answer: "Sells devices.", sourceIds: ["src-1"] } },
    });
    expect(parsed?.version).toBeUndefined();
    expect(parsed?.subjectKind).toBeUndefined();
    expect(parsed?.subjectId).toBeUndefined();
    expect(parsed?.questions?.whatItDoes?.answer).toBe("Sells devices.");
    expect(readWebSubjectProfileExtra("nope")).toBeUndefined();
  });

  test("keeps an unrecognized subject kind verbatim", () => {
    expect(readWebSubjectProfileExtra({ subjectKind: "issuer" })?.subjectKind).toBe("issuer");
  });

  // Mirrors the framework case: absent questions omit the profile section, an
  // Empty record does not.
  test("keeps an absent questions record distinguishable from an empty one", () => {
    expect(readWebSubjectProfileExtra({ version: 3 })?.questions).toBeUndefined();
    expect(readWebSubjectProfileExtra({ questions: "nope" })?.questions).toBeUndefined();
    expect(readWebSubjectProfileExtra({ questions: {} })?.questions).toEqual({});
  });

  // The source traversal cites a row whose text is empty, blank or missing, so
  // The row survives parsing and only the renderer suppresses it.
  test("keeps rows whose answer or claim is empty, blank or missing", async () => {
    const extra = await goldenExtra("equity-web-fallback-deep", "webSubjectProfile");
    const parsed = readWebSubjectProfileExtra({
      ...extra,
      questions: {
        customers: { answer: "", sourceIds: ["web-aapl-6c345d05"] },
        geography: { answer: " ", sourceIds: ["web-aapl-6c345d05"] },
        pricingPower: { sourceIds: ["web-aapl-6c345d05"] },
        riskFactors: { answer: 42, sourceIds: ["web-aapl-6c345d05"] },
      },
      recentMaterialEvents: [
        { claim: "", sourceIds: ["web-aapl-6c345d05"] },
        { sourceIds: ["web-aapl-6c345d05"] },
        { claim: 42, sourceIds: ["web-aapl-6c345d05"] },
        "nope",
      ],
    });
    expect(parsed?.questions?.customers).toEqual({
      answer: "",
      sourceIds: ["web-aapl-6c345d05"],
      sourceIdsComplete: true,
    });
    expect(parsed?.questions?.geography?.answer).toBe(" ");
    expect(parsed?.questions?.pricingPower?.answer).toBeUndefined();
    expect(parsed?.questions?.pricingPower?.sourceIds).toEqual(["web-aapl-6c345d05"]);
    expect(parsed?.questions?.riskFactors?.answer).toBeUndefined();
    expect(parsed?.recentMaterialEvents).toHaveLength(3);
    expect(parsed?.recentMaterialEvents.map((event) => event.claim)).toEqual([
      "",
      undefined,
      undefined,
    ]);
    expect(parsed?.recentMaterialEvents.every((event) => event.sourceIds.length === 1)).toBe(true);
  });

  test("keeps a question key outside the subject kind's order", async () => {
    const extra = await goldenExtra("equity-web-fallback-deep", "webSubjectProfile");
    const questions = extra.questions as Record<string, unknown>;
    const extraAnswer = { answer: "Legacy answer.", sourceIds: ["web-aapl-6c345d05"] };
    const parsed = readWebSubjectProfileExtra({
      ...extra,
      questions: { ...questions, legacyQuestion: extraAnswer },
    });
    expect(parsed?.questions?.legacyQuestion).toEqual({ ...extraAnswer, sourceIdsComplete: true });
  });

  test("keeps the valid entries of a mixed openGaps or sourceIds array and flags it", async () => {
    const extra = await goldenExtra("equity-web-fallback-deep", "webSubjectProfile");
    const parsed = readWebSubjectProfileExtra({
      ...extra,
      openGaps: ["Segment mix is undisclosed", 42],
      sourceIds: [...(extra.sourceIds as readonly string[]), 42],
      questions: { customers: { answer: "Retail.", sourceIds: ["web-aapl-6c345d05", 42] } },
      factLedger: [{ claim: "Fact.", sourceIds: ["web-aapl-6c345d05", 42] }],
    });
    expect(parsed?.openGaps).toEqual(["Segment mix is undisclosed"]);
    expect(parsed?.openGapsComplete).toBe(false);
    expect(parsed?.sourceIds).toEqual(extra.sourceIds as readonly string[]);
    expect(parsed?.sourceIdsComplete).toBe(false);
    expect(parsed?.questions?.customers?.sourceIds).toEqual(["web-aapl-6c345d05"]);
    expect(parsed?.questions?.customers?.sourceIdsComplete).toBe(false);
    expect(parsed?.factLedger[0]?.sourceIdsComplete).toBe(false);
  });

  test("cites nothing and renders no gaps from mixed profile arrays in markdown", () => {
    const markdown = renderMarkdownReport(
      researchReport({
        jobType: "research",
        sources: [
          {
            id: "web-mixed",
            title: "Mixed profile source",
            fetchedAt: "2026-05-19T00:00:00.000Z",
            kind: "web",
            assetClass: "equity",
          },
        ],
        extras: {
          webSubjectProfile: {
            subjectKind: "company",
            questions: { whatItDoes: { answer: "Sells devices.", sourceIds: ["web-mixed", 7] } },
            factLedger: [{ claim: "A fact.", sourceIds: ["web-mixed", 7] }],
            openGaps: ["A gap", 7],
          },
        },
      }),
    );
    expect(markdown).toContain("**What It Does:** Sells devices.");
    expect(markdown).toContain("- A fact.");
    expect(markdown).not.toContain("[web-mixed]");
    // Mixed openGaps means HEAD rendered no Profile Gaps section at all.
    expect(markdown).not.toContain("### Profile Gaps");
    expect(markdown).not.toContain("- A gap");
  });

  test("keeps an empty subject summary without rendering a blank paragraph", async () => {
    const extra = await goldenExtra("equity-web-fallback-deep", "webSubjectProfile");
    const emptyProfile = {
      ...extra,
      questions: {},
      recentMaterialEvents: [],
      factLedger: [],
      openGaps: ["Web evidence is unavailable"],
    };
    const emptySummary = { answer: "", sourceIds: [], sourceIdsComplete: true };
    expect(
      readWebSubjectProfileExtra({ ...emptyProfile, subjectSummary: { answer: "", sourceIds: [] } })
        ?.subjectSummary,
    ).toEqual(emptySummary);
    expect(
      readWebSubjectProfileExtra({ ...emptyProfile, subjectSummary: { answer: "" } })
        ?.subjectSummary,
    ).toEqual(emptySummary);
    expect(
      readWebSubjectProfileExtra({ ...emptyProfile, subjectSummary: { answer: "", sourceIds: 42 } })
        ?.subjectSummary,
    ).toEqual(emptySummary);
    const markdown = renderMarkdownReport(
      researchReport({
        jobType: "research",
        extras: {
          webSubjectProfile: {
            ...emptyProfile,
            subjectSummary: { answer: "", sourceIds: [] },
            questions: { whatItDoes: { answer: "Sells devices.", sourceIds: [] } },
          },
        },
      }),
    );
    expect(markdown).toContain("## Web Subject Profile\n\n- **What It Does:** Sells devices.");
  });

  test("accepts only the exact empty-answer sentinel in artifact leaves", () => {
    expect(readWebSubjectProfileAnswer({ answer: " ", sourceIds: [] })).toBeUndefined();
    expect(readWebSubjectProfileAnswer({ answer: "", sourceIds: ["web-source"] })).toBeUndefined();
    expect(readWebSubjectProfileAnswer({ answer: "", sourceIds: [] })).toEqual({
      answer: "",
      sourceIds: [],
    });
    expect(readWebSubjectProfileAnswer({ answer: "Real." })).toBeUndefined();
    expect(readWebSubjectProfileAnswer({ answer: "Real.", sourceIds: [] })).toEqual({
      answer: "Real.",
      sourceIds: [],
    });
  });

  test("drops uncited facts but rejects malformed facts", () => {
    expect(
      readWebSubjectProfileFacts([
        { claim: "Cited.", sourceIds: ["web-source"] },
        { claim: "Uncited.", sourceIds: [] },
      ]),
    ).toEqual([{ claim: "Cited.", sourceIds: ["web-source"] }]);
    expect(readWebSubjectProfileFacts([{ claim: "Uncited.", sourceIds: [] }])).toEqual([]);
    expect(readWebSubjectProfileFacts([{ claim: " ", sourceIds: [] }])).toBeUndefined();
  });
});

describe("web subject profile question keys", () => {
  test("falls back to the company key order for an unknown subject kind", () => {
    expect(webSubjectProfileQuestionKeys("theme")).toContain("whyNow");
    expect(webSubjectProfileQuestionKeys("crypto-asset")).toContain("valueAccrual");
    expect(webSubjectProfileQuestionKeys("mystery")).toEqual(
      webSubjectProfileQuestionKeys("company"),
    );
  });
});
