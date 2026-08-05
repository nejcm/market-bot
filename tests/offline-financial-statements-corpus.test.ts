import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { isRecord } from "../src/guards";
import {
  isFactObservableAsOf,
  periodMonths,
  readSecFactValue,
} from "../src/sources/extended-evidence/sec-edgar";
import {
  OFFLINE_FINANCIAL_STATEMENT_FIXTURES,
  auditOfflineCorpusCase,
  loadOfflineCorpusCase,
  mutateOfflineCorpusCase,
  type OfflineCorpusAllowance,
  type OfflineCorpusCase,
  type OfflineCorpusExecution,
  type OfflineCorpusMutation,
  type OfflineFinancialStatementInput,
} from "./support/offline-financial-statements-corpus";
import {
  detectEligibleRevenueAliasAlternatives,
  detectInterchangeableAliasCandidates,
  verifyHistoryAnnualRosters,
  type AliasVerdict,
  type RosterVerdict,
} from "./support/offline-financial-history-roster";
import {
  buildSyntheticAliasPayloads,
  type SyntheticAliasVariant,
} from "./support/synthetic-alias-companyfacts";
import { verifyLensAllowanceProperties } from "./support/offline-financial-lens-properties";

const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365.2425;
const ASC_606_REVENUE_CONCEPT = "RevenueFromContractWithCustomerExcludingAssessedTax";
type FixtureName = OfflineFinancialStatementInput["fixture"];

function cloneCompanyFactsWithMutableUsGaap(companyFacts: unknown): {
  readonly payload: unknown;
  readonly usGaap: Record<string, unknown>;
} {
  const payload: unknown = structuredClone(companyFacts);
  if (!isRecord(payload) || !isRecord(payload.facts) || !isRecord(payload.facts["us-gaap"])) {
    throw new Error("MARA fixture is missing us-gaap companyfacts");
  }
  return { payload, usGaap: payload.facts["us-gaap"] };
}

function eligibleMaraRevenueFacts(
  companyFacts: unknown,
  concept: string,
  analysisAsOf: string,
): readonly { readonly value: number; readonly periodEnd: string; readonly filedAt: string }[] {
  if (
    !isRecord(companyFacts) ||
    !isRecord(companyFacts.facts) ||
    !isRecord(companyFacts.facts["us-gaap"])
  ) {
    throw new Error("MARA fixture is missing us-gaap companyfacts");
  }
  const rawConcept = companyFacts.facts["us-gaap"][concept];
  if (
    !isRecord(rawConcept) ||
    !isRecord(rawConcept.units) ||
    !Array.isArray(rawConcept.units.USD)
  ) {
    throw new Error(`MARA fixture is missing USD ${concept} facts`);
  }
  const candidates = rawConcept.units.USD.flatMap((value) => {
    const fact = readSecFactValue(value);
    const months = fact === undefined ? undefined : periodMonths(fact);
    return fact?.form === "10-K" &&
      fact.end !== undefined &&
      fact.filed !== undefined &&
      months !== undefined &&
      months >= 10 &&
      months <= 14 &&
      isFactObservableAsOf(fact, analysisAsOf)
      ? [{ value: fact.val, periodEnd: fact.end, filedAt: fact.filed }]
      : [];
  });
  const byPeriodEnd = new Map<string, (typeof candidates)[number][]>();
  for (const fact of candidates) {
    byPeriodEnd.set(fact.periodEnd, [...(byPeriodEnd.get(fact.periodEnd) ?? []), fact]);
  }
  return [...byPeriodEnd.values()]
    .map((facts) => facts.toSorted((left, right) => right.filedAt.localeCompare(left.filedAt))[0]!)
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
}

function syntheticAliasExecution(
  maraCase: OfflineCorpusCase,
  variant: SyntheticAliasVariant,
): OfflineCorpusExecution {
  return mutateOfflineCorpusCase(maraCase, {
    input: { symbol: "ALIAS", ...buildSyntheticAliasPayloads(variant) },
  }).execution;
}

async function runFixture(fixture: FixtureName): Promise<OfflineCorpusExecution> {
  const corpusCase = await loadOfflineCorpusCase(fixture);
  return corpusCase.execution;
}

function yearsBetween(periodStart: string, periodEnd: string): number {
  return (Date.parse(periodEnd) - Date.parse(periodStart)) / DAY_MS / DAYS_PER_YEAR;
}

function readCanonicalPath(execution: OfflineCorpusExecution, path: string): unknown {
  let value: unknown = execution.projection.canonical;
  for (const segment of path.split(".")) {
    if (!isRecord(value)) {
      throw new Error(`Golden projection path is missing: ${path}`);
    }
    value = value[segment];
  }
  return value;
}

function requiredCanonicalNumber(execution: OfflineCorpusExecution, path: string): number {
  const value = readCanonicalPath(execution, path);
  if (typeof value !== "number") {
    throw new TypeError(`Golden projection number is missing: ${path}`);
  }
  return value;
}

function exactValueHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

function expectPreChangeLensClassifierAcceptance(
  execution: OfflineCorpusExecution,
  allowances: readonly OfflineCorpusAllowance[],
  path: string,
): void {
  const difference = execution.differences.find((item) => item.path === path);
  const allowance = allowances.find((item) => item.path === path);
  if (difference === undefined || allowance === undefined) {
    throw new Error(`Missing regenerated allowance-backed difference: ${path}`);
  }
  expect(allowance.kind).toBe("legacy-form-unsupported");
  expect(allowance.canonicalSha256).toBe(exactValueHash(difference.canonical));
  expect(allowance.legacySha256).toBe(exactValueHash(difference.legacy));
}

type ClassifierFaultScenario = readonly [
  name: string,
  fixture: FixtureName,
  mutations: readonly OfflineCorpusMutation[],
  regeneratedHashPaths: readonly string[],
  expected: RegExp,
  preChangeLensPaths?: readonly string[] | undefined,
  balanceUnchangedPath?: string,
];

function classifierPattern(prefix: string, path: string, suffix = ""): RegExp {
  return new RegExp(`${prefix}${path.replaceAll(".", String.raw`\.`)}${suffix}`, "u");
}

function expectFpiBalanceRelations(
  execution: OfflineCorpusExecution,
  injected: OfflineCorpusExecution,
  unchangedPath: string,
): void {
  const strengthPath = "financialLens.Financial Strength.metrics";
  const netDebt = requiredCanonicalNumber(execution, `${strengthPath}.netDebt.value`);
  const debtToEquity = requiredCanonicalNumber(execution, `${strengthPath}.debtToEquity.value`);
  const debt = requiredCanonicalNumber(execution, `${strengthPath}.debt.value`);
  expect(netDebt).toBe(3_120_000_000);
  expect(debt / debtToEquity).toBe(3_120_000_000);
  expect(readCanonicalPath(injected, unchangedPath)).toEqual(
    readCanonicalPath(execution, unchangedPath),
  );
}

const MARGIN_ANNUAL_PATH = "fundamentalHistory.grossMargin.annual";
const MARGIN_CHANGE_PATH = "fundamentalHistory.grossMargin.marginChange";
const FINANCIAL_STRENGTH_PATH = "financialLens.Financial Strength";

const CLASSIFIER_FAULT_SCENARIOS: readonly ClassifierFaultScenario[] = [
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
  ...(["dilutedEps", "grossMargin"] as const).map((seriesKey): ClassifierFaultScenario => {
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
  [
    "rejects a corrupted exact-period lens metric after its hash is regenerated",
    "nbis",
    [["financialLens.Quality.metrics.roa.value", "set", 999.5]],
    ["financialLens.Quality.metrics.roa"],
    classifierPattern(
      "nbis ",
      "financialLens.Quality.metrics.roa",
      " is not reproduced by financial-lens properties",
    ),
    ["financialLens.Quality.metrics.roa"],
  ],
  [
    "rejects a corrupted instant-pair lens metric after its hash is regenerated",
    "nbis",
    [
      [`${FINANCIAL_STRENGTH_PATH}.metrics.netDebt.value`, "set", -1],
      [`${FINANCIAL_STRENGTH_PATH}.posture`, "set", "criteria-supported"],
    ],
    [`${FINANCIAL_STRENGTH_PATH}.metrics.netDebt`, `${FINANCIAL_STRENGTH_PATH}.posture`],
    classifierPattern(
      "nbis ",
      `${FINANCIAL_STRENGTH_PATH}.metrics.netDebt`,
      " is not reproduced by financial-lens properties",
    ),
    [`${FINANCIAL_STRENGTH_PATH}.metrics.netDebt`, `${FINANCIAL_STRENGTH_PATH}.posture`],
  ],
  [
    "rejects a corrupted lens posture after its hash is regenerated",
    "nbis",
    [["financialLens.Growth.posture", "set", "criteria-supported"]],
    ["financialLens.Growth.posture"],
    classifierPattern(
      "nbis ",
      "financialLens.Growth.posture",
      " is not reproduced by financial-lens properties",
    ),
    ["financialLens.Growth.posture"],
  ],
  ...(["cash", "debt", "debtToEquity"] as const).map(
    (metricKey, index): ClassifierFaultScenario => {
      const path = `${FINANCIAL_STRENGTH_PATH}.metrics.${metricKey}`;
      return [
        `rejects corrupted ${metricKey} after its hash is regenerated`,
        "fpi-quarterly",
        [[`${path}.value`, "set", index + 1]],
        [path],
        classifierPattern(
          "fpi-quarterly ",
          path,
          " is not reproduced by financial-lens properties",
        ),
        [path],
      ];
    },
  ),
  ...(["netDebt", "debtToEquity"] as const).map((metricKey): ClassifierFaultScenario => {
    const path = `${FINANCIAL_STRENGTH_PATH}.metrics.${metricKey}`;
    const otherKey = metricKey === "netDebt" ? "debtToEquity" : "netDebt";
    const otherPath = `${FINANCIAL_STRENGTH_PATH}.metrics.${otherKey}`;
    return [
      `keeps coincidentally equal FPI net debt and equity relations independently discriminating (${metricKey})`,
      "fpi-quarterly",
      [[`${path}.value`, "copy", `${otherPath}.value`]],
      [path],
      classifierPattern("", path),
      undefined,
      otherPath,
    ];
  }),
];

describe("offline financial-statement corpus", () => {
  test("locks every issuer projection and classifies every consumer difference offline", async () => {
    const expectedClassifications = {
      aapl: { matched: 74, allowances: 0 },
      msft: { matched: 78, allowances: 0 },
      mara: { matched: 59, allowances: 19 },
      nbis: { matched: 37, allowances: 39 },
      "fpi-quarterly": { matched: 24, allowances: 52 },
      "fpi-ifrs-semiannual": { matched: 33, allowances: 43 },
    } as const;
    const originalFetch = globalThis.fetch;
    let networkAttempts = 0;
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        networkAttempts += 1;
        throw new Error("Offline financial-statement corpus attempted network access");
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      let classifiedAllowanceCount = 0;
      let totalAllowances = 0;
      for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
        const corpusCase = await loadOfflineCorpusCase(fixture);
        const audit = auditOfflineCorpusCase(corpusCase);

        expect(corpusCase.execution.projection).toEqual(corpusCase.golden);
        expect(audit.matchedCount).toBe(expectedClassifications[fixture].matched);
        expect(audit.allowances).toHaveLength(expectedClassifications[fixture].allowances);
        expect(audit.differences).toHaveLength(expectedClassifications[fixture].allowances);
        expect(
          Bun.file(
            new URL(`fixtures/financial-statements-corpus/${fixture}/input.json`, import.meta.url),
          ).size,
        ).toBeLessThan(250_000);
        expect(JSON.stringify(corpusCase.execution.input)).not.toMatch(
          /api[_-]?key|authorization|bearer\s|password|secret|access[_-]?token/iu,
        );
        classifiedAllowanceCount += audit.allowances.length;
        totalAllowances += corpusCase.allowances.length;
      }

      expect(classifiedAllowanceCount).toBe(totalAllowances);
      expect(networkAttempts).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses no collector, credential, network, or model seam", async () => {
    for (const path of [
      "support/offline-financial-statements-corpus.ts",
      "support/offline-financial-history-roster.ts",
      "support/synthetic-alias-companyfacts.ts",
    ]) {
      const source = await Bun.file(new URL(path, import.meta.url)).text();

      expect(source).not.toMatch(
        /financial-statements-parity|collectSources|ModelProvider|\/model\/|\.generate\(|\bfetch\(/u,
      );
      expect(source).not.toContain("process.env");
    }
  });

  test("pins the interchangeable-alias candidate set across the corpus", async () => {
    const verdicts: Record<string, AliasVerdict> = {};
    for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
      const execution = await runFixture(fixture);
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
      const execution = await runFixture(fixture);
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
      const execution = await runFixture(fixture);
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

  test("keeps MARA allowances fixture-specific and source-reproduced", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    const exactPeriodPaths = maraCase.allowances
      .filter((allowance) => allowance.kind === "canonical-exact-period-correction")
      .map((allowance) => allowance.path)
      .toSorted();

    expect(maraCase.allowances.map((allowance) => allowance.path).toSorted()).toEqual([
      "financialLens.Growth.metrics.grossProfitDeltaPercent",
      "financialLens.Growth.metrics.netIncomeDeltaPercent",
      "financialLens.Quality.metrics.cashConversion",
      "financialLens.Quality.metrics.grossMargin",
      "financialLens.Quality.metrics.netMargin",
      "financialLens.Quality.metrics.roa",
      "financialLens.Quality.metrics.roe",
      "fundamentalHistory.capex.annual",
      "fundamentalHistory.dilutedEps.annual",
      "fundamentalHistory.freeCashFlowProxy.annual",
      "fundamentalHistory.grossMargin.annual",
      "fundamentalHistory.grossMargin.marginChange",
      "fundamentalHistory.grossProfit.annual",
      "fundamentalHistory.netIncome.annual",
      "fundamentalHistory.netMargin.annual",
      "fundamentalHistory.operatingCashFlow.annual",
      "fundamentalHistory.operatingIncome.annual",
      "fundamentalHistory.operatingMargin.annual",
      "fundamentalHistory.revenue.annual",
    ]);
    expect(exactPeriodPaths).toEqual([
      "financialLens.Growth.metrics.grossProfitDeltaPercent",
      "financialLens.Growth.metrics.netIncomeDeltaPercent",
      "financialLens.Quality.metrics.cashConversion",
      "financialLens.Quality.metrics.grossMargin",
      "financialLens.Quality.metrics.netMargin",
      "financialLens.Quality.metrics.roa",
      "financialLens.Quality.metrics.roe",
    ]);
    expect(
      maraCase.execution.differences.find(
        (difference) => difference.path === "financialLens.Quality.metrics.grossMargin",
      ),
    ).toMatchObject({
      canonical: {
        value: Number("-0.28594600562193745"),
        periodEnd: "2022-12-31",
        periodMonths: 12,
      },
      legacy: null,
    });
    expect(
      maraCase.execution.differences.find(
        (difference) => difference.path === "financialLens.Quality.metrics.netMargin",
      ),
    ).toMatchObject({
      canonical: {
        value: Number("-1.445805446630059"),
        periodEnd: "2025-12-31",
        periodMonths: 12,
      },
      legacy: null,
    });
    expect(maraCase.execution.projection.statements.revenue).toMatchObject({
      selectedConcept: "Revenues",
    });
    expect(JSON.stringify(maraCase.execution.input.companyFacts)).toContain(
      "RevenueFromContractWithCustomerExcludingAssessedTax",
    );
    expect(() => auditOfflineCorpusCase(maraCase)).not.toThrow();
  });

  test("re-derives or explicitly reclassifies every history allowance", async () => {
    const cases = new Map(
      await Promise.all(
        OFFLINE_FINANCIAL_STATEMENT_FIXTURES.map(
          async (fixture) => [fixture, await loadOfflineCorpusCase(fixture)] as const,
        ),
      ),
    );
    const historyAllowances = [...cases.values()]
      .flatMap((corpusCase) => corpusCase.allowances)
      .filter((allowance) => allowance.path.startsWith("fundamentalHistory."));
    const reclassified = historyAllowances.filter(
      (allowance) => allowance.kind === "history-property-not-rederivable",
    );
    const wouldFailReDerivation = historyAllowances.filter((allowance) => {
      const [, seriesKey, field] = allowance.path.split(".");
      const { projection } = cases.get(allowance.fixture)!.execution;
      const canonical = projection.canonical.fundamentalHistory[seriesKey!];
      const legacy = projection.legacy.fundamentalHistory[seriesKey!];
      if (field === "concept") {
        return (
          typeof canonical?.concept === "string" &&
          legacy?.concept === null &&
          canonical.annual.length > 0 &&
          canonical.annual.every((point) => point.form === "20-F") &&
          legacy.annual.length === 0
        );
      }
      const series = [canonical, legacy].filter((value) => value !== undefined);
      return (
        field === "annual" &&
        series.every(
          (value) =>
            (value.cagr === null || value.cagr === undefined) &&
            (value.marginChange === null || value.marginChange === undefined),
        )
      );
    });

    expect(historyAllowances).toHaveLength(89);
    expect(historyAllowances.length - reclassified.length).toBe(61);
    expect(reclassified).toHaveLength(28);
    expect(
      reclassified.map((allowance) => `${allowance.fixture}:${allowance.path}`).toSorted(),
    ).toEqual(
      wouldFailReDerivation.map((allowance) => `${allowance.fixture}:${allowance.path}`).toSorted(),
    );
    expect(
      reclassified.every((allowance) => allowance.justification.includes("B9 cannot re-derive")),
    ).toBe(true);
    expect(
      Object.fromEntries(
        reclassified
          .map((allowance) => allowance.path.split(".").at(-1)!)
          .reduce((counts, field) => counts.set(field, (counts.get(field) ?? 0) + 1), new Map()),
      ),
    ).toEqual({ annual: 10, concept: 18 });
  });

  for (const scenario of CLASSIFIER_FAULT_SCENARIOS) {
    const [name, fixture, mutations, hashPaths, expected, lensPaths, balanceUnchangedPath] =
      scenario;
    test(name, async () => {
      const corpusCase = await loadOfflineCorpusCase(fixture);
      const mutated = mutateOfflineCorpusCase(corpusCase, {
        mutations,
        allowanceUpdates: hashPaths.map((path) => ({ path })),
      });

      if (balanceUnchangedPath !== undefined) {
        expectFpiBalanceRelations(corpusCase.execution, mutated.execution, balanceUnchangedPath);
      }
      for (const path of lensPaths ?? []) {
        expectPreChangeLensClassifierAcceptance(mutated.execution, mutated.allowances, path);
      }
      expect(() => auditOfflineCorpusCase(mutated)).toThrow(expected);
    });
  }

  test("does not permit property-bearing annual or TTM allowances to claim reclassification", async () => {
    const maraCase = await loadOfflineCorpusCase("mara");
    const overriddenMara = mutateOfflineCorpusCase(maraCase, {
      allowanceUpdates: [
        { path: "fundamentalHistory.capex.annual", kind: "history-property-not-rederivable" },
      ],
    });
    const fpiCase = await loadOfflineCorpusCase("fpi-quarterly");
    const overriddenFpi = mutateOfflineCorpusCase(fpiCase, {
      allowanceUpdates: [
        { path: "fundamentalHistory.revenue.ttm", kind: "history-property-not-rederivable" },
      ],
    });

    expect(() => auditOfflineCorpusCase(overriddenMara)).toThrow(
      /mara fundamentalHistory\.capex\.annual is not eligible for history-property reclassification/u,
    );
    expect(() => auditOfflineCorpusCase(overriddenFpi)).toThrow(
      /fpi-quarterly fundamentalHistory\.revenue\.ttm is not eligible for history-property reclassification/u,
    );
  });

  test("pins the complete canonical financial-lens metric-key inventory", async () => {
    const keys = new Set<string>();
    for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
      const execution = await runFixture(fixture);
      for (const lens of Object.values(execution.projection.canonical.financialLens)) {
        for (const key of Object.keys(lens.metrics)) {
          keys.add(key);
        }
      }
    }

    expect([...keys].toSorted()).toEqual([
      "cash",
      "cashConversion",
      "currentRatio",
      "debt",
      "debtToEquity",
      "dilutedEpsDeltaPercent",
      "freeCashFlowProxy",
      "grossMargin",
      "grossProfitDeltaPercent",
      "netDebt",
      "netIncomeDeltaPercent",
      "netMargin",
      "operatingCashFlowDeltaPercent",
      "operatingIncomeDeltaPercent",
      "operatingMargin",
      "revenueDeltaPercent",
      "roa",
      "roe",
    ]);
  });

  test("pins every allowance-backed canonical lens posture", async () => {
    const postures: string[] = [];
    for (const fixture of ["nbis", "fpi-quarterly", "fpi-ifrs-semiannual"] as const) {
      const execution = await runFixture(fixture);
      for (const lensName of ["Quality", "Growth", "Financial Strength"] as const) {
        postures.push(
          `${fixture}:${lensName}:${execution.projection.canonical.financialLens[lensName]?.posture}`,
        );
      }
    }

    expect(postures.toSorted()).toEqual([
      "fpi-ifrs-semiannual:Financial Strength:criteria-not-supported",
      "fpi-ifrs-semiannual:Growth:criteria-supported",
      "fpi-ifrs-semiannual:Quality:criteria-supported",
      "fpi-quarterly:Financial Strength:criteria-not-supported",
      "fpi-quarterly:Growth:criteria-supported",
      "fpi-quarterly:Quality:criteria-supported",
      "nbis:Financial Strength:criteria-mixed",
      "nbis:Growth:criteria-mixed",
      "nbis:Quality:criteria-mixed",
    ]);
  });

  test("fails loudly when a projected Financial Strength valuation criterion appears", async () => {
    const nbisCase = await loadOfflineCorpusCase("nbis");
    const strength = nbisCase.execution.projection.canonical.financialLens["Financial Strength"];
    if (strength === undefined) {
      throw new Error("NBIS golden is missing Financial Strength");
    }
    for (const criterion of ["netDebtToMarketCap", "debtToMarketCap", "payoutRatio"] as const) {
      const mutated = mutateOfflineCorpusCase(nbisCase, {
        mutations: [
          [
            `financialLens.Financial Strength.metrics.${criterion}`,
            "set",
            {
              key: criterion,
              label: criterion,
              value: 0.1,
              unit: "ratio",
              sourceIds: [],
            },
          ],
        ],
      });
      const path = "financialLens.Financial Strength.posture";
      const allowance = mutated.allowances.find((item) => item.path === path);
      const difference = mutated.execution.differences.find((item) => item.path === path);
      if (allowance === undefined || difference === undefined) {
        throw new Error("NBIS Financial Strength posture allowance is missing");
      }

      expect(() => verifyLensAllowanceProperties(mutated.execution, allowance, difference)).toThrow(
        new RegExp(`Financial Strength projected metrics unexpectedly contain ${criterion}`, "u"),
      );
    }
  });

  test("fails loudly when Financial Strength receives valuation net-debt input", async () => {
    const nbisCase = await loadOfflineCorpusCase("nbis");
    const mutated = mutateOfflineCorpusCase(nbisCase, {
      mutations: [
        [`${FINANCIAL_STRENGTH_PATH}.metrics.netDebt.value`, "set", -1],
        [`${FINANCIAL_STRENGTH_PATH}.posture`, "set", "criteria-supported"],
      ],
    });
    const valuationCoupled = {
      ...mutated.execution,
      canonicalFinancialLensInputCategories: ["sec-edgar", "valuation"],
    };
    const path = "financialLens.Financial Strength.posture";
    const allowance = mutated.allowances.find((item) => item.path === path);
    const difference = mutated.execution.differences.find((item) => item.path === path);
    if (allowance === undefined || difference === undefined) {
      throw new Error("NBIS Financial Strength posture allowance is missing");
    }

    expect(() => verifyLensAllowanceProperties(valuationCoupled, allowance, difference)).toThrow(
      /Financial Strength unexpectedly received valuation input/u,
    );
  });

  test("property-verifies all 64 financial-lens allowances and fails closed", async () => {
    const cases = new Map(
      await Promise.all(
        OFFLINE_FINANCIAL_STATEMENT_FIXTURES.map(
          async (fixture) => [fixture, await loadOfflineCorpusCase(fixture)] as const,
        ),
      ),
    );
    const lensAllowances = [...cases.values()]
      .flatMap((corpusCase) => corpusCase.allowances)
      .filter((allowance) => allowance.path.startsWith("financialLens."));
    const failed = lensAllowances.flatMap((allowance) => {
      const corpusCase = cases.get(allowance.fixture);
      const difference = corpusCase?.execution.differences.find(
        (item) => item.path === allowance.path,
      );
      return corpusCase === undefined ||
        difference === undefined ||
        !verifyLensAllowanceProperties(corpusCase.execution, allowance, difference)
        ? [`${allowance.fixture}:${allowance.path}`]
        : [];
    });
    const nbisCase = cases.get("nbis");
    const sampleAllowance = lensAllowances.find((allowance) => allowance.fixture === "nbis");
    if (nbisCase === undefined || sampleAllowance === undefined) {
      throw new Error("NBIS financial-lens allowance is missing");
    }

    expect(lensAllowances).toHaveLength(64);
    expect(failed).toEqual([]);
    expect(
      verifyLensAllowanceProperties(
        nbisCase.execution,
        { ...sampleAllowance, path: "financialLens.Quality.metrics.unknownMetric" },
        {
          path: "financialLens.Quality.metrics.unknownMetric",
          canonical: { value: 1, periodEnd: "2025-12-31" },
          legacy: null,
        },
      ),
    ).toBeFalse();
    expect(
      verifyLensAllowanceProperties(
        nbisCase.execution,
        { ...sampleAllowance, path: "financialLens.Unknown.posture" },
        { path: "financialLens.Unknown.posture", canonical: "criteria-supported", legacy: null },
      ),
    ).toBeFalse();
  });

  test("rejects dumping an unsupported concept shape into the reclassification bucket", async () => {
    const msftCase = await loadOfflineCorpusCase("msft");
    const { revenue } = msftCase.execution.projection.canonical.fundamentalHistory;
    if (revenue === undefined) {
      throw new Error("MSFT golden is missing revenue history");
    }
    const mutated = mutateOfflineCorpusCase(msftCase, {
      mutations: [["fundamentalHistory.revenue.concept", "set", "InjectedConcept"]],
      allowanceUpdates: [
        {
          path: "fundamentalHistory.revenue.concept",
          kind: "history-property-not-rederivable",
          justification: "Injected concept bucket probe",
        },
      ],
    });

    expect(() => auditOfflineCorpusCase(mutated)).toThrow(
      /msft fundamentalHistory\.revenue\.concept is not eligible for history-property reclassification/u,
    );
  });

  test("fires the test-only comparator alarm on an injected ROE mismatch", async () => {
    const msftCase = await loadOfflineCorpusCase("msft");
    const quality = msftCase.execution.projection.canonical.financialLens.Quality;
    const roe = quality?.metrics.roe;
    if (quality === undefined || roe === undefined || typeof roe.value !== "number") {
      throw new Error("MSFT golden is missing canonical ROE");
    }
    const mutated = mutateOfflineCorpusCase(msftCase, {
      mutations: [["financialLens.Quality.metrics.roe.value", "add-cent"]],
    });

    expect(() => auditOfflineCorpusCase(mutated)).toThrow(
      /Offline comparator alarm: unclassified msft difference financialLens\.Quality\.metrics\.roe/u,
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
});
