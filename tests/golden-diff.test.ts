import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import {
  diffGolden,
  formatGoldenDiff,
  GOLDEN_ARRAY_IDENTITIES,
  identityFor,
  parseGoldenReplayArgs,
  reviewFixtureGolden,
  reviewGolden,
  type GoldenArrayIdentityStrategy,
} from "./support/run-fixtures/golden-diff";
import { readGoldenOutput, type JsonValue } from "./support/run-fixtures/artifacts";
import { runFixture } from "./support/run-fixtures";

function statementFact(year: number, value: number): JsonValue {
  return {
    periodKey: `${String(year)}-01-01|${String(year)}-12-31`,
    concept: "Revenue",
    value,
    currency: "USD",
  };
}

function statementGolden(facts: readonly JsonValue[]): JsonValue {
  return {
    normalized: {
      "financial-statements.json": {
        financialStatements: {
          statements: { incomeStatement: { revenue: { annual: facts } } },
        },
      },
    },
  };
}

function financialStatementsWithGaps(structuredFinancialGaps: readonly JsonValue[]): JsonValue {
  return {
    normalized: {
      "evidence-bundle.json": {
        derived: { financialStatements: { structuredFinancialGaps } },
      },
    },
  };
}

function validationNotesGolden(validationNotes: readonly JsonValue[]): JsonValue {
  return { artifact: { validationNotes } };
}

function identityCensus(
  fixtureName: string,
  golden: JsonValue,
): {
  readonly duplicateBearingArrays: readonly string[];
  readonly missingIdentityCount: number;
} {
  const duplicateBearingArrays = new Set<string>();
  let missingIdentityCount = 0;

  function walk(value: JsonValue, path: string): void {
    if (Array.isArray(value)) {
      const rule = GOLDEN_ARRAY_IDENTITIES.find((candidate) => candidate.path.test(path));
      if (rule !== undefined) {
        const identities = value.map((item) => identityFor(rule.strategy, item));
        missingIdentityCount += identities.filter((identity) => identity === undefined).length;
        if (identities.every((identity): identity is string => identity !== undefined)) {
          const counts = new Map<string, number>();
          for (const identity of identities) {
            counts.set(identity, (counts.get(identity) ?? 0) + 1);
          }
          if ([...counts.values()].some((count) => count > 1)) {
            duplicateBearingArrays.add(`${fixtureName}:${path}`);
          }
          const occurrences = new Map<string, number>();
          value.forEach((item, index) => {
            const identity = identities[index]!;
            const occurrence = occurrences.get(identity) ?? 0;
            occurrences.set(identity, occurrence + 1);
            const suffix = occurrence === 0 ? "" : `#${String(occurrence + 1)}`;
            walk(item, `${path}[${rule.label}=${JSON.stringify(identity)}${suffix}]`);
          });
          return;
        }
      }
      value.forEach((item, index) => walk(item, `${path}[${String(index)}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        walk(item, path === "" ? key : `${path}.${key}`);
      }
    }
  }

  walk(golden, "");
  return {
    duplicateBearingArrays: [...duplicateBearingArrays].toSorted(),
    missingIdentityCount,
  };
}

describe("golden diff negative controls", () => {
  test("always escalates a numeric sign flip", () => {
    const diff = diffGolden({ metric: { value: 12 } }, { metric: { value: -12 } });

    expect(diff.summary).toEqual({ changed: 1, added: 0, removed: 0 });
    expect(diff.counts["changed-value"]).toBe(1);
    expect(diff.escalated).toHaveLength(1);
    expect(diff.escalated[0]?.escalationReasons).toContain("numeric sign flip");
  });

  test("identity-matches a statement insertion without shifting 200 successors", () => {
    const facts = Array.from({ length: 200 }, (_, index) => statementFact(1800 + index, index));
    const diff = diffGolden(
      statementGolden(facts),
      statementGolden([statementFact(1799, 1), ...facts]),
    );

    expect(diff.summary).toEqual({ changed: 0, added: 1, removed: 0 });
    expect(diff.counts["added-entry"]).toBe(1);
    expect(diff.counts["changed-value"]).toBe(0);
    expect(diff.escalated).toEqual([]);
    expect(diff.positionalFallbacks).toEqual([]);
  });

  test("always escalates a removed validation note", () => {
    const retained = { code: "retained", periodKey: "2025", message: "Still applies" };
    const removed = { code: "missing-history", periodKey: "2024", message: "History missing" };
    const before = { artifact: { validationNotes: [removed, retained] } };
    const after = { artifact: { validationNotes: [retained] } };
    const diff = diffGolden(before, after);

    expect(diff.summary).toEqual({ changed: 0, added: 0, removed: 1 });
    expect(diff.counts["removed-entry"]).toBe(1);
    expect(diff.escalated).toHaveLength(1);
    expect(diff.escalated[0]?.escalationReasons).toContain("warning or data gap removed");
  });

  test("buckets a prose-only edit without escalating it", () => {
    const diff = diffGolden(
      { report: { summary: "Revenue expanded." } },
      { report: { summary: "Revenue contracted." } },
    );

    expect(diff.summary).toEqual({ changed: 1, added: 0, removed: 0 });
    expect(diff.counts.prose).toBe(1);
    expect(diff.escalated).toEqual([]);
  });

  test("always escalates a value type change", () => {
    const diff = diffGolden({ metric: { value: 100 } }, { metric: { value: null } });

    expect(diff.escalated).toHaveLength(1);
    expect(diff.escalated[0]?.escalationReasons).toContain(
      "value type changed from number to null",
    );
  });

  test("always escalates a removed history note", () => {
    const removed = "cagr:non-positive-endpoint: both annual endpoints must be greater than zero";
    const before = {
      normalized: {
        bundle: {
          fundamentalHistory: { series: { dilutedEps: { notes: [removed, "retained"] } } },
        },
      },
    };
    const after = {
      normalized: {
        bundle: { fundamentalHistory: { series: { dilutedEps: { notes: ["retained"] } } } },
      },
    };
    const diff = diffGolden(before, after);

    expect(diff.summary).toEqual({ changed: 0, added: 0, removed: 1 });
    expect(diff.escalated).toHaveLength(1);
    expect(diff.escalated[0]?.escalationReasons).toContain("warning or data gap removed");
  });

  test("identity-matches a structured financial gap insertion by stable code", () => {
    const retained = {
      code: "untagged-6-k",
      message: "Untagged filing evidence remains",
      forms: ["6-K"],
      sourceIds: ["filing-source"],
    };
    const inserted = {
      code: "no-standard-taxonomy",
      message: "No supported standard taxonomy",
      forms: [],
      sourceIds: ["facts-source"],
    };
    const diff = diffGolden(
      financialStatementsWithGaps([retained]),
      financialStatementsWithGaps([inserted, retained]),
    );

    expect(diff.summary).toEqual({ changed: 0, added: 1, removed: 0 });
    expect(diff.positionalFallbacks).toEqual([]);
    expect(diff.findings[0]?.path).toContain(
      'structuredFinancialGaps[structured financial gaps="no-standard-taxonomy"]',
    );
  });

  test("identity-matches a validation note insertion by series", () => {
    const notes = [
      { code: "unreconciled-ttm", message: "Revenue", seriesKey: "revenue" },
      { code: "unreconciled-ttm", message: "Operating income", seriesKey: "operatingIncome" },
      { code: "unreconciled-ttm", message: "Net income", seriesKey: "netIncome" },
    ];
    const inserted = {
      code: "unreconciled-ttm",
      message: "Gross profit",
      seriesKey: "grossProfit",
    };
    const diff = diffGolden(
      validationNotesGolden(notes),
      validationNotesGolden([inserted, ...notes]),
    );

    expect(diff.summary).toEqual({ changed: 0, added: 1, removed: 0 });
  });

  test("identity-matches a run stage insertion by attempt", () => {
    const stages = [
      { stage: "final-synthesis", attempt: 1 },
      { stage: "final-synthesis", attempt: 2 },
    ];
    const inserted = { stage: "final-synthesis", attempt: 3 };
    const diff = diffGolden(
      { analytics: { runShape: { stages } } },
      { analytics: { runShape: { stages: [inserted, ...stages] } } },
    );

    expect(diff.summary).toEqual({ changed: 0, added: 1, removed: 0 });
  });

  test("detects a validation note reorder within a shared code", () => {
    const first = { code: "mixed-currencies", message: "Revenue", seriesKey: "revenue" };
    const second = {
      code: "mixed-currencies",
      message: "Operating income",
      seriesKey: "operatingIncome",
    };
    const diff = diffGolden(
      validationNotesGolden([first, second]),
      validationNotesGolden([second, first]),
    );

    expect(diff.reorderedArrays).toEqual(["artifact.validationNotes"]);
  });

  test("reports positional matching within a repeated validation-note identity", () => {
    const periodKey = "annual|2016-01-01|2016-12-31";
    const before = [
      { code: "incomplete-statement", periodKey, message: "incomeStatement is incomplete" },
      { code: "incomplete-statement", periodKey, message: "cashFlowStatement is incomplete" },
    ];
    const after = [
      before[0]!,
      { code: "incomplete-statement", periodKey, message: "cashFlowStatement remains incomplete" },
    ];
    const diff = diffGolden(validationNotesGolden(before), validationNotesGolden(after));

    expect(diff.positionalFallbacks).toEqual([
      'artifact.validationNotes (positional matching used within a repeated identity: validation notes rule matched, but identity "incomplete-statement|annual|2016-01-01|2016-12-31|" occurs 2 times before / 2 times after; occurrence order decides the match - strengthen this identity rule with a stable discriminator, or verify ambiguous ordering is intentional)',
    ]);
  });

  test("reports a repeated identity created only after the change", () => {
    const periodKey = "annual|2016-01-01|2016-12-31";
    const retained = {
      code: "incomplete-statement",
      periodKey,
      message: "incomeStatement is incomplete",
    };
    const inserted = {
      code: "incomplete-statement",
      periodKey,
      message: "cashFlowStatement is incomplete",
    };
    const diff = diffGolden(
      validationNotesGolden([retained]),
      validationNotesGolden([retained, inserted]),
    );

    expect(diff.positionalFallbacks).toEqual([
      'artifact.validationNotes (positional matching used within a repeated identity: validation notes rule matched, but identity "incomplete-statement|annual|2016-01-01|2016-12-31|" occurs 1 time before / 2 times after; occurrence order decides the match - strengthen this identity rule with a stable discriminator, or verify ambiguous ordering is intentional)',
    ]);
  });

  test("reports a repeated identity present only before the change", () => {
    const periodKey = "annual|2016-01-01|2016-12-31";
    const retained = {
      code: "incomplete-statement",
      periodKey,
      message: "incomeStatement is incomplete",
    };
    const removed = {
      code: "incomplete-statement",
      periodKey,
      message: "cashFlowStatement is incomplete",
    };
    const diff = diffGolden(
      validationNotesGolden([retained, removed]),
      validationNotesGolden([retained]),
    );

    expect(diff.summary).toEqual({ changed: 0, added: 0, removed: 1 });
    expect(diff.positionalFallbacks).toEqual([
      'artifact.validationNotes (positional matching used within a repeated identity: validation notes rule matched, but identity "incomplete-statement|annual|2016-01-01|2016-12-31|" occurs 2 times before / 1 time after; occurrence order decides the match - strengthen this identity rule with a stable discriminator, or verify ambiguous ordering is intentional)',
    ]);
  });
});

test("pins duplicate-bearing identities across every golden", async () => {
  const fixtureEntries = await readdir(new URL("fixtures/runs/", import.meta.url), {
    withFileTypes: true,
  });
  const goldenFixtures = fixtureEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
  const census = await Promise.all(
    goldenFixtures.map(async (fixtureName) =>
      identityCensus(fixtureName, await readGoldenOutput(fixtureName)),
    ),
  );
  const actual = {
    duplicateBearingArrays: census.flatMap((entry) => entry.duplicateBearingArrays).toSorted(),
    missingIdentityCount: census.reduce((total, entry) => total + entry.missingIdentityCount, 0),
  };

  expect(actual).toEqual({
    duplicateBearingArrays: [
      "equity-earnings-release-deep:normalized.evidence-bundle.json.derived.financialStatements.validationNotes",
      "equity-nbis-deep:normalized.evidence-bundle.json.derived.financialStatements.validationNotes",
    ],
    missingIdentityCount: 0,
  });
});

describe("golden diff reporting", () => {
  test("parses replay modes with check as the default", () => {
    expect(parseGoldenReplayArgs(["equity-aapl-brief"])).toEqual({
      fixtureName: "equity-aapl-brief",
      mode: "check",
    });
    expect(parseGoldenReplayArgs(["equity-aapl-brief", "--check-golden"]).mode).toBe("check");
    expect(parseGoldenReplayArgs(["equity-aapl-brief", "--keep"]).mode).toBe("keep");
    expect(parseGoldenReplayArgs(["equity-aapl-brief", "--live"]).mode).toBe("live");
    expect(parseGoldenReplayArgs(["equity-aapl-brief", "--write-golden"]).mode).toBe("write");
    expect(() => parseGoldenReplayArgs(["equity-aapl-brief", "--unknown"])).toThrow("Usage:");
    expect(() => parseGoldenReplayArgs(["equity-aapl-brief", "--live", "--write-golden"])).toThrow(
      "Usage:",
    );
  });

  test("line-matches markdown insertions without shifting successors", () => {
    const diff = diffGolden(
      { markdown: "# Report\nStable line\nLast line\n" },
      { markdown: "# Report\nStable line\nAdded one\nAdded two\nLast line\n" },
    );

    expect(diff.summary).toEqual({ changed: 0, added: 2, removed: 0 });
    expect(diff.counts.prose).toBe(2);
    expect(diff.findings.map((finding) => finding.path)).toEqual([
      "markdown[after-line=3]",
      "markdown[after-line=4]",
    ]);
    expect(diff.findings.map((finding) => finding.after)).toEqual(["Added one", "Added two"]);

    const removal = diffGolden(
      { markdown: "# Report\nRemove me\nLast line\n" },
      { markdown: "# Report\nLast line\n" },
    );
    expect(removal.summary).toEqual({ changed: 0, added: 0, removed: 1 });
    expect(removal.findings[0]?.path).toBe("markdown[before-line=2]");
  });

  test("reports relative deltas, path-sensitive fields, exact scrub noise, and fallback", () => {
    const before = {
      cagr: { years: 4, value: 1 },
      runId: "run-before",
      analytics: {
        runShape: {
          durationMs: 0,
          stages: [{ stage: "collect", attempt: 1, durationMs: 1 }],
        },
      },
      unknown: [{ value: 1 }, { value: 2 }],
    };
    const after = {
      cagr: { years: 5, value: 2 },
      runId: "run-after",
      analytics: {
        runShape: {
          durationMs: 1,
          stages: [{ stage: "collect", attempt: 1, durationMs: 2 }],
        },
      },
      unknown: [{ value: 2 }, { value: 3 }],
    };
    const diff = diffGolden(before, after);

    expect(diff.counts["scrub-noise"]).toBe(2);
    expect(
      diff.findings.find((finding) => finding.path === "analytics.runShape.durationMs")?.bucket,
    ).toBe("changed-value");
    expect(diff.positionalFallbacks).toEqual([
      "unknown (positional matching used: no identity rule matched this array path)",
    ]);
    expect(
      diff.escalated.some((finding) =>
        finding.escalationReasons.includes("numeric relative delta exceeds 25%"),
      ),
    ).toBe(true);
    expect(formatGoldenDiff(diff, { topN: 0 })).toContain(
      "action: add a stable identity rule, or verify positional matching is intentional",
    );
  });

  test("registers every stable identity strategy and reports identity-preserving reorder", () => {
    const before = {
      report: {
        sources: [
          { id: "source-a", title: "A" },
          { id: "source-b", title: "B" },
        ],
        predictions: [
          { measurableAs: "price(AAPL, 2027-01-01) > 1", probability: 0.6 },
          { id: "prediction-2", measurableAs: "price(AAPL, 2027-02-01) > 1", probability: 0.5 },
        ],
        keyFindings: [{ text: "Finding", importance: 1 }],
        dataGaps: ["Gap A"],
      },
      analytics: { runShape: { stages: [{ stage: "collect", attempt: 1 }] } },
      normalized: {
        bundle: {
          financialLenses: {
            lenses: [
              {
                name: "Quality",
                posture: "mixed",
                metrics: [{ key: "roe", value: 1 }],
              },
            ],
          },
          fundamentalHistory: { series: { revenue: { notes: ["Note A"] } } },
          valuationWorkbench: {
            historicalMultiples: {
              observations: [
                {
                  basis: "ANNUAL",
                  periodStart: "2024-01-01",
                  periodEnd: "2024-12-31",
                  price: 10,
                },
              ],
            },
          },
        },
      },
    };
    const after = {
      report: {
        sources: [
          { id: "source-b", title: "B" },
          { id: "source-a", title: "A" },
        ],
        predictions: [
          { measurableAs: "price(AAPL, 2027-01-01) > 1", probability: 0.7 },
          { id: "prediction-2", measurableAs: "price(AAPL, 2027-02-01) > 1", probability: 0.6 },
        ],
        keyFindings: [{ text: "Finding", importance: 2 }],
        dataGaps: ["Gap A", "Gap B"],
      },
      analytics: { runShape: { stages: [{ stage: "collect", attempt: 2 }] } },
      normalized: {
        bundle: {
          financialLenses: {
            lenses: [
              {
                name: "Quality",
                posture: "supported",
                metrics: [{ key: "roe", value: 2 }],
              },
            ],
          },
          fundamentalHistory: { series: { revenue: { notes: ["Note A", "Note B"] } } },
          valuationWorkbench: {
            historicalMultiples: {
              observations: [
                {
                  basis: "ANNUAL",
                  periodStart: "2024-01-01",
                  periodEnd: "2024-12-31",
                  price: 11,
                },
              ],
            },
          },
        },
      },
    };
    const review = reviewGolden(before, after);

    expect(review.equal).toBe(false);
    expect(review.diff.summary).toEqual({ changed: 6, added: 3, removed: 1 });
    expect(review.diff.reorderedArrays).toEqual(["report.sources"]);
    expect(review.diff.positionalFallbacks).toEqual([]);
    expect(formatGoldenDiff(review.diff)).toContain("Identity-matched array order changes");
    const expectedStrategies: Record<GoldenArrayIdentityStrategy, true> = {
      code: true,
      "code-period-series": true,
      id: true,
      "key-name": true,
      period: true,
      prediction: true,
      stage: true,
      string: true,
      text: true,
    };
    expect(new Set(GOLDEN_ARRAY_IDENTITIES.map((rule) => rule.strategy))).toEqual(
      new Set(Object.keys(expectedStrategies) as GoldenArrayIdentityStrategy[]),
    );
  });

  test("prints every escalated finding while applying top-n to prose and other findings", () => {
    const diff = diffGolden(
      { values: [1, 2, 3], report: { summary: "before" } },
      { values: [1, 4, 6], report: { summary: "after" } },
    );
    const formatted = formatGoldenDiff(diff, { topN: 1 });

    expect(formatted).toContain("Golden diff: 3 changed / 0 added / 0 removed");
    expect(formatted.match(/numeric relative delta exceeds 25%/gu)).toHaveLength(2);
    expect(formatted).toContain("Other findings (top 1 of 1)");
    expect(formatted).toContain("[prose] report.summary");
  });

  test("falls back loudly for unusable identities and covers positional and object add/remove", () => {
    const unusableIdentity = diffGolden(
      { report: { dataGaps: [{ code: "before" }] } },
      { report: { dataGaps: [{ code: "after" }] } },
    );
    const additions = diffGolden(
      { unknown: [{ value: 1 }], object: { removed: true } },
      { unknown: [{ value: 1 }, { value: 2 }], object: { added: true } },
    );
    const removal = diffGolden(
      { unknown: [{ value: 1 }, { value: 2 }] },
      { unknown: [{ value: 1 }] },
    );
    const nonRecordIdentity = diffGolden(
      { report: { sources: ["before"] } },
      { report: { sources: ["after"] } },
    );
    const missingPeriodIdentity = diffGolden(
      {
        normalized: {
          bundle: {
            valuationWorkbench: { historicalMultiples: { observations: [{ price: 1 }] } },
          },
        },
      },
      {
        normalized: {
          bundle: {
            valuationWorkbench: { historicalMultiples: { observations: [{ price: 2 }] } },
          },
        },
      },
    );

    expect(unusableIdentity.positionalFallbacks).toEqual([
      "report.dataGaps (positional matching used: data gaps rule matched, but at least one item lacked its identity)",
    ]);
    expect(additions.summary).toEqual({ changed: 0, added: 2, removed: 1 });
    expect(removal.summary).toEqual({ changed: 0, added: 0, removed: 1 });
    expect(nonRecordIdentity.positionalFallbacks).toEqual([
      "report.sources (positional matching used: report sources rule matched, but at least one item lacked its identity)",
    ]);
    expect(missingPeriodIdentity.positionalFallbacks).toEqual([
      "normalized.bundle.valuationWorkbench.historicalMultiples.observations (positional matching used: valuation observations rule matched, but at least one item lacked its identity)",
    ]);
  });

  test("reviews scrubbed fixture artifacts against their golden", async () => {
    const result = await runFixture("equity-aapl-brief", { llm: "replay" });
    try {
      const review = await reviewFixtureGolden(result.artifacts.runDir, "equity-aapl-brief");

      expect(review.equal).toBe(true);
      expect(review.diff.findings).toEqual([]);
    } finally {
      await result.cleanup();
    }
  });

  test("reports no changes for equal goldens", () => {
    const review = reviewGolden({ report: { dataGaps: [] } }, { report: { dataGaps: [] } });

    expect(review.equal).toBe(true);
    expect(review.diff.findings).toEqual([]);
    expect(formatGoldenDiff(review.diff)).toContain("No value changes detected.");
  });
});
