import { describe, expect, test } from "bun:test";
import type { SourceGap } from "../src/domain/types";
import {
  acceptedJsonToolAuditEntry,
  budgetRejectionReason,
  rejectedJsonToolRequest,
  withStaleFallbackGaps,
  type JsonToolBudgetValidation,
} from "../src/research/json-tool-loop-support";

function budget(overrides: Partial<JsonToolBudgetValidation> = {}): JsonToolBudgetValidation {
  return {
    maxToolCalls: 5,
    sourceBudget: 10,
    toolCallsUsed: 0,
    sourceUnitsUsed: 0,
    requestSourceUnits: 1,
    toolCallExceededReason: "tool-call budget exhausted",
    sourceBudgetExceededReason: "source budget exhausted",
    ...overrides,
  };
}

describe("acceptedJsonToolAuditEntry", () => {
  test("stamps an accepted audit entry with the source units it consumed", () => {
    expect(acceptedJsonToolAuditEntry(2, "web_search", { query: "x" }, "need coverage", 3)).toEqual(
      {
        round: 2,
        tool: "web_search",
        args: { query: "x" },
        rationale: "need coverage",
        status: "accepted",
        sourceUnits: 3,
      },
    );
  });
});

describe("budgetRejectionReason", () => {
  test("returns undefined when the request fits within both budgets", () => {
    expect(budgetRejectionReason(budget())).toBeUndefined();
  });

  test("rejects when the next tool call would exceed the tool-call cap", () => {
    expect(budgetRejectionReason(budget({ toolCallsUsed: 5 }))).toBe("tool-call budget exhausted");
  });

  test("rejects when the request would exceed the source budget", () => {
    expect(budgetRejectionReason(budget({ sourceUnitsUsed: 10, requestSourceUnits: 1 }))).toBe(
      "source budget exhausted",
    );
  });

  test("prefers the tool-call reason when both budgets are exceeded", () => {
    expect(
      budgetRejectionReason(
        budget({ toolCallsUsed: 5, sourceUnitsUsed: 10, requestSourceUnits: 5 }),
      ),
    ).toBe("tool-call budget exhausted");
  });

  test("treats the boundary as allowed (used + request equal to the cap)", () => {
    expect(
      budgetRejectionReason(
        budget({ toolCallsUsed: 4, sourceUnitsUsed: 9, requestSourceUnits: 1 }),
      ),
    ).toBeUndefined();
  });
});

describe("rejectedJsonToolRequest", () => {
  test("builds a rejected audit entry paired with a validation source gap", () => {
    const { audit, gap } = rejectedJsonToolRequest(
      1,
      "web_fetch",
      { url: "https://example.com" },
      "wanted more evidence",
      "over budget",
      { source: "web-gather", provider: "exa", capability: "web-gather" },
    );

    expect(audit).toEqual({
      round: 1,
      tool: "web_fetch",
      args: { url: "https://example.com" },
      rationale: "wanted more evidence",
      status: "rejected",
      reason: "over budget",
    });
    expect(gap).toEqual({
      source: "web-gather",
      message: "web_fetch: over budget",
      provider: "exa",
      capability: "web-gather",
      cause: "validation-failed",
      evidenceQualityImpact: "extended-evidence-cap",
    });
  });

  test("omits optional args, rationale, and provider when they are absent", () => {
    const { audit, gap } = rejectedJsonToolRequest(
      0,
      "web_search",
      undefined,
      undefined,
      "blocked",
      { source: "web-gather", capability: "web-gather" },
    );

    expect(audit).toEqual({ round: 0, tool: "web_search", status: "rejected", reason: "blocked" });
    expect("args" in audit).toBe(false);
    expect("rationale" in audit).toBe(false);
    expect("provider" in gap).toBe(false);
  });

  test("allows source gap message overrides without changing the audit reason", () => {
    const { audit, gap } = rejectedJsonToolRequest(
      1,
      "web_search",
      { query: "off topic" },
      "try search",
      "raw rejection",
      {
        source: "web-gather",
        provider: "exa",
        capability: "web-gather",
        gapMessage: "friendly rejection",
      },
    );

    expect(audit).toEqual(
      expect.objectContaining({
        status: "rejected",
        reason: "raw rejection",
      }),
    );
    expect(gap).toEqual(
      expect.objectContaining({
        source: "web-gather",
        message: "friendly rejection",
      }),
    );
  });
});

describe("withStaleFallbackGaps", () => {
  test("appends only the stale gaps accumulated during execution", async () => {
    const existing: SourceGap = { source: "old", message: "pre-existing" };
    const fresh: SourceGap = { source: "yahoo", message: "stale close used" };
    const collector = { staleFallbackGaps: [existing] as SourceGap[] };
    const output = { gaps: [{ source: "exa", message: "own gap" }] as SourceGap[], value: 1 };

    const result = await withStaleFallbackGaps(collector, async () => {
      collector.staleFallbackGaps.push(fresh);
      return output;
    });

    expect(result.value).toBe(1);
    expect(result.gaps).toEqual([{ source: "exa", message: "own gap" }, fresh]);
  });

  test("leaves output gaps untouched when no stale gaps are added", async () => {
    const collector = { staleFallbackGaps: [] as SourceGap[] };
    const output = { gaps: [{ source: "exa", message: "own gap" }] as SourceGap[] };

    const result = await withStaleFallbackGaps(collector, async () => output);

    expect(result.gaps).toEqual([{ source: "exa", message: "own gap" }]);
  });
});
