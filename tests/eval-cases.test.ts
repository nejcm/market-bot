import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  evalCaseLabel,
  omits,
  parseEvalCases,
  resolvePointer,
  runEvalCase,
  scoreReportDefects,
  staleSupport,
  unsupportedFigures,
} from "../src/replay/eval-cases";
import { aggregateVotes, JUDGE_STAGE, judgeItem } from "../src/replay/eval-judge";
import { makeReplayProvider } from "../src/replay/llm-cassette";
import { researchReport } from "./support/fixtures";

const cases = parseEvalCases(
  await Bun.file(join(import.meta.dir, "fixtures/eval-cases/cases.json")).json(),
);

function vote(verdict: string) {
  return { content: JSON.stringify({ verdict, reason: "stub" }), tokenEstimate: 1 };
}

function claim(text: string, sourceIds: readonly string[]) {
  return { text, sourceIds };
}

describe("labeled eval cases", () => {
  test("cover every label from 15-30 frozen capture references", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.length).toBeLessThanOrEqual(30);
    expect(new Set(cases.map((row) => evalCaseLabel(row)))).toEqual(
      new Set(["stale-support", "omission", "contradiction", "clean"]),
    );
    for (const row of cases) {
      expect(row.target.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(row.target.file.startsWith(`${row.capture}/`)).toBe(true);
    }
  });

  test("deterministic checks reproduce every non-judge label", async () => {
    const results = await Promise.all(
      cases.filter((row) => row.check !== "contradiction").map((row) => runEvalCase(row)),
    );
    expect(results.filter((row) => row.pass !== true)).toEqual([]);
  });

  test("contradiction cases stay unscored without a judge", async () => {
    const results = await Promise.all(
      cases.filter((row) => row.check === "contradiction").map((row) => runEvalCase(row)),
    );
    expect(results.map((row) => row.pass)).toEqual(results.map(() => undefined));
  });

  test("judge path aggregates k=3 cassette votes per contradiction case", async () => {
    const judged = cases.filter((row) => row.check === "contradiction");
    const votes = judged.flatMap((row, index) => {
      const majority = row.defect ? "yes" : "no";
      const dissent = row.defect ? "no" : "yes";
      return index === 0 ? [majority, dissent, majority] : [majority, majority, "maybe"];
    });
    const provider = makeReplayProvider({
      entries: { [`${JUDGE_STAGE}|stub-judge`]: votes.map((verdict) => vote(verdict)) },
    });
    const results = [];
    for (const row of judged) {
      // oxlint-disable-next-line no-await-in-loop -- cassette votes are consumed in case order
      results.push(await runEvalCase(row, (item) => judgeItem(provider, "stub-judge", item)));
    }
    expect(results.map((row) => row.pass)).toEqual(judged.map(() => true));
    expect(provider.diagnostics().unusedResponses).toEqual({});
  });
});

describe("judge vote aggregation", () => {
  test("needs a strict majority and counts invalid votes against it", () => {
    expect(aggregateVotes(["yes", "yes", "no"])).toMatchObject({
      verdict: "yes",
      agreement: 2 / 3,
    });
    expect(aggregateVotes(["yes", "no", "invalid"]).verdict).toBe("undecided");
    expect(aggregateVotes(["no", "invalid", "invalid"]).verdict).toBe("undecided");
    expect(aggregateVotes([])).toMatchObject({ verdict: "undecided", agreement: 0 });
  });

  test("unparseable responses become invalid votes", async () => {
    const provider = makeReplayProvider({
      entries: {
        [`${JUDGE_STAGE}|m`]: [vote("no"), { content: "not json", tokenEstimate: 1 }, vote("no")],
      },
    });
    const result = await judgeItem(provider, "m", { question: "q", claim: "c", evidence: [] });
    expect(result).toEqual({ verdict: "no", votes: ["no", "invalid", "no"], agreement: 2 / 3 });
  });
});

describe("deterministic checks", () => {
  test("stale support distinguishes carried, unresolved and history-only citations", () => {
    const current = new Set(["sec-10q", "history-report-r1"]);
    const historical = new Set(["web-old"]);
    expect(staleSupport(claim("x", ["sec-10q"]), current, historical)).toBeUndefined();
    expect(staleSupport(claim("x", ["sec-10q", "web-old"]), current, historical)).toBe(
      "carried-over-citation",
    );
    expect(staleSupport(claim("x", ["web-new"]), current, historical)).toBe("unresolved-citation");
    expect(
      staleSupport(claim("x [Observed fact]", ["history-report-r1"]), current, historical),
    ).toBe("history-only-support");
    expect(
      staleSupport(claim("x [Stale evidence]", ["history-report-r1"]), current, historical),
    ).toBeUndefined();
    expect(staleSupport(claim("x", []), current, historical)).toBeUndefined();
  });

  test("figure check accepts direct and one-step derived values and flags a changed figure", () => {
    const facts = [6718e6, 11_536e6, 12_493e6, 6914e6];
    const text =
      "Data Center revenue was $6.718 billion, or 58.2% of revenue; first half grew 81%.";
    expect(unsupportedFigures(text, facts, true)).toEqual([]);
    expect(unsupportedFigures(text.replace("6.718", "6.178"), facts, true)).toEqual([
      "$6.178 billion",
    ]);
    expect(unsupportedFigures(text, facts, false)).toEqual(["58.2%", "81%"]);
    expect(unsupportedFigures("Q2 2026 M&A in 50-day windows", [], false)).toEqual([]);
  });

  test("omission flips when any required source is cited", () => {
    expect(omits(new Set(["a"]), ["b", "c"])).toBe(true);
    expect(omits(new Set(["a", "c"]), ["b", "c"])).toBe(false);
  });

  test("pointers descend into JSON-encoded stage content", () => {
    const root = { stages: [{ content: JSON.stringify({ findings: [{ text: "t" }] }) }] };
    expect(resolvePointer(root, ["stages", 0, "content", "$json", "findings", 0, "text"])).toBe(
      "t",
    );
    expect(resolvePointer(root, ["stages", 1, "content"])).toBeUndefined();
  });

  test("report scoring counts stale citations, unmatched figures and unmet omission cases", () => {
    const omission = cases.find((row) => row.check === "omission" && row.defect);
    if (omission?.check !== "omission") {
      throw new Error("missing omission case");
    }
    const report = researchReport({
      keyFindings: [
        { text: "Revenue was $12.5 billion.", sourceIds: ["sec"] },
        { text: "Margins held. [Observed fact]", sourceIds: ["history-report-r0"] },
        { text: "Revenue rose 9%.", sourceIds: ["sec", "web-old"] },
      ],
      bullCase: [],
      bearCase: [],
      risks: [],
      catalysts: [],
      scenarios: [],
      predictions: [],
    });
    const score = scoreReportDefects({
      report,
      knownSourceIds: ["sec", "history-report-r0"],
      historicalContext: { runs: [{ keyFindings: [{ sourceIds: ["web-old"] }] }] },
      evidence: { revenue: 12_500_000_000, summary: "growth 9.0 percent" },
      omissionCases: [omission],
    });
    expect(score).toEqual({
      claims: 3,
      staleSupport: ["keyFindings[1]", "keyFindings[2]"],
      unmatchedFigures: [],
      omissions: [omission.id],
    });
    expect(
      scoreReportDefects({
        report,
        knownSourceIds: ["sec", "history-report-r0", "web-old"],
        historicalContext: undefined,
        evidence: {},
        omissionCases: [],
      }).unmatchedFigures,
    ).toEqual([
      { location: "keyFindings[0]", figures: ["$12.5 billion"] },
      { location: "keyFindings[2]", figures: ["9%"] },
    ]);
  });

  test("rejects malformed and duplicate cases", () => {
    expect(() => parseEvalCases({ version: 2, cases: [] })).toThrow();
    expect(() => parseEvalCases({ version: 1, cases: [cases[0], cases[0]] })).toThrow();
    expect(() =>
      parseEvalCases({ version: 1, cases: [{ ...cases[0], check: "vibes" }] }),
    ).toThrow();
  });
});
