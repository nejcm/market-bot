import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  evalCaseLabel,
  judgeReport,
  omits,
  parseEvalCases,
  reportJudgeItems,
  resolvePointer,
  runEvalCase,
  scoreReportDefects,
  sourceFacts,
  staleSupport,
  unsupportedFigures,
} from "../src/replay/eval-cases";
import { stageDeletionVerdict } from "../src/replay/eval-decision";
import {
  aggregateVotes,
  estimateJudgeTokens,
  JUDGE_STAGE,
  judgeItem,
} from "../src/replay/eval-judge";
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

function isJudged(row: (typeof cases)[number]) {
  return row.check === "contradiction" || row.check === "unsupported-inference";
}

describe("labeled eval cases", () => {
  test("cover every label from 15-30 frozen capture references", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
    expect(cases.length).toBeLessThanOrEqual(30);
    expect(new Set(cases.map((row) => evalCaseLabel(row)))).toEqual(
      new Set(["stale-support", "omission", "unsupported-inference", "clean"]),
    );
    for (const row of cases) {
      expect(row.target.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(row.target.file.startsWith(`${row.capture}/`)).toBe(true);
    }
  });

  test("deterministic checks reproduce every non-judge label", async () => {
    const results = await Promise.all(
      cases.filter((row) => !isJudged(row)).map((row) => runEvalCase(row)),
    );
    expect(results.filter((row) => row.pass !== true)).toEqual([]);
  });

  test("judged cases stay unscored without a judge", async () => {
    const results = await Promise.all(
      cases.filter((row) => isJudged(row)).map((row) => runEvalCase(row)),
    );
    expect(results.map((row) => row.pass)).toEqual(results.map(() => undefined));
  });

  test("judge path aggregates k=3 cassette votes per judged case", async () => {
    const judged = cases.filter((row) => isJudged(row));
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
    expect(unsupportedFigures(text, [facts])).toEqual([]);
    expect(unsupportedFigures(text.replace("6.718", "6.178"), [facts])).toEqual(["$6.178 billion"]);
    expect(
      unsupportedFigures(
        text,
        facts.map((fact) => [fact]),
      ),
    ).toEqual(["58.2%", "81%"]);
    expect(unsupportedFigures("Q2 2026 M&A in 50-day windows", [])).toEqual([]);
    expect(unsupportedFigures("FCF was $110.2B.", [[116_996e6, 6799e6]])).toEqual([]);
  });

  test("source facts exclude metadata and keep derivations inside one cited record", () => {
    const facts = sourceFacts([
      {
        id: "sec-8k",
        url: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000123/x.htm",
        title: "8-K 0000002488-26-000123 filed 2026-08-05",
        accessionNumber: "0000002488-26-000123",
        snippet: "Item 2.02 results; see news-equity-123.",
      },
      { id: "sec-10q", snippet: "Data Center $ 12,493 $ 6,914 (In millions)" },
    ]);
    expect(facts.get("sec-8k")).toEqual([[2.02]]);
    expect(unsupportedFigures("Revenue grew 123%.", facts.get("sec-8k")!)).toEqual(["123%"]);
    expect(unsupportedFigures("Data Center grew 81%.", facts.get("sec-10q")!)).toEqual([]);
    expect(unsupportedFigures("Data Center grew 18%.", facts.get("sec-10q")!)).toEqual(["18%"]);
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
      evidence: [
        { id: "sec", revenue: 12_500_000_000, summary: "growth 9.0 percent" },
        { id: "web-other", note: "12.5 billion" },
      ],
      omissionCases: [omission],
    });
    expect(score).toEqual({
      claims: 3,
      staleSupport: ["keyFindings[1]", "keyFindings[2]"],
      unmatchedFigures: [],
      uncitedRequiredSources: [omission.id],
    });
    expect(
      scoreReportDefects({
        report,
        knownSourceIds: ["sec", "history-report-r0", "web-old"],
        historicalContext: undefined,
        evidence: { id: "web-other", revenue: 12_500_000_000, growth: 9 },
        omissionCases: [],
      }).unmatchedFigures,
    ).toEqual([
      { location: "keyFindings[0]", figures: ["$12.5 billion"] },
      { location: "keyFindings[2]", figures: ["9%"] },
    ]);
  });

  test("report judge counts contradiction and undecided claims, and unconveyed omission cases", async () => {
    const omission = cases.find((row) => row.check === "omission");
    if (omission?.check !== "omission") {
      throw new Error("missing omission case");
    }
    const report = researchReport({
      keyFindings: [
        { text: "Preorders were strong.", sourceIds: ["news-1"] },
        { text: "Wait times shrank.", sourceIds: ["news-2"] },
      ],
      bullCase: [],
      bearCase: [],
      risks: [{ text: "Demand may soften.", sourceIds: ["news-2"] }],
      catalysts: [],
      scenarios: [],
      predictions: [],
      sources: [
        { id: "news-1", title: "Preorders strong", fetchedAt: "2026-10-16", kind: "news" },
        { id: "news-2", title: "UBS: shorter waits", fetchedAt: "2026-10-16", kind: "news" },
      ],
    });
    const items = reportJudgeItems(report, [omission]);
    expect(items.map((row) => [row.kind, row.key])).toEqual([
      ["contradiction", "keyFindings[0]"],
      ["contradiction", "keyFindings[1]"],
      ["contradiction", "risks[0]"],
      ["conveyance", omission.id],
    ]);
    expect(items[1]!.item.evidence).toEqual([{ sourceId: "news-2", text: "UBS: shorter waits" }]);
    expect(estimateJudgeTokens(items.map((row) => row.item))).toBeGreaterThan(4 * 3 * 120);
    const provider = makeReplayProvider({
      entries: {
        [`${JUDGE_STAGE}|stub-judge`]: [
          ["no", "no", "no"],
          ["yes", "yes", "no"],
          ["yes", "no", "maybe"],
          ["yes", "maybe", "no"],
        ]
          .flat()
          .map((verdict) => vote(verdict)),
      },
    });
    expect(await judgeReport(provider, "stub-judge", items)).toEqual({
      contradictions: ["keyFindings[1]", "risks[0]"],
      unconveyed: [omission.id],
      undecided: 2,
    });
  });

  test("stage deletion verdict uses the paired cluster bootstrap and vetoes", () => {
    const baseline = { a: [2, 2, 3], b: [1, 1, 1], c: [4, 3, 4] };
    expect(stageDeletionVerdict({ baseline, ablation: baseline })).toMatchObject({
      pass: true,
      meanDifference: 0,
      upperBound: 0,
      vetoes: [],
    });
    const worse = stageDeletionVerdict({
      baseline,
      ablation: { a: [3, 3, 4], b: [2, 2, 2], c: [5, 4, 5] },
    });
    expect(worse.pass).toBe(false);
    expect(worse.upperBound).toBeCloseTo(1);
    expect(
      stageDeletionVerdict({ baseline, ablation: { ...baseline, b: [1, null, 1] } }).vetoes,
    ).toEqual(["failed or missing sample: b ablation"]);
    expect(
      stageDeletionVerdict({
        baseline,
        ablation: baseline,
        conveyance: { ubs: { baseline: [true, true, false], ablation: [true, false, false] } },
      }).vetoes,
    ).toEqual(["omission regression: ubs"]);
    expect(() => stageDeletionVerdict({ baseline, ablation: { a: [1] } })).toThrow();
  });

  test("rejects malformed and duplicate cases", () => {
    expect(() => parseEvalCases({ version: 2, cases: [] })).toThrow();
    expect(() => parseEvalCases({ version: 1, cases: [cases[0], cases[0]] })).toThrow();
    expect(() =>
      parseEvalCases({ version: 1, cases: [{ ...cases[0], check: "vibes" }] }),
    ).toThrow();
  });
});
