import { describe, expect, test } from "bun:test";
import type { RunSummary } from "../app/types";
import {
  compareRunSummariesByRecency,
  runSearchResultFromIndexRow,
  runSummaryMatchesFilters,
  searchSnippet,
} from "../src/run-artifact-projection";
import type { SearchEntryRow } from "../src/run-artifact-index-types";

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-a",
    generatedAt: "2026-06-01T00:00:00.000Z",
    jobType: "ticker",
    assetClass: "equity",
    symbol: "AAPL",
    findingCount: 0,
    predictionCount: 0,
    sourceCount: 0,
    dataGapCount: 0,
    hasScore: false,
    availableFiles: [],
    ...overrides,
  };
}

describe("run artifact projection", () => {
  test("snippets fall back to the leading text when the query is absent", () => {
    const text = `${"a".repeat(150)} tail`;

    expect(searchSnippet(text, "missing")).toBe("a".repeat(144));
  });

  test("snippets include ellipses when the match is inside long surrounding text", () => {
    const text = `${"a".repeat(80)}needle${"b".repeat(80)}`;

    expect(searchSnippet(text, "needle")).toBe(`...${"a".repeat(72)}needle${"b".repeat(72)}...`);
  });

  test("filters summaries by normalized metadata and generated date bounds", () => {
    const run = summary();
    const { generatedAt: _generatedAt, ...runWithoutGeneratedAt } = run;

    expect(
      runSummaryMatchesFilters(run, {
        symbol: "aapl",
        assetClass: "EQUITY",
        jobType: "ticker",
        from: "2026-06-01",
        to: "2026-06-01",
      }),
    ).toBe(true);
    expect(runSummaryMatchesFilters(run, { from: "2026-06-02" })).toBe(false);
    expect(runSummaryMatchesFilters(runWithoutGeneratedAt, { to: "2026-06-01" })).toBe(false);
  });

  test("sorts summaries by recency and uses run id as the deterministic tie-breaker", () => {
    const ordered = [
      summary({ runId: "run-b", generatedAt: "2026-06-01T00:00:00.000Z" }),
      summary({ runId: "run-c", generatedAt: "2026-06-02T00:00:00.000Z" }),
      summary({ runId: "run-a", generatedAt: "2026-06-01T00:00:00.000Z" }),
    ].toSorted(compareRunSummariesByRecency);

    expect(ordered.map((run) => run.runId)).toEqual(["run-c", "run-b", "run-a"]);
  });

  test("projects indexed search rows with parsed source ids", () => {
    const row: SearchEntryRow = {
      entry_key: "run-a:summary:0",
      scope: "console",
      id: "summary:0",
      run_id: "run-a",
      generated_at: "2026-06-01T00:00:00.000Z",
      job_type: "ticker",
      asset_class: "equity",
      symbol: "AAPL",
      section: "summary",
      label: "Summary",
      text: "needle summary",
      source_ids_json: JSON.stringify(["s1", "s2"]),
      provider: null,
      source_kind: null,
      prediction_id: null,
      sequence: 0,
    };

    expect(runSearchResultFromIndexRow(row, summary(), "needle").sourceIds).toEqual(["s1", "s2"]);
  });
});
