import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  evalCaseLabel,
  cancelMatchedItems,
  judgeReport,
  omits,
  parseEvalCases,
  reportJudgeItems,
  resolvePointer,
  runEvalCase,
  scoreReportDefects,
  sourceFacts,
  staleSupport,
  synthesisFigureCounts,
  unsupportedFigures,
} from "../src/replay/eval-cases";
import { stageDeletionStatistics } from "../src/replay/eval-decision";
import {
  aggregateVotes,
  estimateJudgeTokens,
  JUDGE_STAGE,
  judgeItem,
} from "../src/replay/eval-judge";
import { makeReplayProvider } from "../src/replay/llm-cassette";
import { collectedSources, researchReport, verifiedMarketSnapshot } from "./support/fixtures";
import {
  referenceMetricSections,
  resolveMetricReferences,
} from "../src/research/metric-references";
import { metricReferenceEvidence } from "../src/research/prompts/metric-references";

const cases = parseEvalCases(
  await Bun.file(join(import.meta.dir, "fixtures/eval-cases/cases.json")).json(),
);

function vote(verdict: string) {
  return { content: JSON.stringify({ verdict, reason: "stub" }), tokenEstimate: 1 };
}

function secReport(texts: readonly string[]) {
  return researchReport({ keyFindings: texts.map((text) => ({ text, sourceIds: ["sec"] })) });
}

function claim(text: string, sourceIds: readonly string[]) {
  return { text, sourceIds };
}

function isJudged(row: (typeof cases)[number]) {
  return row.check === "contradiction" || row.check === "unsupported-inference";
}

const typed = (text: string) =>
  synthesisFigureCounts(JSON.stringify({ keyFindings: [{ text }] })).typedFigures;

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

  test("judge path aggregates cassette votes per judged case, stopping at a settled majority", async () => {
    const judged = cases.filter((row) => isJudged(row));
    const votes = judged.flatMap((row, index) => {
      const majority = row.defect ? "yes" : "no";
      const dissent = row.defect ? "no" : "yes";
      return index === 0 ? [majority, dissent, majority] : [majority, majority];
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
    expect(aggregateVotes(["insufficient-evidence", "insufficient-evidence", "no"]).verdict).toBe(
      "insufficient-evidence",
    );
  });

  test("unparseable responses become invalid votes", async () => {
    const provider = makeReplayProvider({
      entries: {
        [`${JUDGE_STAGE}|m`]: [vote("no"), { content: "not json", tokenEstimate: 1 }, vote("no")],
      },
    });
    const result = await judgeItem(provider, "m", { question: "q", claim: "c", evidence: [] });
    expect(result).toEqual({
      verdict: "no",
      votes: ["no", "invalid", "no"],
      agreement: 2 / 3,
    });
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
    expect(facts.get("sec-8k")).toEqual([[2.02, 2020, 2_020_000]]);
    expect(unsupportedFigures("Revenue grew 123%.", facts.get("sec-8k")!)).toEqual(["123%"]);
    expect(unsupportedFigures("Data Center grew 81%.", facts.get("sec-10q")!)).toEqual([]);
    expect(unsupportedFigures("Data Center grew 18%.", facts.get("sec-10q")!)).toEqual(["18%"]);
  });

  test("figure check never rescales by a billion and needs a second operand to derive", () => {
    expect(unsupportedFigures("Revenue was $12.5 billion.", [[12.5]])).toEqual(["$12.5 billion"]);
    expect(
      unsupportedFigures(
        "Revenue was $12.5 billion.",
        sourceFacts({ id: "s", note: "12.5" }).get("s")!,
      ),
    ).toEqual(["$12.5 billion"]);
    expect(
      unsupportedFigures(
        "Revenue was $12.5 billion.",
        sourceFacts({ id: "s", note: "$12.5 billion" }).get("s")!,
      ),
    ).toEqual([]);
    expect(unsupportedFigures("Revenue grew 100%.", [[40]])).toEqual(["100%"]);
    expect(unsupportedFigures("Revenue grew 100%.", [[40, 80]])).toEqual([]);
    expect(unsupportedFigures("Revenue changed by $0.", [[40]])).toEqual(["$0"]);
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
    const evidence = [
      { id: "news-1", title: "Preorders strong", summary: "Preorders beat the prior cycle." },
      { id: "news-2", title: "UBS: shorter waits" },
    ];
    const items = reportJudgeItems(report, [omission], evidence);
    expect(items.map((row) => [row.kind, row.key])).toEqual([
      ["contradiction", "keyFindings[0]"],
      ["contradiction", "keyFindings[1]"],
      ["contradiction", "risks[0]"],
      ["conveyance", omission.id],
    ]);
    expect(items[1]!.item.evidence).toEqual([
      { sourceId: "news-2", text: '[1] {"id":"news-2","title":"UBS: shorter waits"}' },
    ]);
    expect(reportJudgeItems(report, [], [])[0]!.item.evidence[0]!.text).toMatch(
      /carries no record/u,
    );
    expect(estimateJudgeTokens(items.map((row) => row.item))).toBeGreaterThan(4 * 3 * 120);
    const provider = makeReplayProvider({
      entries: {
        [`${JUDGE_STAGE}|stub-judge`]: [
          ["no", "no"],
          ["yes", "no", "yes"],
          ["insufficient-evidence", "insufficient-evidence"],
          ["yes", "maybe", "no"],
        ]
          .flat()
          .map((verdict) => vote(verdict)),
      },
    });
    expect(await judgeReport(provider, "stub-judge", items)).toEqual({
      contradictions: ["keyFindings[1]", "risks[0]"],
      unconveyed: [omission.id],
      undecided: 1,
      insufficientEvidence: 1,
    });
  });

  test("summary prose is judged and checked like any model-authored claim", () => {
    const omission = cases.find((row) => row.check === "omission");
    if (omission?.check !== "omission") {
      throw new Error("missing omission case");
    }
    const report = researchReport({ summary: "Data Center revenue collapsed by 99%." });
    const evidence = [{ id: "sec", title: "AMD 10-Q", revenue: 6_718_000_000 }];
    const items = reportJudgeItems(report, [omission], evidence);
    expect(items.map((row) => [row.kind, row.key])).toEqual([
      ["contradiction", "summary"],
      ["conveyance", omission.id],
    ]);
    expect(items[0]!.item.claim).toBe("Data Center revenue collapsed by 99%.");
    expect(items[1]!.item.claim).toContain("collapsed by 99%");
    expect(
      scoreReportDefects({
        report,
        knownSourceIds: ["sec"],
        historicalContext: undefined,
        evidence,
        omissionCases: [],
      }),
    ).toMatchObject({ claims: 1, unmatchedFigures: [{ location: "summary", figures: ["99%"] }] });
  });

  test("model-authored data gaps are judged against the whole projection", () => {
    const omission = cases.find((row) => row.check === "omission");
    if (omission?.check !== "omission") {
      throw new Error("missing omission case");
    }
    const report = researchReport({ dataGaps: ["AMD Data Center revenue collapsed by 99%."] });
    const items = reportJudgeItems(report, [omission], [{ id: "sec", revenue: 6_718_000_000 }]);
    expect(items.map((row) => [row.kind, row.key])).toEqual([
      ["contradiction", "dataGaps[0]"],
      ["conveyance", omission.id],
    ]);
    expect(items[0]!.item.evidence.map((row) => row.sourceId)).toEqual([
      "final-synthesis-evidence",
    ]);
    expect(items[1]!.item.claim).toContain("collapsed by 99%");
  });

  test("citations resolve sibling snapshot ids and metric-section defaults, keeping provenance", () => {
    // Shapes copied from the capture 6b4aa8ab final-synthesis projection.
    const evidence = {
      metricReferences: [
        {
          id: "business-framework-business",
          title: "Business Framework: Business",
          defaults: {
            unit: "currency",
            currency: "USD",
            periodEnd: "2026-06-27",
            periodMonths: 6,
            sourceIds: ["extended-sec-edgar-amd-fundamentals"],
          },
          metrics: [
            {
              reference: "<<metric:business-framework-business.revenue>>",
              label: "Revenue",
              status: "value",
              value: "$21.8B",
            },
          ],
        },
        {
          id: "segments",
          defaults: { unit: "currency", periodEnd: "2026-06-27", sourceIds: ["sec"] },
          metrics: [{ label: "Data Center revenue", value: "$6.718 billion" }],
        },
      ],
      verifiedMarketSnapshot: {
        symbol: "AMD",
        latestSessionDate: "2026-10-19",
        ohlcv: { date: "2026-10-19", close: 538.05 },
        indicators: { rsi14: 40.47 },
      },
      verifiedMarketSnapshotSourceId: "verified-snapshot-AMD",
      historicalContext: {
        runs: [{ runId: "r0", summary: "Prior run prose.", sourceIds: ["verified-snapshot-AMD"] }],
      },
    };
    const report = researchReport({
      keyFindings: [
        { text: "Data Center revenue was $6.718 billion.", sourceIds: ["sec"] },
        {
          text: "First-half revenue was $21.8B.",
          sourceIds: ["extended-sec-edgar-amd-fundamentals"],
        },
        { text: "AMD's October 19 close was $538.05.", sourceIds: ["verified-snapshot-AMD"] },
      ],
    });
    const [segment, revenue, snapshot] = reportJudgeItems(report, [], evidence).map(
      (row) => row.item.evidence[0]!.text,
    );
    expect(segment).toContain('"value":"$6.718 billion"');
    expect(segment).toContain('"periodEnd":"2026-06-27"');
    expect(revenue).toMatch(
      /metricReferences\[0\]\.metrics\[0\] .*"currency":"USD".*"value":"\$21\.8B"/u,
    );
    expect(snapshot).toContain("verifiedMarketSnapshot.ohlcv");
    expect(snapshot).toContain("538.05");
    expect(snapshot).toContain("historicalContext.runs[0]");
    expect(
      scoreReportDefects({
        report,
        knownSourceIds: ["sec", "extended-sec-edgar-amd-fundamentals", "verified-snapshot-AMD"],
        historicalContext: undefined,
        evidence,
        omissionCases: [],
      }).unmatchedFigures,
    ).toEqual([]);
  });

  test("paired cancellation matches complete requests as a multiset", () => {
    const evidence = [{ id: "sec", note: "Revenue rose." }];
    const control = reportJudgeItems(secReport(["Same.", "Same.", "Only control."]), [], evidence);
    const ablation = reportJudgeItems(secReport(["Same.", "Only ablation."]), [], evidence);
    const otherEvidence = reportJudgeItems(
      secReport(["Same."]),
      [],
      [{ id: "sec", note: "Other." }],
    );
    const paired = cancelMatchedItems(control, ablation);
    expect(paired.canceled).toEqual([{ control: "keyFindings[0]", ablation: "keyFindings[0]" }]);
    expect(paired.control.map((row) => row.key)).toEqual(["keyFindings[1]", "keyFindings[2]"]);
    expect(paired.ablation.map((row) => row.key)).toEqual(["keyFindings[1]"]);
    expect(cancelMatchedItems(control, otherEvidence).canceled).toEqual([]);
    const omission = cases.find((row) => row.check === "omission");
    if (omission?.check !== "omission") {
      throw new Error("missing omission case");
    }
    const sameReport = secReport(["Same."]);
    const conveyance = cancelMatchedItems(
      reportJudgeItems(sameReport, [omission], evidence),
      reportJudgeItems(sameReport, [omission], evidence),
    );
    expect(conveyance.sharedConveyance).toEqual([omission.id]);
    expect(conveyance.control.map((row) => row.key)).toEqual([omission.id]);
    expect(conveyance.ablation).toEqual([]);
  });

  test("the omission veto depends on a shared conveyance verdict, so it is kept", () => {
    // Pair 1 shares one judged verdict; pairs 2-3 are control [yes, no] vs ablation [no, no].
    const scores = { a: [1, 1, 1] };
    const veto = (shared: boolean) =>
      stageDeletionStatistics({
        arm: "market-behavior-analysis",
        control: scores,
        ablation: scores,
        conveyance: { ubs: { control: [shared, true, false], ablation: [shared, false, false] } },
      }).vetoes;
    expect(veto(true)).toEqual(["omission regression: ubs"]);
    expect(veto(false)).toEqual([]);
  });

  test("a judgment stops once two valid votes agree", async () => {
    const provider = makeReplayProvider({
      entries: {
        [`${JUDGE_STAGE}|m`]: ["no", "no", "invalid", "yes", "no"].map((verdict) => vote(verdict)),
      },
    });
    const meter = { calls: 0, tokens: 0 };
    const item = { question: "q", claim: "c", evidence: [] };
    const settled = await judgeItem(provider, "m", item, meter);
    expect(settled.votes).toEqual(["no", "no"]);
    expect(meter.calls).toBe(2);
    const contested = await judgeItem(provider, "m", item, meter);
    expect(contested.votes).toEqual(["invalid", "yes", "no"]);
  });

  test("the judge meter keeps calls and tokens spent before a failure", async () => {
    const provider = makeReplayProvider({
      entries: {
        [`${JUDGE_STAGE}|m`]: ["no", "no", "no", "yes"].map((verdict, index) => ({
          ...vote(verdict),
          tokenEstimate: index + 1,
        })),
      },
    });
    const item = { question: "q", claim: "c", evidence: [] };
    const meter = { calls: 0, tokens: 0 };
    const items = [item, item].map((row, index) => ({
      kind: "contradiction" as const,
      key: `k${String(index)}`,
      item: row,
    }));
    await expect(judgeReport(provider, "m", items, meter)).rejects.toThrow();
    expect(meter).toEqual({ calls: 5, tokens: 10 });
  });

  test("judge evidence selects cited passages past the old 2,000-character cut", () => {
    // Capture 6b4aa8ab: the 10-Q snippet puts 6,718 at char 2,201 and the demand passage past 3,300.
    const filler =
      "Risk factors describe competition and supply constraints in general terms. ".repeat(40);
    const snippet = `${filler}Net revenue: Data Center $ 6,718 $ 3,240 $ 12,493 $ 6,914 (In millions). ${filler}Data Center net revenue of $12.5 billion for the six months ended June 27, 2026 increased by 81%, compared to net revenue of $6.9 billion for the prior year period. The increase in both periods was primarily driven by strong demand for our AMD EPYC processors and AMD Instinct MI350 Series GPUs.`;
    const report = researchReport({
      keyFindings: [
        {
          text: "First-half Data Center revenue grew 81% year over year on weak demand for EPYC processors.",
          sourceIds: ["extended-sec-edgar-amd-10q"],
        },
      ],
      bullCase: [],
      bearCase: [],
      risks: [],
      catalysts: [],
      scenarios: [],
      predictions: [],
    });
    const [item] = reportJudgeItems(report, [], {
      extendedSources: [{ id: "extended-sec-edgar-amd-10q", title: "AMD SEC 10-Q", snippet }],
    });
    const { text } = item!.item.evidence[0]!;
    expect(snippet.indexOf("strong demand")).toBeGreaterThan(2259);
    expect(text).toContain("increased by 81%");
    expect(text).toContain("strong demand for our AMD EPYC processors");
    expect(text.length).toBeLessThanOrEqual(4000);
  });

  test("stage deletion statistics carry the arm scope, a stratified bound and vetoes", () => {
    const baseline = { a: [2, 2, 3], b: [1, 1, 1], c: [4, 3, 4] };
    const scope = { arm: "market-behavior-analysis" } as const;
    const same = stageDeletionStatistics({ ...scope, control: baseline, ablation: baseline });
    expect(same).toMatchObject({
      ...scope,
      control: "market-behavior-analysis-control",
      removedStages: ["market-behavior-analysis"],
      captures: 3,
      margin: 0.5,
      vetoes: [],
    });
    expect(same.meanDifference).toBe(0);
    expect(same.upperBound).toBe(0);
    const noisy = stageDeletionStatistics({
      ...scope,
      control: baseline,
      ablation: { a: [2, 3, 3], b: [1, 2, 1], c: [4, 3, 5] },
    });
    expect(noisy.meanDifference).toBeCloseTo(1 / 3);
    expect(noisy.upperBound).toBeGreaterThan(noisy.meanDifference);
    expect("pass" in same).toBe(false);
    const constant = { a: [2, 2, 2], b: [1, 1, 1] };
    const shifted = stageDeletionStatistics({
      ...scope,
      control: constant,
      ablation: { a: [3, 3, 3], b: [2, 2, 2] },
    });
    expect(shifted.meanDifference).toBe(1);
    expect(shifted.upperBound).toBe(1);
    expect(
      stageDeletionStatistics({
        ...scope,
        control: { ...baseline, a: [null, 2, 3] },
        ablation: { ...baseline, b: [1, null, 1] },
      }).vetoes,
    ).toEqual(["failed or missing sample: a control", "failed or missing sample: b ablation"]);
    expect(
      stageDeletionStatistics({
        ...scope,
        control: baseline,
        ablation: baseline,
        conveyance: { ubs: { control: [true, true, false], ablation: [true, false, false] } },
      }).vetoes,
    ).toEqual(["omission regression: ubs"]);
    expect(() =>
      stageDeletionStatistics({ ...scope, control: baseline, ablation: { a: [1] } }),
    ).toThrow();
    expect(() =>
      stageDeletionStatistics({
        arm: "market-behavior-analysis-control",
        control: baseline,
        ablation: baseline,
      }),
    ).toThrow(/control arm/u);
  });

  test("rendered metric references are verified figures; typed ones are still checked", () => {
    const sections = referenceMetricSections(
      collectedSources({ verifiedMarketSnapshot: verifiedMarketSnapshot() }),
    );
    const report = resolveMetricReferences(
      researchReport({
        keyFindings: [
          {
            text: "Close <<metric:market-session.close|period>>, change <<metric:market-session.sessionChangePercent>>, RSI14 <<metric:market-session.rsi14>>.",
            sourceIds: [],
          },
          { text: "Close $118.00 <<metric:market-session.close>>.", sourceIds: [] },
        ],
      }),
      sections,
    );
    expect(report.keyFindings[0]!.text).toBe(
      "Close 108.00 (as of 2026-05-18), change 2.9%, RSI14 55.00.",
    );
    expect(
      scoreReportDefects({
        report,
        knownSourceIds: ["verified-snapshot-AAPL"],
        historicalContext: undefined,
        evidence: metricReferenceEvidence(sections),
        omissionCases: [],
      }).unmatchedFigures,
    ).toEqual([{ location: "keyFindings[1]", figures: ["$118.00"] }]);
  });

  test("synthesis figure counts split rendered references from typed figures", () => {
    expect(
      synthesisFigureCounts(
        JSON.stringify({
          keyFindings: [
            {
              text: "Revenue grew 44.1% <<metric:financial-lens-growth.revenueDeltaPercent|period>>; close <<metric:market-session.close>>.",
              sourceIds: ["sec-10q-2026"],
            },
          ],
          scenarios: [{ name: "Base", description: "Margin near 20%." }],
          predictions: [{ measurableAs: "AAPL close outside [$100, $120] on 2026-06-01" }],
        }),
      ),
    ).toEqual({ metricReferences: 2, typedFigures: 2 });
    expect(typed("RSI14 was 55.00 and close was 108.00.")).toBe(2);
    expect(typed("On 2026-10-16, the 3rd session of Q3 2026 after the 10-K, FY2025.")).toBe(0);
    expect(typed("Volume 20,153,700 vs 1.2M; 3 segments, -4% and 2x.")).toBe(5);
    expect(typed("EPS was -.50 and margin was .25%.")).toBe(2);
    expect(typed("Yield .5, change -.75%, beta .9.")).toBe(3);
  });

  test("rejects malformed and duplicate cases", () => {
    expect(() => parseEvalCases({ version: 2, cases: [] })).toThrow();
    expect(() => parseEvalCases({ version: 1, cases: [cases[0], cases[0]] })).toThrow();
    expect(() =>
      parseEvalCases({ version: 1, cases: [{ ...cases[0], check: "vibes" }] }),
    ).toThrow();
  });
});
