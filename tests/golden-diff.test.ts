import { describe, expect, test } from "bun:test";
import {
  diffGolden,
  formatGoldenDiff,
  GOLDEN_ARRAY_IDENTITIES,
  parseGoldenReplayArgs,
  reviewFixtureGolden,
  reviewGolden,
} from "./support/run-fixtures/golden-diff";
import type { JsonValue } from "./support/run-fixtures/artifacts";
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
          stages: [{ stage: "collect", durationMs: 1 }],
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
          stages: [{ stage: "collect", durationMs: 2 }],
        },
      },
      unknown: [{ value: 2 }, { value: 3 }],
    };
    const diff = diffGolden(before, after);

    expect(diff.counts["scrub-noise"]).toBe(2);
    expect(
      diff.findings.find((finding) => finding.path === "analytics.runShape.durationMs")?.bucket,
    ).toBe("changed-value");
    expect(diff.positionalFallbacks).toEqual(["unknown (no stable identity rule)"]);
    expect(
      diff.escalated.some((finding) =>
        finding.escalationReasons.includes("numeric relative delta exceeds 25%"),
      ),
    ).toBe(true);
    expect(formatGoldenDiff(diff, { topN: 0 })).toContain("Positional array fallbacks");
  });

  test("exercises every stable identity strategy and reports identity-preserving reorder", () => {
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
      analytics: { runShape: { stages: [{ stage: "collect", attempts: 1 }] } },
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
      analytics: { runShape: { stages: [{ stage: "collect", attempts: 2 }] } },
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
    expect(review.diff.summary).toEqual({ changed: 7, added: 2, removed: 0 });
    expect(review.diff.reorderedArrays).toEqual(["report.sources"]);
    expect(review.diff.positionalFallbacks).toEqual([]);
    expect(formatGoldenDiff(review.diff)).toContain("Identity-matched array order changes");
    expect(GOLDEN_ARRAY_IDENTITIES.map((rule) => rule.label)).toContain("run stages");
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
      "report.dataGaps (data gaps identity missing)",
    ]);
    expect(additions.summary).toEqual({ changed: 0, added: 2, removed: 1 });
    expect(removal.summary).toEqual({ changed: 0, added: 0, removed: 1 });
    expect(nonRecordIdentity.positionalFallbacks).toEqual([
      "report.sources (report sources identity missing)",
    ]);
    expect(missingPeriodIdentity.positionalFallbacks).toEqual([
      "normalized.bundle.valuationWorkbench.historicalMultiples.observations (valuation observations identity missing)",
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
