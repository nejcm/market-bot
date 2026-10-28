import { describe, expect, test } from "bun:test";
import { yearsBetween } from "./support/fiscal-years";
import { isRecord } from "../src/guards";
import {
  OFFLINE_FINANCIAL_STATEMENT_FIXTURES,
  loadOfflineCorpusCase,
  mutateOfflineCorpusCase,
} from "./support/offline-financial-statements-corpus";
import {
  detectEligibleRevenueAliasAlternatives,
  detectInterchangeableAliasCandidates,
  verifyHistoryAnnualRosters,
  type AliasVerdict,
  type RosterVerdict,
} from "./support/offline-financial-history-roster";
import {
  countNetworkAttemptsDuring,
  runOfflineCorpusFixture,
} from "./support/offline-corpus-test-helpers";
import {
  cloneCompanyFactsWithMutableUsGaap,
  eligibleMaraRevenueFacts,
  syntheticAliasExecution,
} from "./support/offline-financial-history-fixtures";

const ASC_606_REVENUE_CONCEPT = "RevenueFromContractWithCustomerExcludingAssessedTax";

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
      "msft.canonical.revenue": { kind: "no-alternative-concept-with-facts" },
      "mara.canonical.revenue": {
        kind: "rejected",
        candidateConcept: ASC_606_REVENUE_CONCEPT,
        reasons: ["not-a-superset", "disagrees-on-shared-periods"],
      },
      "nbis.canonical.revenue": { kind: "no-alternative-concept-with-facts" },
      "fpi-quarterly.canonical.revenue": { kind: "no-alternative-concept-with-facts" },
      "fpi-ifrs-semiannual.canonical.revenue": {
        kind: "no-alternative-concept-with-facts",
      },
    });
    expect(
      Object.entries(verdicts)
        .filter(([, verdict]) => verdict.kind === "alias-substitutable")
        .map(([key]) => key),
    ).toEqual([]);
    expect(Object.values(verdicts).filter((verdict) => verdict.kind === "rejected")).toHaveLength(
      1,
    );
    expect(
      Object.values(verdicts).filter(
        (verdict) => verdict.kind === "no-alternative-concept-with-facts",
      ),
    ).toHaveLength(5);

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

  test("pins at most one eligible alternative revenue concept per corpus fixture", async () => {
    const alternatives: Record<string, readonly string[] | undefined> = {};
    for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
      const execution = await runOfflineCorpusFixture(fixture);
      for (const [key, concepts] of detectEligibleRevenueAliasAlternatives(execution)) {
        alternatives[`${fixture}.${key}`] = concepts;
      }
    }
    expect(alternatives).toEqual({
      "aapl.canonical.revenue": [],
      "msft.canonical.revenue": [],
      "mara.canonical.revenue": [ASC_606_REVENUE_CONCEPT],
      "nbis.canonical.revenue": [],
      "fpi-quarterly.canonical.revenue": [],
      "fpi-ifrs-semiannual.canonical.revenue": [],
    });
    expect(Object.keys(alternatives)).toHaveLength(6);
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
    });
  });

  test("counts a newer strict-superset alias when the selected series is cap-saturated", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    const execution = syntheticAliasExecution(maraCase, "newer-alias");
    const selected = execution.projection.canonical.fundamentalHistory.revenue;
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
    expect(Object.fromEntries(detectInterchangeableAliasCandidates(execution))).toEqual({
      "canonical.revenue": {
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
      'nbis:canonical.operatingCashFlow:{"kind":"verified-cap-displaced","droppedPeriodEnds":["2011-12-31"],"newerUnionPeriods":10}',
    ]);
    expect(excluded.toSorted()).toEqual([
      "fpi-ifrs-semiannual:canonical.capex:unanchored-empty",
      "fpi-ifrs-semiannual:canonical.freeCashFlowProxy:vacuous-empty",
      "fpi-quarterly:canonical.capex:unanchored-empty",
      "fpi-quarterly:canonical.freeCashFlowProxy:vacuous-empty",
      "nbis:canonical.grossMargin:vacuous-empty",
      "nbis:canonical.grossProfit:unanchored-empty",
    ]);
    expect(maraDilutedEps).toEqual({
      kind: "verified-cap-displaced",
      droppedPeriodEnds: ["2014-12-31", "2015-12-31"],
      newerUnionPeriods: 10,
    });
  });

  test("verifies stale-total/current-continuing OCF and productive-assets-only capex", async () => {
    const aaplCase = await loadOfflineCorpusCase("aapl");
    const { payload, usGaap } = cloneCompanyFactsWithMutableUsGaap(
      aaplCase.execution.input.companyFacts,
    );
    const totalOcf = usGaap.NetCashProvidedByUsedInOperatingActivities;
    const ppe = usGaap.PaymentsToAcquirePropertyPlantAndEquipment;
    if (!isRecord(totalOcf) || !isRecord(totalOcf.units) || !Array.isArray(totalOcf.units.USD)) {
      throw new Error("AAPL fixture is missing USD operating cash flow facts");
    }
    usGaap.NetCashProvidedByUsedInOperatingActivitiesContinuingOperations =
      structuredClone(totalOcf);
    totalOcf.units.USD = totalOcf.units.USD.filter(
      (fact) => isRecord(fact) && typeof fact.end === "string" && fact.end <= "2023-12-31",
    );
    usGaap.PaymentsToAcquireProductiveAssets = ppe;
    delete usGaap.PaymentsToAcquirePropertyPlantAndEquipment;
    const { execution } = mutateOfflineCorpusCase(aaplCase, { input: { companyFacts: payload } });
    const verdicts = verifyHistoryAnnualRosters(execution);

    const history = execution.projection.canonical.fundamentalHistory;
    expect(history.operatingCashFlow?.concept).toBe(
      "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    );
    expect(history.capex?.concept).toBe("PaymentsToAcquireProductiveAssets");
    for (const key of ["operatingCashFlow", "capex", "freeCashFlowProxy"]) {
      expect(verdicts.get(`canonical.${key}`)?.kind).toMatch(/^verified-/u);
    }
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

  test("catches consistently truncated NBIS net-margin history", async () => {
    const nbisCase = await loadOfflineCorpusCase("nbis");
    const { netMargin } = nbisCase.execution.projection.canonical.fundamentalHistory;
    const annual = netMargin?.annual.slice(-2);
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
    });

    expect(netMargin.annual).toHaveLength(3);
    expect(annual).toHaveLength(2);
    expect(marginChange.percentagePoints).toBeCloseTo(386.55, 2);
    expect(marginChange.years).toBeCloseTo(1, 2);
    const verdict = verifyHistoryAnnualRosters(mutated.execution).get("canonical.netMargin");
    expect(verdict?.kind).toBe("failed");
    if (verdict?.kind !== "failed") {
      throw new Error("Truncated NBIS net-margin roster was not rejected");
    }
    expect(verdict.reason).toContain('missingPeriodEnds=["2021-12-31"]');
  });

  test("rejects a changed NBIS net-margin value or filing date in the annual roster", async () => {
    const nbisCase = await loadOfflineCorpusCase("nbis");
    const annual = nbisCase.execution.projection.canonical.fundamentalHistory.netMargin?.annual;
    const last = annual?.at(-1);
    if (annual === undefined || last === undefined) {
      throw new Error("NBIS golden is missing net-margin history");
    }
    for (const changed of [
      { ...last, value: last.value * 1.01 },
      { ...last, filedAt: "2026-05-01" },
    ]) {
      const mutated = mutateOfflineCorpusCase(nbisCase, {
        mutations: [
          ["fundamentalHistory.netMargin.annual", "set", [...annual.slice(0, -1), changed]],
        ],
      });
      const verdict = verifyHistoryAnnualRosters(mutated.execution).get("canonical.netMargin");

      expect(verdict).toMatchObject({
        kind: "failed",
        reason: expect.stringContaining('missingPeriodEnds=["2025-12-31"]'),
      });
    }
  });

  test("catches consistently truncated NBIS revenue history", async () => {
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
    });

    expect(revenue.annual).toHaveLength(5);
    expect(annual).toHaveLength(3);
    expect(cagr.percent).toBeCloseTo(635.26, 2);
    expect(cagr.years).toBeCloseTo(2, 2);
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
    });

    expect(dilutedEps.annual).toHaveLength(8);
    expect(annual).toHaveLength(5);
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
});
