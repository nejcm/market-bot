import { describe, expect, test } from "bun:test";
import { isRecord } from "../src/guards";
import {
  OFFLINE_FINANCIAL_STATEMENT_FIXTURES,
  auditOfflineCorpusCase,
  loadOfflineCorpusCase,
  mutateOfflineCorpusCase,
  type OfflineCorpusExecution,
  type OfflineCorpusMutation,
} from "./support/offline-financial-statements-corpus";
import {
  detectEligibleRevenueAliasAlternatives,
  detectInterchangeableAliasCandidates,
  verifyHistoryAnnualRosters,
  type AliasVerdict,
  type RosterVerdict,
} from "./support/offline-financial-history-roster";
import {
  classifierPattern,
  countNetworkAttemptsDuring,
  runOfflineCorpusFixture,
  type OfflineCorpusFixtureName,
} from "./support/offline-corpus-test-helpers";
import {
  cloneCompanyFactsWithMutableUsGaap,
  eligibleMaraRevenueFacts,
  syntheticAliasExecution,
  yearsBetween,
} from "./support/offline-financial-history-fixtures";

const ASC_606_REVENUE_CONCEPT = "RevenueFromContractWithCustomerExcludingAssessedTax";

const MARGIN_ANNUAL_PATH = "fundamentalHistory.grossMargin.annual";
const MARGIN_CHANGE_PATH = "fundamentalHistory.grossMargin.marginChange";

type HistoryClassifierFaultScenario = readonly [
  name: string,
  fixture: OfflineCorpusFixtureName,
  mutations: readonly OfflineCorpusMutation[],
  regeneratedHashPaths: readonly string[],
  expected: RegExp,
];

const HISTORY_CLASSIFIER_FAULT_SCENARIOS: readonly HistoryClassifierFaultScenario[] = [
  [
    "rejects a history defect when a regenerated hash hides a margin sign flip",
    "mara",
    [[`${MARGIN_CHANGE_PATH}.percentagePoints`, "negate"]],
    [MARGIN_CHANGE_PATH],
    classifierPattern(
      "unclassified mara difference ",
      MARGIN_ANNUAL_PATH,
      ": fundamental-history property re-derivation failed",
    ),
  ],
  [
    "rejects a history defect when a regenerated hash hides a margin-years mutation",
    "mara",
    [[`${MARGIN_CHANGE_PATH}.years`, "increment"]],
    [MARGIN_CHANGE_PATH],
    classifierPattern(
      "unclassified mara difference ",
      MARGIN_ANNUAL_PATH,
      ": fundamental-history property re-derivation failed",
    ),
  ],
  [
    "catches a CAGR percent sign flip after its allowance hash is regenerated",
    "nbis",
    [["fundamentalHistory.revenue.cagr.percent", "negate"]],
    ["fundamentalHistory.revenue.cagr"],
    classifierPattern(
      "unclassified nbis difference ",
      "fundamentalHistory.revenue.annual",
      ": fundamental-history property re-derivation failed",
    ),
  ],
  [
    "rejects a degenerate single-point margin summary with regenerated hashes",
    "mara",
    [
      [MARGIN_ANNUAL_PATH, "last-only"],
      [MARGIN_CHANGE_PATH, "zero-margin-last", MARGIN_ANNUAL_PATH],
    ],
    [MARGIN_ANNUAL_PATH, MARGIN_CHANGE_PATH],
    classifierPattern(
      "unclassified mara difference ",
      MARGIN_ANNUAL_PATH,
      ": fundamental-history property re-derivation failed",
    ),
  ],
  ...(["dilutedEps", "grossMargin"] as const).map((seriesKey): HistoryClassifierFaultScenario => {
    const path = `fundamentalHistory.${seriesKey}.ttm`;
    return [
      `rejects malformed raw and derived TTM values with regenerated hashes (${seriesKey})`,
      "fpi-quarterly",
      [
        seriesKey === "dilutedEps"
          ? [`${path}.form`, "set", "20-F"]
          : [`${path}.value`, "add-cent"],
      ],
      [path],
      classifierPattern(
        "unclassified fpi-quarterly difference ",
        path,
        ": fundamental-history property re-derivation failed",
      ),
    ];
  }),
  [
    "catches an operating-cash-flow TTM value mutation with regenerated hashes",
    "fpi-quarterly",
    [["fundamentalHistory.operatingCashFlow.ttm.value", "double"]],
    ["fundamentalHistory.operatingCashFlow.ttm"],
    classifierPattern(
      "unclassified fpi-quarterly difference ",
      "fundamentalHistory.operatingCashFlow.ttm",
      ": fundamental-history property re-derivation failed",
    ),
  ],
];

describe("offline financial-statement corpus — history rosters and alias fault injection", () => {
  test("keeps history-roster and alias fault-injection fixtures offline", async () => {
    const networkAttempts = await countNetworkAttemptsDuring(async () => {
      const maraCase = await loadOfflineCorpusCase("mara");
      for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
        const execution = await runOfflineCorpusFixture(fixture);
        void [...detectInterchangeableAliasCandidates(execution)];
        void [...detectEligibleRevenueAliasAlternatives(execution)];
        void [...verifyHistoryAnnualRosters(execution)];
      }
      void [...detectInterchangeableAliasCandidates(syntheticAliasExecution(maraCase, "alias"))];
      const mutated = mutateOfflineCorpusCase(maraCase, {
        mutations: [[`${MARGIN_CHANGE_PATH}.percentagePoints`, "negate"]],
        allowanceUpdates: [{ path: MARGIN_CHANGE_PATH }],
      });
      try {
        auditOfflineCorpusCase(mutated);
      } catch {
        // Expected: this fault injection intentionally trips the comparator alarm.
      }
    });

    expect(networkAttempts).toBe(0);
  });

  test("pins the interchangeable-alias candidate set across the corpus", async () => {
    const verdicts: Record<string, AliasVerdict> = {};
    for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
      const execution = await runOfflineCorpusFixture(fixture);
      for (const [key, verdict] of detectInterchangeableAliasCandidates(execution)) {
        verdicts[`${fixture}.${key}`] = verdict;
      }
    }

    expect(verdicts).toEqual({
      "aapl.canonical.revenue": { kind: "no-alternative-concept-with-facts" },
      "aapl.legacy.revenue": { kind: "no-alternative-concept-with-facts" },
      "msft.canonical.revenue": { kind: "no-alternative-concept-with-facts" },
      "msft.legacy.revenue": { kind: "no-alternative-concept-with-facts" },
      "mara.canonical.revenue": {
        kind: "rejected",
        candidateConcept: ASC_606_REVENUE_CONCEPT,
        reasons: ["not-a-superset", "disagrees-on-shared-periods"],
      },
      "mara.legacy.revenue": {
        kind: "rejected",
        candidateConcept: ASC_606_REVENUE_CONCEPT,
        reasons: ["not-a-superset", "disagrees-on-shared-periods"],
      },
      "nbis.canonical.revenue": { kind: "no-alternative-concept-with-facts" },
      "nbis.legacy.revenue": { kind: "no-selected-concept" },
      "fpi-quarterly.canonical.revenue": { kind: "no-alternative-concept-with-facts" },
      "fpi-quarterly.legacy.revenue": { kind: "no-selected-concept" },
      "fpi-ifrs-semiannual.canonical.revenue": {
        kind: "no-alternative-concept-with-facts",
      },
      "fpi-ifrs-semiannual.legacy.revenue": { kind: "no-selected-concept" },
    });
    expect(
      Object.entries(verdicts)
        .filter(([, verdict]) => verdict.kind === "alias-substitutable")
        .map(([key]) => key),
    ).toEqual([]);
    expect(Object.values(verdicts).filter((verdict) => verdict.kind === "rejected")).toHaveLength(
      2,
    );
    expect(
      Object.values(verdicts).filter(
        (verdict) => verdict.kind === "no-alternative-concept-with-facts",
      ),
    ).toHaveLength(7);
    expect(
      Object.values(verdicts).filter((verdict) => verdict.kind === "no-selected-concept"),
    ).toHaveLength(3);

    const { execution } = await loadOfflineCorpusCase("mara");
    const revenues = eligibleMaraRevenueFacts(
      execution.input.companyFacts,
      "Revenues",
      execution.input.analysisAsOf,
    );
    const contractRevenue = eligibleMaraRevenueFacts(
      execution.input.companyFacts,
      ASC_606_REVENUE_CONCEPT,
      execution.input.analysisAsOf,
    );
    expect(revenues.map((fact) => fact.periodEnd)).toEqual([
      "2013-12-31",
      "2014-12-31",
      "2015-12-31",
      "2016-12-31",
      "2017-12-31",
      "2021-12-31",
      "2022-12-31",
      "2023-12-31",
      "2024-12-31",
      "2025-12-31",
    ]);
    expect(contractRevenue.map((fact) => fact.periodEnd)).toEqual([
      "2022-12-31",
      "2023-12-31",
      "2024-12-31",
      "2025-12-31",
    ]);
    const revenueByEnd = new Map(revenues.map((fact) => [fact.periodEnd, fact.value]));
    expect(
      contractRevenue.map((fact) =>
        Number((revenueByEnd.get(fact.periodEnd)! / fact.value).toFixed(2)),
      ),
    ).toEqual([11.91, 6.72, 6.8, 15.45]);
  });

  test("pins at most one eligible alternative revenue concept per corpus side", async () => {
    const alternatives: Record<string, readonly string[] | undefined> = {};
    for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
      const execution = await runOfflineCorpusFixture(fixture);
      for (const [key, concepts] of detectEligibleRevenueAliasAlternatives(execution)) {
        alternatives[`${fixture}.${key}`] = concepts;
      }
    }
    expect(alternatives).toEqual({
      "aapl.canonical.revenue": [],
      "aapl.legacy.revenue": [],
      "msft.canonical.revenue": [],
      "msft.legacy.revenue": [],
      "mara.canonical.revenue": [ASC_606_REVENUE_CONCEPT],
      "mara.legacy.revenue": [ASC_606_REVENUE_CONCEPT],
      "nbis.canonical.revenue": [],
      "nbis.legacy.revenue": undefined,
      "fpi-quarterly.canonical.revenue": [],
      "fpi-quarterly.legacy.revenue": undefined,
      "fpi-ifrs-semiannual.canonical.revenue": [],
      "fpi-ifrs-semiannual.legacy.revenue": undefined,
    });
    expect(Object.keys(alternatives)).toHaveLength(12);
    expect(
      Object.values(alternatives).every(
        (concepts) => concepts === undefined || concepts.length <= 1,
      ),
    ).toBe(true);
  });

  test("the synthetic alias issuer fires the interchangeable-alias detector", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    expect(
      Object.fromEntries(
        detectInterchangeableAliasCandidates(syntheticAliasExecution(maraCase, "alias")),
      ),
    ).toEqual({
      "canonical.revenue": {
        kind: "alias-substitutable",
        candidateConcept: "SalesRevenueNet",
        addedPeriodEnds: ["2016-12-31", "2017-12-31", "2018-12-31"],
      },
      "legacy.revenue": {
        kind: "alias-substitutable",
        candidateConcept: "SalesRevenueNet",
        addedPeriodEnds: ["2016-12-31", "2017-12-31", "2018-12-31"],
      },
    });
  });

  test("counts a newer strict-superset alias when the selected series is cap-saturated", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    const execution = syntheticAliasExecution(maraCase, "newer-alias");
    for (const side of ["canonical", "legacy"] as const) {
      const selected = execution.projection[side].fundamentalHistory.revenue;
      expect(selected?.concept).toBe("Revenues");
      expect(selected?.annual.map((point) => point.periodEnd)).toEqual([
        "2013-12-31",
        "2014-12-31",
        "2015-12-31",
        "2016-12-31",
        "2017-12-31",
        "2018-12-31",
        "2019-12-31",
        "2020-12-31",
        "2021-12-31",
        "2022-12-31",
      ]);
    }
    expect(Object.fromEntries(detectInterchangeableAliasCandidates(execution))).toEqual({
      "canonical.revenue": {
        kind: "alias-substitutable",
        candidateConcept: "SalesRevenueNet",
        addedPeriodEnds: ["2023-12-31"],
      },
      "legacy.revenue": {
        kind: "alias-substitutable",
        candidateConcept: "SalesRevenueNet",
        addedPeriodEnds: ["2023-12-31"],
      },
    });
  });

  test("the component and renamed-disjoint shapes do not fire, with disjoint kill sets", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    expect(
      Object.fromEntries(
        detectInterchangeableAliasCandidates(syntheticAliasExecution(maraCase, "component")),
      ),
    ).toEqual({
      "canonical.revenue": {
        kind: "rejected",
        candidateConcept: "SalesRevenueNet",
        reasons: ["disagrees-on-shared-periods"],
      },
      "legacy.revenue": {
        kind: "rejected",
        candidateConcept: "SalesRevenueNet",
        reasons: ["disagrees-on-shared-periods"],
      },
    });
    expect(
      Object.fromEntries(
        detectInterchangeableAliasCandidates(syntheticAliasExecution(maraCase, "renamed-disjoint")),
      ),
    ).toEqual({
      "canonical.revenue": {
        kind: "rejected",
        candidateConcept: "SalesRevenueNet",
        reasons: ["not-a-superset"],
      },
      "legacy.revenue": {
        kind: "rejected",
        candidateConcept: "SalesRevenueNet",
        reasons: ["not-a-superset"],
      },
    });
  });

  test("anchors base annual rosters to raw facts and derived rosters through base series", async () => {
    const failed: string[] = [];
    const excluded: string[] = [];
    const capDisplaced: string[] = [];
    let maraDilutedEps: RosterVerdict | null = null;

    for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
      const execution = await runOfflineCorpusFixture(fixture);
      for (const [key, verdict] of verifyHistoryAnnualRosters(execution)) {
        const id = `${fixture}:${key}`;
        if (verdict.kind === "failed") {
          failed.push(`${id}:${verdict.reason}`);
        } else if (verdict.kind === "vacuous-empty" || verdict.kind === "unanchored-empty") {
          excluded.push(`${id}:${verdict.kind}`);
        } else if (verdict.kind === "verified-cap-displaced") {
          capDisplaced.push(`${id}:${JSON.stringify(verdict)}`);
        }
        if (fixture === "mara" && key === "canonical.dilutedEps") {
          maraDilutedEps = verdict;
        }
      }
    }

    expect(failed).toEqual([]);
    expect(capDisplaced.toSorted()).toEqual([
      'mara:canonical.dilutedEps:{"kind":"verified-cap-displaced","droppedPeriodEnds":["2014-12-31","2015-12-31"],"newerUnionPeriods":10}',
      'mara:canonical.revenue:{"kind":"verified-cap-displaced","droppedPeriodEnds":["2013-12-31","2014-12-31","2015-12-31"],"newerUnionPeriods":10}',
    ]);
    expect(excluded.toSorted()).toEqual([
      "fpi-ifrs-semiannual:canonical.capex:unanchored-empty",
      "fpi-ifrs-semiannual:canonical.freeCashFlowProxy:vacuous-empty",
      "fpi-ifrs-semiannual:legacy.capex:unanchored-empty",
      "fpi-ifrs-semiannual:legacy.dilutedEps:unanchored-empty",
      "fpi-ifrs-semiannual:legacy.freeCashFlowProxy:vacuous-empty",
      "fpi-ifrs-semiannual:legacy.grossMargin:vacuous-empty",
      "fpi-ifrs-semiannual:legacy.grossProfit:unanchored-empty",
      "fpi-ifrs-semiannual:legacy.netIncome:unanchored-empty",
      "fpi-ifrs-semiannual:legacy.netMargin:vacuous-empty",
      "fpi-ifrs-semiannual:legacy.operatingCashFlow:unanchored-empty",
      "fpi-ifrs-semiannual:legacy.operatingIncome:unanchored-empty",
      "fpi-ifrs-semiannual:legacy.operatingMargin:vacuous-empty",
      "fpi-ifrs-semiannual:legacy.revenue:unanchored-empty",
      "fpi-quarterly:canonical.capex:unanchored-empty",
      "fpi-quarterly:canonical.freeCashFlowProxy:vacuous-empty",
      "fpi-quarterly:legacy.capex:unanchored-empty",
      "fpi-quarterly:legacy.dilutedEps:unanchored-empty",
      "fpi-quarterly:legacy.freeCashFlowProxy:vacuous-empty",
      "fpi-quarterly:legacy.grossMargin:vacuous-empty",
      "fpi-quarterly:legacy.grossProfit:unanchored-empty",
      "fpi-quarterly:legacy.netIncome:unanchored-empty",
      "fpi-quarterly:legacy.netMargin:vacuous-empty",
      "fpi-quarterly:legacy.operatingCashFlow:unanchored-empty",
      "fpi-quarterly:legacy.operatingIncome:unanchored-empty",
      "fpi-quarterly:legacy.operatingMargin:vacuous-empty",
      "fpi-quarterly:legacy.revenue:unanchored-empty",
      "mara:legacy.grossMargin:vacuous-empty",
      "mara:legacy.grossProfit:vacuous-empty",
      "nbis:canonical.grossMargin:vacuous-empty",
      "nbis:canonical.grossProfit:unanchored-empty",
      "nbis:legacy.capex:unanchored-empty",
      "nbis:legacy.dilutedEps:unanchored-empty",
      "nbis:legacy.freeCashFlowProxy:vacuous-empty",
      "nbis:legacy.grossMargin:vacuous-empty",
      "nbis:legacy.grossProfit:unanchored-empty",
      "nbis:legacy.netIncome:unanchored-empty",
      "nbis:legacy.netMargin:vacuous-empty",
      "nbis:legacy.operatingCashFlow:unanchored-empty",
      "nbis:legacy.operatingIncome:unanchored-empty",
      "nbis:legacy.operatingMargin:vacuous-empty",
      "nbis:legacy.revenue:unanchored-empty",
    ]);
    expect(maraDilutedEps).toEqual({
      kind: "verified-cap-displaced",
      droppedPeriodEnds: ["2014-12-31", "2015-12-31"],
      newerUnionPeriods: 10,
    });
  });

  test("rejects a faithful MARA legacy revenue substitution to the ASC 606 component", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    const { execution } = maraCase;
    const { payload, usGaap } = cloneCompanyFactsWithMutableUsGaap(execution.input.companyFacts);
    delete usGaap.Revenues;
    delete usGaap.SalesRevenueNet;
    const substituted = mutateOfflineCorpusCase(maraCase, { input: { companyFacts: payload } });
    const substitutedHistory = substituted.execution.projection.legacy.fundamentalHistory;
    const { revenue } = substitutedHistory;
    if (revenue === undefined) {
      throw new Error("MARA substitution did not produce legacy revenue history");
    }
    const injected: OfflineCorpusExecution = {
      ...execution,
      projection: {
        ...execution.projection,
        legacy: {
          ...execution.projection.legacy,
          fundamentalHistory: {
            ...execution.projection.legacy.fundamentalHistory,
            revenue,
            grossMargin: substitutedHistory.grossMargin!,
            operatingMargin: substitutedHistory.operatingMargin!,
            netMargin: substitutedHistory.netMargin!,
          },
        },
      },
    };
    const failed = [...verifyHistoryAnnualRosters(injected)]
      .filter(([, verdict]) => verdict.kind === "failed")
      .map(([key]) => key);

    expect(revenue.concept).toBe(ASC_606_REVENUE_CONCEPT);
    expect(failed).toEqual(["legacy.revenue"]);
    expect(verifyHistoryAnnualRosters(injected).get("legacy.revenue")).toEqual({
      kind: "failed",
      reason: `legacy.revenue emitted concept ${ASC_606_REVENUE_CONCEPT} but selection policy yields Revenues`,
    });
  });

  test("rejects a revenue concept outside the 100-day recency bucket", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    const { payload, usGaap } = cloneCompanyFactsWithMutableUsGaap(
      maraCase.execution.input.companyFacts,
    );
    const revenues = usGaap.Revenues;
    if (!isRecord(revenues) || !isRecord(revenues.units) || !Array.isArray(revenues.units.USD)) {
      throw new Error("MARA fixture is missing USD Revenues facts");
    }
    revenues.units.USD = revenues.units.USD.filter(
      (fact) => isRecord(fact) && typeof fact.end === "string" && fact.end <= "2024-12-31",
    );
    const { execution } = mutateOfflineCorpusCase(maraCase, { input: { companyFacts: payload } });
    const { payload: staleOnlyPayload, usGaap: staleOnlyUsGaap } =
      cloneCompanyFactsWithMutableUsGaap(payload);
    delete staleOnlyUsGaap[ASC_606_REVENUE_CONCEPT];
    delete staleOnlyUsGaap.SalesRevenueNet;
    delete staleOnlyUsGaap.RevenueFromContractWithCustomerIncludingAssessedTax;
    const { execution: staleOnly } = mutateOfflineCorpusCase(maraCase, {
      input: { companyFacts: staleOnlyPayload },
    });
    const staleHistory = staleOnly.projection.legacy.fundamentalHistory;
    const staleRevenue = staleHistory.revenue;
    if (staleRevenue === undefined) {
      throw new Error("MARA stale-only input did not produce legacy revenue history");
    }
    const injected: OfflineCorpusExecution = {
      ...execution,
      projection: {
        ...execution.projection,
        legacy: {
          ...execution.projection.legacy,
          fundamentalHistory: {
            ...execution.projection.legacy.fundamentalHistory,
            revenue: staleRevenue,
            grossMargin: staleHistory.grossMargin!,
            operatingMargin: staleHistory.operatingMargin!,
            netMargin: staleHistory.netMargin!,
          },
        },
      },
    };
    const failed = [...verifyHistoryAnnualRosters(injected)]
      .filter(([, verdict]) => verdict.kind === "failed")
      .map(([key]) => key)
      .toSorted();

    expect(execution.projection.legacy.fundamentalHistory.revenue?.concept).toBe(
      ASC_606_REVENUE_CONCEPT,
    );
    expect(staleRevenue.concept).toBe("Revenues");
    expect(failed).toEqual(["legacy.revenue"]);
    expect(verifyHistoryAnnualRosters(injected).get("legacy.revenue")).toEqual({
      kind: "failed",
      reason: `legacy.revenue emitted concept Revenues but selection policy yields ${ASC_606_REVENUE_CONCEPT}`,
    });
  });

  test("rejects source-derivable annual metadata corruption", async () => {
    const nbisCase = await loadOfflineCorpusCase("nbis");
    const { revenue } = nbisCase.execution.projection.canonical.fundamentalHistory;
    const original = revenue?.annual.at(0);
    if (revenue === undefined || original === undefined) {
      throw new Error("NBIS golden is missing revenue history");
    }
    const corrupted = {
      ...original,
      fy: original.fy + 1,
      fp: "Q1",
      periodMonths: 3,
      currency: "EUR",
    };
    const injected = mutateOfflineCorpusCase(nbisCase, {
      mutations: [
        ["fundamentalHistory.revenue.annual", "set", [corrupted, ...revenue.annual.slice(1)]],
      ],
    }).execution;

    const verdict = verifyHistoryAnnualRosters(injected).get("canonical.revenue");
    expect(verdict?.kind).toBe("failed");
    if (verdict?.kind !== "failed") {
      throw new Error("Corrupted NBIS revenue metadata was not rejected");
    }
    expect(verdict.reason).toContain(
      'missingPeriodEnds=["2021-12-31"] extraPeriodEnds=["2021-12-31"]',
    );
  });

  test("catches consistently truncated NBIS net-margin history after hashes are regenerated", async () => {
    const nbisCase = await loadOfflineCorpusCase("nbis");
    const { netMargin } = nbisCase.execution.projection.canonical.fundamentalHistory;
    const annual = netMargin?.annual.slice(-3);
    const first = annual?.at(0);
    const last = annual?.at(-1);
    if (
      netMargin === undefined ||
      annual === undefined ||
      first === undefined ||
      last === undefined
    ) {
      throw new Error("NBIS golden is missing net-margin history");
    }
    const marginChange = {
      percentagePoints: (last.value - first.value) * 100,
      years: yearsBetween(first.periodEnd, last.periodEnd),
      periodStart: first.periodEnd,
      periodEnd: last.periodEnd,
    };
    const mutated = mutateOfflineCorpusCase(nbisCase, {
      mutations: [
        ["fundamentalHistory.netMargin.annual", "set", annual],
        ["fundamentalHistory.netMargin.marginChange", "set", marginChange],
      ],
      allowanceUpdates: [
        { path: "fundamentalHistory.netMargin.annual" },
        { path: "fundamentalHistory.netMargin.marginChange" },
      ],
    });

    expect(netMargin.annual).toHaveLength(5);
    expect(annual).toHaveLength(3);
    expect(marginChange.percentagePoints).toBeCloseTo(-2446.67, 2);
    expect(marginChange.years).toBeCloseTo(2.001, 3);
    expect(() => auditOfflineCorpusCase(mutated)).not.toThrow();
    const verdict = verifyHistoryAnnualRosters(mutated.execution).get("canonical.netMargin");
    expect(verdict?.kind).toBe("failed");
    if (verdict?.kind !== "failed") {
      throw new Error("Truncated NBIS net-margin roster was not rejected");
    }
    expect(verdict.reason).toContain('missingPeriodEnds=["2021-12-31","2022-12-31"]');
  });

  test("catches consistently truncated NBIS revenue history after hashes are regenerated", async () => {
    const nbisCase = await loadOfflineCorpusCase("nbis");
    const { revenue } = nbisCase.execution.projection.canonical.fundamentalHistory;
    const annual = revenue?.annual.slice(-3);
    const first = annual?.at(0);
    const last = annual?.at(-1);
    if (
      revenue === undefined ||
      annual === undefined ||
      first === undefined ||
      last === undefined
    ) {
      throw new Error("NBIS golden is missing revenue history");
    }
    const years = yearsBetween(first.periodEnd, last.periodEnd);
    const cagr = {
      percent: ((last.value / first.value) ** (1 / years) - 1) * 100,
      years,
      periodStart: first.periodEnd,
      periodEnd: last.periodEnd,
    };
    const mutated = mutateOfflineCorpusCase(nbisCase, {
      mutations: [
        ["fundamentalHistory.revenue.annual", "set", annual],
        ["fundamentalHistory.revenue.cagr", "set", cagr],
      ],
      allowanceUpdates: [
        { path: "fundamentalHistory.revenue.annual" },
        { path: "fundamentalHistory.revenue.cagr" },
      ],
    });

    expect(revenue.annual).toHaveLength(5);
    expect(annual).toHaveLength(3);
    expect(cagr.percent).toBeCloseTo(634.23, 2);
    expect(cagr.years).toBeCloseTo(2, 2);
    expect(() => auditOfflineCorpusCase(mutated)).not.toThrow();
    const verdict = verifyHistoryAnnualRosters(mutated.execution).get("canonical.revenue");
    expect(verdict?.kind).toBe("failed");
    if (verdict?.kind !== "failed") {
      throw new Error("Truncated NBIS revenue roster was not rejected");
    }
    expect(verdict.reason).toContain('missingPeriodEnds=["2021-12-31","2022-12-31"]');
  });

  test("catches MARA diluted-EPS truncation beyond legitimate joint-cap displacement", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    const { dilutedEps } = maraCase.execution.projection.canonical.fundamentalHistory;
    const annual = dilutedEps?.annual.slice(-5);
    if (dilutedEps === undefined || annual === undefined) {
      throw new Error("MARA golden is missing diluted-EPS history");
    }
    const mutated = mutateOfflineCorpusCase(maraCase, {
      mutations: [["fundamentalHistory.dilutedEps.annual", "set", annual]],
      allowanceUpdates: [{ path: "fundamentalHistory.dilutedEps.annual" }],
    });

    expect(dilutedEps.annual).toHaveLength(8);
    expect(annual).toHaveLength(5);
    expect(() => auditOfflineCorpusCase(mutated)).not.toThrow();
    const verdict = verifyHistoryAnnualRosters(mutated.execution).get("canonical.dilutedEps");
    expect(verdict?.kind).toBe("failed");
    if (verdict?.kind !== "failed") {
      throw new Error("Over-truncated MARA diluted-EPS roster was not rejected");
    }
    expect(verdict.reason).toContain('missingPeriodEnds=["2016-12-31","2019-12-31","2020-12-31"]');
    expect(verdict.reason).toContain(
      'admissibleCapDisplacedPeriodEnds=["2014-12-31","2015-12-31"]',
    );
  });

  test("rejects the original truncated-history defect on an allowance-backed path", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    const msftCase = await loadOfflineCorpusCase("msft");
    const { grossMargin: maraGrossMargin } =
      maraCase.execution.projection.canonical.fundamentalHistory;
    const { grossMargin: msftGrossMargin } =
      msftCase.execution.projection.canonical.fundamentalHistory;
    const originalMarginChange = msftGrossMargin?.marginChange;
    const annual = msftGrossMargin?.annual.slice(Math.floor(msftGrossMargin.annual.length / 2));
    const first = annual?.at(0);
    const last = annual?.at(-1);
    if (
      maraGrossMargin === undefined ||
      msftGrossMargin === undefined ||
      originalMarginChange === null ||
      originalMarginChange === undefined ||
      annual === undefined ||
      first === undefined ||
      last === undefined
    ) {
      throw new Error("MSFT golden is missing gross-margin history");
    }
    expect(maraCase.allowances).toContainEqual(
      expect.objectContaining({
        fixture: "mara",
        path: "fundamentalHistory.grossMargin.annual",
      }),
    );
    expect(maraCase.allowances).toContainEqual(
      expect.objectContaining({
        fixture: "mara",
        path: "fundamentalHistory.grossMargin.marginChange",
      }),
    );
    expect(() => auditOfflineCorpusCase(maraCase)).not.toThrow();

    const injectedMarginChange = {
      percentagePoints: (last.value - first.value) * 100,
      years:
        (Date.parse(last.periodEnd) - Date.parse(first.periodEnd)) /
        (365.2425 * 24 * 60 * 60 * 1000),
      periodStart: first.periodEnd,
      periodEnd: last.periodEnd,
    };
    const injected = mutateOfflineCorpusCase(maraCase, {
      mutations: [
        [MARGIN_ANNUAL_PATH, "set", annual],
        [MARGIN_CHANGE_PATH, "set", injectedMarginChange],
      ],
    });

    expect(originalMarginChange.percentagePoints).toBeCloseTo(3.42, 2);
    expect(originalMarginChange.years).toBeCloseTo(9, 2);
    expect(injectedMarginChange.percentagePoints).toBeCloseTo(-0.46, 2);
    expect(injectedMarginChange.years).toBeCloseTo(4, 2);
    expect(() => auditOfflineCorpusCase(injected)).toThrow(
      /Offline comparator alarm: unclassified mara difference/u,
    );
  });

  for (const scenario of HISTORY_CLASSIFIER_FAULT_SCENARIOS) {
    const [name, fixture, mutations, hashPaths, expected] = scenario;
    test(name, async () => {
      const corpusCase = await loadOfflineCorpusCase(fixture);
      const mutated = mutateOfflineCorpusCase(corpusCase, {
        mutations,
        allowanceUpdates: hashPaths.map((path) => ({ path })),
      });

      expect(() => auditOfflineCorpusCase(mutated)).toThrow(expected);
    });
  }
});
