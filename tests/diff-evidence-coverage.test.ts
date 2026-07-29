import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  analyzeEvaluation,
  analyzeGapDisclosure,
  analyzeVariantCoverage,
  assertOutputOutsideData,
  loadEvaluationRoot,
  parseArguments,
  renderHuman,
} from "../scripts/diff-evidence-coverage";

interface BundleOptions {
  readonly lanes?: readonly Record<string, unknown>[];
  readonly ledger?: readonly unknown[];
  readonly gaps?: readonly Record<string, unknown>[];
}

function bundle(options: BundleOptions = {}): Record<string, unknown> {
  const lanes = options.lanes ?? [
    {
      lane: "market-data",
      evidenceClass: "core",
      status: "covered",
      coveredSourceIds: ["source-1"],
      gapIds: [],
    },
  ];
  const ledger = options.ledger ?? [{ id: "source-1", kind: "market-data", lane: "market-data" }];
  return {
    governance: {
      evidenceLanes: {
        lanes,
        summary: {
          plannedLaneCount: lanes.length,
          coreGapLaneCount: 0,
          materialGapLaneCount: 0,
          coverageRatio: 1,
        },
      },
      sourceGaps: options.gaps ?? [],
      sourceLedger: { sources: ledger },
    },
  };
}

function report(
  sourceIds: readonly string[] = ["source-1"],
  sources: readonly Record<string, unknown>[] = [{ id: "source-1", kind: "market-data" }],
  dataGaps: readonly string[] = [],
): Record<string, unknown> {
  return {
    findings: [{ sourceIds }],
    sources,
    dataGaps,
  };
}

function success(
  reportValue: unknown = report(),
  bundleValue: unknown = bundle(),
): Record<string, unknown> {
  return {
    status: "success",
    runDir: "unused-in-pure-tests",
    report: reportValue,
    bundle: bundleValue,
  };
}

function record(
  scenario: string,
  repetition: number,
  legacy: unknown = success(),
  simplified: unknown = success(),
): Record<string, unknown> {
  return {
    scenario,
    repetition,
    variants: { legacy, simplified },
  };
}

function evaluation(
  scenarios: readonly string[],
  repetitions: readonly number[],
  records: readonly Record<string, unknown>[],
  provenance = "run-input",
  loadSource = "fresh-run",
): Record<string, unknown> {
  return {
    plan: {
      provenance,
      loadSource,
      scenarios,
      repetitions,
      expectedPairCount: scenarios.length * repetitions.length,
    },
    records,
  };
}

function completeRecords(
  scenarios: readonly string[],
  repetitions: readonly number[],
): readonly Record<string, unknown>[] {
  return scenarios.flatMap((scenario) =>
    repetitions.map((repetition) => record(scenario, repetition)),
  );
}

describe("coverage diff pairing and adjudicability", () => {
  test("suppresses comparison when the shared evidence input diverges", () => {
    const changedBundle = bundle({
      ledger: [
        { id: "source-1", kind: "market-data", lane: "market-data" },
        { id: "source-2", kind: "market-data", lane: "market-data" },
      ],
    });
    const input = evaluation(
      ["scenario"],
      [1],
      [record("scenario", 1, success(), success(report(), changedBundle))],
    );

    const artifact = analyzeEvaluation(input);

    expect(artifact.pairs[0]?.sharedEvidenceInput).toBe("divergent");
    expect(artifact.totals.pairsNotAdjudicable).toBe(1);
    expect(artifact.comparisons).toHaveLength(0);
    expect(artifact.adjudicationBlockers).toContainEqual({
      reason: "evidence-input-divergent",
      pairs: ["scenario/1"],
      blocking: true,
    });
  });

  test("keeps a failed arm inside the planned 3 by 3 denominator", () => {
    const scenarios = ["a", "b", "c"];
    const repetitions = [1, 2, 3];
    const records = completeRecords(scenarios, repetitions).map((item) =>
      item.scenario === "b" && item.repetition === 2
        ? record("b", 2, success(), {
            status: "error",
            error: "model failed",
            runDir: "simplified-failure",
          })
        : item,
    );

    const artifact = analyzeEvaluation(evaluation(scenarios, repetitions, records));

    expect(artifact.totals).toMatchObject({
      plannedPairCount: 9,
      pairsCompared: 8,
      pairsUnavailable: 1,
      pairsMissing: 0,
      reconciles: true,
    });
    expect(artifact.adjudicable).toBe(false);
  });

  test("names planned pairs that have no record", () => {
    const scenarios = ["a", "b", "c"];
    const repetitions = [1, 2, 3];
    const records = completeRecords(scenarios, repetitions).slice(0, 7);

    const artifact = analyzeEvaluation(evaluation(scenarios, repetitions, records));

    expect(artifact.totals.pairsMissing).toBe(2);
    expect(artifact.adjudicationBlockers).toContainEqual({
      reason: "pair-missing",
      pairs: ["c/2", "c/3"],
      blocking: true,
    });
    expect(artifact.totals.reconciles).toBe(true);
  });

  test("marks unreadable and malformed artifacts unavailable", () => {
    const missing = analyzeEvaluation(
      evaluation(
        ["missing"],
        [1],
        [record("missing", 1, success(), { status: "success", runDir: "missing" })],
      ),
    );
    const malformed = analyzeEvaluation(
      evaluation(
        ["malformed"],
        [1],
        [record("malformed", 1, success(), success(report(), { governance: {} }))],
      ),
    );

    expect(missing.pairs[0]?.unavailableReasons).toEqual(["artifact-unreadable"]);
    expect(malformed.pairs[0]?.unavailableReasons).toEqual(["artifact-unreadable"]);
    expect(missing.totals.pairsUnavailable).toBe(1);
    expect(malformed.totals.pairsUnavailable).toBe(1);
  });

  test("blocks non-run-input provenance but keeps operator recovery advisory", () => {
    const recovered = analyzeEvaluation(
      evaluation(["scenario"], [1], [record("scenario", 1)], "run-input", "operator-recovery"),
    );
    const narrowed = analyzeEvaluation(
      evaluation(["scenario"], [1], [record("scenario", 1)], "operator-recovery-input"),
    );

    expect(recovered.adjudicable).toBe(true);
    expect(recovered.adjudicationBlockers[0]).toMatchObject({
      reason: "plan-load-source-operator-recovery",
      blocking: false,
    });
    expect(narrowed.adjudicable).toBe(false);
    expect(narrowed.totals.coreMaterialOmissionCount).toEqual({
      status: "unavailable",
      reason: "plan-provenance-not-run-input",
    });
  });

  test("requires an authoritative and internally consistent plan", () => {
    expect(() => analyzeEvaluation({ records: [] })).toThrow(
      "evaluation.json does not contain an authoritative plan",
    );
    expect(() =>
      analyzeEvaluation({
        plan: {
          provenance: "run-input",
          loadSource: "fresh-run",
          scenarios: ["a"],
          repetitions: [1],
          expectedPairCount: 2,
        },
        records: [],
      }),
    ).toThrow("consistent planned pair denominator");
  });
});

describe("coverage diff measurements", () => {
  test("represents an empty lane as unavailable instead of zero or one", () => {
    const analysis = analyzeVariantCoverage(
      report([], []),
      bundle({
        lanes: [
          {
            lane: "empty",
            evidenceClass: "material",
            status: "gap",
            coveredSourceIds: [],
            gapIds: ["empty:gap:1"],
          },
        ],
        ledger: [],
      }),
    );

    const measurement = analysis.lanes[0]?.measurement;
    expect(measurement).toEqual({
      status: "unavailable",
      reason: "lane-has-no-collected-sources",
    });
    expect(measurement?.status).toBe("unavailable");
    expect(measurement === undefined ? true : "value" in measurement).toBe(false);
  });

  test("surfaces malformed ledger entries without manufacturing duplicates", () => {
    const lanes = [
      {
        lane: "core-lane",
        evidenceClass: "core",
        status: "covered",
        coveredSourceIds: ["source-1"],
        gapIds: [],
      },
      {
        lane: "material-lane",
        evidenceClass: "material",
        status: "covered",
        coveredSourceIds: ["source-2"],
        gapIds: [],
      },
    ];
    const wellFormedLedger = [
      { id: "source-1", kind: "market-data", lane: "core-lane" },
      { id: "source-2", kind: "news", lane: "material-lane" },
    ];
    const reportValue = report(
      ["source-1"],
      [
        { id: "source-1", kind: "market-data" },
        { id: "source-2", kind: "news" },
      ],
    );

    const wellFormed = analyzeVariantCoverage(
      reportValue,
      bundle({ lanes, ledger: wellFormedLedger }),
    );
    const malformed = analyzeVariantCoverage(
      reportValue,
      bundle({
        lanes,
        ledger: [...wellFormedLedger, { kind: "news", lane: "material-lane" }],
      }),
    );
    const nonRecord = analyzeVariantCoverage(
      reportValue,
      bundle({ lanes, ledger: [...wellFormedLedger, null] }),
    );

    expect(wellFormed.sourceDenominators).toMatchObject({
      laneMappedCollectedSourceIds: 2,
      laneMembershipEntries: 2,
      multiLaneDuplicateEntries: 0,
      malformedLedgerEntries: { count: 0, entries: [] },
      d2MinusD1EqualsMultiLaneDuplicateEntries: true,
      omissionCheckAuthoritative: true,
    });
    expect(malformed.sourceDenominators.d2MinusD1EqualsMultiLaneDuplicateEntries).toBe(false);
    expect(malformed.sourceDenominators).toMatchObject({
      laneMappedCollectedSourceIds: 2,
      laneMembershipEntries: 3,
      multiLaneDuplicateEntries: 0,
      malformedLedgerEntries: {
        count: 1,
        entries: [
          {
            index: 2,
            reason: "id-missing-or-invalid",
            lane: "material-lane",
            kind: "news",
          },
        ],
      },
      omissionCheckAuthoritative: false,
    });
    expect(malformed.uncitedCollectedSources.map((source) => source.id)).toEqual(["source-2"]);
    expect(nonRecord.sourceDenominators.malformedLedgerEntries).toEqual({
      count: 1,
      entries: [{ index: 2, reason: "entry-not-record" }],
    });
  });

  test("marks malformed-ledger omission checks non-authoritative in the artifact and render", () => {
    const malformedBundle = bundle({
      ledger: [
        { id: "source-1", kind: "market-data", lane: "market-data" },
        { kind: "news", lane: "market-data" },
      ],
    });
    const artifact = analyzeEvaluation(
      evaluation(
        ["scenario"],
        [1],
        [
          record(
            "scenario",
            1,
            success(report(), malformedBundle),
            success(report(), malformedBundle),
          ),
        ],
      ),
    );

    expect(artifact.adjudicable).toBe(false);
    expect(artifact.totals.omissionCheckUnavailableCount).toBe(1);
    expect(artifact.adjudicationBlockers).toContainEqual({
      reason: "malformed-ledger-entries",
      pairs: ["scenario/1"],
      blocking: true,
    });
    expect(renderHuman(artifact)).toContain(
      "D1=1, D2=2, malformed-ledger=1 (index 1: id-missing-or-invalid)",
    );
  });

  test("keeps D1, D2, and D3 structurally distinct", () => {
    const evidence = bundle({
      lanes: [
        {
          lane: "core-lane",
          evidenceClass: "core",
          status: "covered",
          coveredSourceIds: ["source-1", "source-2"],
          gapIds: [],
        },
        {
          lane: "material-lane",
          evidenceClass: "material",
          status: "covered",
          coveredSourceIds: ["source-1", "source-3"],
          gapIds: [],
        },
      ],
      ledger: [
        { id: "source-1", kind: "market-data", lane: "core-lane" },
        { id: "source-2", kind: "news", lane: "core-lane" },
        { id: "source-1", kind: "market-data", lane: "material-lane" },
        { id: "source-3", kind: "filing", lane: "material-lane" },
      ],
    });
    const sources = [
      { id: "source-1", kind: "market-data" },
      { id: "source-2", kind: "news" },
      { id: "source-3", kind: "filing" },
      { id: "extended-1", kind: "web" },
      { id: "extended-2", kind: "web" },
      { id: "extended-3", kind: "reference" },
    ];

    const analysis = analyzeVariantCoverage(report(["source-1"], sources), evidence);

    expect(analysis.laneMapped.measurement).toMatchObject({
      status: "measured",
      value: 1 / 3,
      denominator: { name: "lane-mapped-collected", symbol: "D1", value: 3 },
    });
    expect(analysis.carriedNotLaneMapped).toHaveLength(3);
    expect(analysis.sourceDenominators).toMatchObject({
      laneMappedCollectedSourceIds: 3,
      laneMembershipEntries: 4,
      reportCarriedSources: 6,
      multiLaneDuplicateEntries: 1,
    });
  });

  test("classifies a cited but unmapped carried source without inflating lane coverage", () => {
    const analysis = analyzeVariantCoverage(
      report(
        ["source-1", "extended-1"],
        [
          { id: "source-1", kind: "market-data" },
          { id: "extended-1", kind: "web" },
        ],
      ),
      bundle(),
    );

    expect(analysis.citedNotLaneMapped).toEqual([
      {
        id: "extended-1",
        lanes: [],
        evidenceClasses: [],
        kind: "web",
      },
    ]);
    expect(analysis.laneMapped.citedSourceIds).toEqual(["source-1"]);
    expect(analysis.laneMapped.measurement).toMatchObject({ value: 1 });
  });

  test("catches undisclosed deterministic gaps and preserves undetermined gaps", () => {
    const disclosure = analyzeGapDisclosure(report([], [], []), [
      {
        source: "sec-edgar",
        message: "Missing facts",
        cause: "provider-data-missing",
        symbol: "AAPL",
      },
      {
        source: "unknown-provider",
        cause: "provider-data-missing",
      },
    ]);

    expect(disclosure.entries[0]).toMatchObject({
      status: "not-disclosed",
      rendering: "sec-edgar: Missing facts [AAPL]",
    });
    expect(disclosure.entries[1]).toMatchObject({
      status: "undetermined",
      reason: "no-deterministic-rendering",
    });
    expect(disclosure.providerDataMissing.notDisclosedCount).toMatchObject({
      status: "measured",
      value: 1,
    });
    expect(disclosure.providerDataMissing.undeterminedCount).toMatchObject({
      status: "measured",
      value: 1,
    });
  });

  test("does not diff model-authored gap prose", () => {
    const input = evaluation(
      ["scenario"],
      [1],
      [
        record(
          "scenario",
          1,
          success(report(["source-1"], undefined, ["legacy prose"]), bundle()),
          success(report(["source-1"], undefined, ["wildly different prose"]), bundle()),
        ),
      ],
    );

    const artifact = analyzeEvaluation(input);
    const comparison = artifact.comparisons[0]!;

    expect(comparison.omissions.simplifiedOnlyUncited).toEqual([]);
    expect(comparison.omissions.legacyOnlyUncited).toEqual([]);
    expect(artifact.notComparedAndWhy).toContainEqual(
      expect.objectContaining({ subject: "model-authored report.dataGaps prose" }),
    );
    expect(JSON.stringify(comparison)).not.toContain("legacy prose");
    expect(JSON.stringify(comparison)).not.toContain("wildly different prose");
  });

  test("keeps found-none measured alongside the unavailable complement", () => {
    const input = evaluation(
      ["ok", "failed"],
      [1],
      [record("ok", 1), record("failed", 1, success(), { status: "error", error: "failed" })],
    );

    const artifact = analyzeEvaluation(input);

    expect(artifact.totals.coreMaterialOmissionCount).toMatchObject({
      status: "measured",
      value: 0,
    });
    expect(artifact.totals.omissionCheckUnavailableCount).toBe(1);
    expect(artifact.adjudicable).toBe(false);
  });

  test("counts records outside the authoritative plan without blocking adjudication", () => {
    const artifact = analyzeEvaluation(
      evaluation(
        ["planned"],
        [1],
        [record("planned", 1), record("unexpected", 1), record("planned", 2)],
      ),
    );

    expect(artifact.totals.unmatchedRecordCount).toBe(2);
    expect(artifact.adjudicable).toBe(true);
    expect(artifact.adjudicationBlockers).toEqual([]);
    expect(renderHuman(artifact)).toContain("unmatched-records=2");
  });
});

describe("coverage diff CLI helpers", () => {
  test("fails when an evaluation root has no evaluation artifact", async () => {
    const missingRoot = resolve(import.meta.dir, "__missing_coverage_diff_root__");

    await expect(loadEvaluationRoot(missingRoot)).rejects.toThrow("Cannot read");
  });

  test("renders adjudicability before counts and keeps complements adjacent", () => {
    const artifact = analyzeEvaluation(
      evaluation(
        ["scenario"],
        [1],
        [record("scenario", 1, success(), { status: "error", error: "failed" })],
      ),
    );

    const rendered = renderHuman(artifact);
    const adjudicabilityIndex = rendered.indexOf("adjudicable: false");
    const omissionIndex = rendered.indexOf("omissions=");
    const totalsLine = rendered.split("\n").find((line) => line.includes("omissions="));

    expect(adjudicabilityIndex).toBeGreaterThanOrEqual(0);
    expect(adjudicabilityIndex).toBeLessThan(omissionIndex);
    expect(totalsLine).toContain("pairs-unavailable=");
    expect(totalsLine).toContain("over lane-mapped-collected (D1)");
  });

  test.each([
    ["relative data path", "data/out.json"],
    ["traversal into data", "scripts/../data/out.json"],
    [
      "absolute data path",
      resolve(import.meta.dir, "..", "data", "__coverage_diff_test__", "out.json"),
    ],
    ["bare data", "data"],
  ])("rejects %s", (_label, out) => {
    expect(() => assertOutputOutsideData(out)).toThrow("--out must not write under data/");
  });

  test("returns a resolved path for an output outside data", () => {
    expect(assertOutputOutsideData("artifacts/coverage-diff.json")).toBe(
      resolve(import.meta.dir, "..", "artifacts", "coverage-diff.json"),
    );
  });

  test("parses one positional root and rejects extra or unknown arguments", () => {
    expect(parseArguments(["root", "--json", "--out", "result.json"])).toEqual({
      root: "root",
      json: true,
      out: "result.json",
    });
    expect(() => parseArguments(["one", "two"])).toThrow("Usage:");
    expect(() => parseArguments(["--unknown"])).toThrow("Usage:");
  });
});
