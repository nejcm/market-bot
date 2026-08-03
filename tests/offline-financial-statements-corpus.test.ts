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
  classifyOfflineCorpusDifferences,
  loadOfflineCorpusAllowances,
  loadOfflineCorpusGolden,
  loadOfflineFinancialStatementInput,
  recompareOfflineCorpusProjection,
  runOfflineFinancialStatementCorpus,
  type OfflineCorpusAllowance,
  type OfflineCorpusExecution,
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

function exactValueHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
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
  input: OfflineFinancialStatementInput,
  variant: SyntheticAliasVariant,
): OfflineCorpusExecution {
  return runOfflineFinancialStatementCorpus({
    ...input,
    symbol: "ALIAS",
    ...buildSyntheticAliasPayloads(variant),
  });
}

async function runFixture(fixture: FixtureName): Promise<OfflineCorpusExecution> {
  return runOfflineFinancialStatementCorpus(await loadOfflineFinancialStatementInput(fixture));
}

function yearsBetween(periodStart: string, periodEnd: string): number {
  return (Date.parse(periodEnd) - Date.parse(periodStart)) / DAY_MS / DAYS_PER_YEAR;
}

function regenerateCanonicalAllowanceHashes(
  allowances: readonly OfflineCorpusAllowance[],
  execution: OfflineCorpusExecution,
  paths: readonly string[],
): readonly OfflineCorpusAllowance[] {
  const affected = new Set(paths);
  return allowances.map((allowance) => {
    if (allowance.fixture !== execution.input.fixture || !affected.has(allowance.path)) {
      return allowance;
    }
    const changed = execution.differences.find((difference) => difference.path === allowance.path);
    if (changed === undefined) {
      throw new Error(`Injected difference is missing: ${allowance.path}`);
    }
    return { ...allowance, canonicalSha256: exactValueHash(changed.canonical) };
  });
}

type CanonicalMutation =
  | readonly [path: string, operation: "set", value: unknown]
  | readonly [path: string, operation: "copy", sourcePath: string]
  | readonly [path: string, operation: "zero-margin-last", annualPath: string]
  | readonly [
      path: string,
      operation: "negate" | "increment" | "double" | "add-cent" | "last-only",
    ];

function readCanonicalPath(execution: OfflineCorpusExecution, path: string): unknown {
  let value: unknown = execution.projection.canonical;
  for (const segment of path.split(".")) {
    if (!isRecord(value)) {
      throw new Error(`Injected projection path is missing: ${path}`);
    }
    value = value[segment];
  }
  return value;
}

function requiredCanonicalNumber(execution: OfflineCorpusExecution, path: string): number {
  const value = readCanonicalPath(execution, path);
  if (typeof value !== "number") {
    throw new TypeError(`Injected projection number is missing: ${path}`);
  }
  return value;
}

function injectCanonicalMutations(
  execution: OfflineCorpusExecution,
  mutations: readonly CanonicalMutation[],
): OfflineCorpusExecution {
  const projection = structuredClone(execution.projection);
  for (const mutation of mutations) {
    const [path, operation, operand] = mutation;
    const segments = path.split(".");
    const property = segments.pop();
    let target: unknown = projection.canonical;
    for (const segment of segments) {
      if (!isRecord(target)) {
        throw new Error(`Injected projection path is missing: ${path}`);
      }
      target = target[segment];
    }
    if (property === undefined || !isRecord(target)) {
      throw new Error(`Injected projection path is missing: ${path}`);
    }
    if (operation === "set") {
      target[property] = operand;
    } else if (operation === "copy") {
      target[property] = readCanonicalPath(execution, operand);
    } else if (operation === "last-only") {
      target[property] = [lastAnnualPoint(execution, path)];
    } else if (operation === "zero-margin-last") {
      const point = lastAnnualPoint(execution, operand);
      target[property] = {
        percentagePoints: 0,
        years: 0,
        periodStart: point.periodEnd,
        periodEnd: point.periodEnd,
      };
    } else {
      const value = requiredCanonicalNumber(execution, path);
      target[property] = {
        negate: -value,
        increment: value + 1,
        double: value * 2,
        "add-cent": value + 0.01,
      }[operation];
    }
  }
  return recompareOfflineCorpusProjection(execution, projection);
}

function expectPreChangeLensClassifierAcceptance(
  execution: OfflineCorpusExecution,
  allowances: readonly OfflineCorpusAllowance[],
  path: string,
): void {
  const difference = execution.differences.find((item) => item.path === path);
  const allowance = allowances.find(
    (item) => item.fixture === execution.input.fixture && item.path === path,
  );
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
  mutations: readonly CanonicalMutation[],
  regeneratedHashPaths: readonly string[],
  expected: RegExp,
  preChangeLensPaths?: readonly string[] | undefined,
  balanceUnchangedPath?: string,
];

function lastAnnualPoint(execution: OfflineCorpusExecution, path: string): Record<string, unknown> {
  const annual = readCanonicalPath(execution, path);
  const point = Array.isArray(annual) ? annual.at(-1) : undefined;
  if (!isRecord(point) || typeof point.periodEnd !== "string") {
    throw new Error(`Golden is missing annual history: ${path}`);
  }
  return point;
}

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
    const allowances = await loadOfflineCorpusAllowances();
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
      for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
        const input = await loadOfflineFinancialStatementInput(fixture);
        const execution = runOfflineFinancialStatementCorpus(input);
        const golden = await loadOfflineCorpusGolden(fixture);
        const classification = classifyOfflineCorpusDifferences(execution, allowances);

        expect(execution.projection).toEqual(golden);
        expect(classification.matchedCount).toBe(expectedClassifications[fixture].matched);
        expect(classification.allowances).toHaveLength(expectedClassifications[fixture].allowances);
        expect(execution.differences).toHaveLength(expectedClassifications[fixture].allowances);
        expect(
          Bun.file(
            new URL(`fixtures/financial-statements-corpus/${fixture}/input.json`, import.meta.url),
          ).size,
        ).toBeLessThan(250_000);
        expect(JSON.stringify(input)).not.toMatch(
          /api[_-]?key|authorization|bearer\s|password|secret|access[_-]?token/iu,
        );
        classifiedAllowanceCount += classification.allowances.length;
      }

      expect(classifiedAllowanceCount).toBe(allowances.length);
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

    const input = await loadOfflineFinancialStatementInput("mara");
    const revenues = eligibleMaraRevenueFacts(input.companyFacts, "Revenues", input.analysisAsOf);
    const contractRevenue = eligibleMaraRevenueFacts(
      input.companyFacts,
      ASC_606_REVENUE_CONCEPT,
      input.analysisAsOf,
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
      const execution = runOfflineFinancialStatementCorpus(
        await loadOfflineFinancialStatementInput(fixture),
      );
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
    const input = await loadOfflineFinancialStatementInput("mara");
    expect(
      Object.fromEntries(
        detectInterchangeableAliasCandidates(syntheticAliasExecution(input, "alias")),
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
    const input = await loadOfflineFinancialStatementInput("mara");
    const execution = syntheticAliasExecution(input, "newer-alias");
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
    const input = await loadOfflineFinancialStatementInput("mara");
    expect(
      Object.fromEntries(
        detectInterchangeableAliasCandidates(syntheticAliasExecution(input, "component")),
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
        detectInterchangeableAliasCandidates(syntheticAliasExecution(input, "renamed-disjoint")),
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
      const execution = runOfflineFinancialStatementCorpus(
        await loadOfflineFinancialStatementInput(fixture),
      );
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
    const input = await loadOfflineFinancialStatementInput("mara");
    const execution = runOfflineFinancialStatementCorpus(input);
    const { payload, usGaap } = cloneCompanyFactsWithMutableUsGaap(input.companyFacts);
    delete usGaap.Revenues;
    delete usGaap.SalesRevenueNet;
    const substituted = runOfflineFinancialStatementCorpus({ ...input, companyFacts: payload });
    const substitutedHistory = substituted.projection.legacy.fundamentalHistory;
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
    const input = await loadOfflineFinancialStatementInput("mara");
    const { payload, usGaap } = cloneCompanyFactsWithMutableUsGaap(input.companyFacts);
    const revenues = usGaap.Revenues;
    if (!isRecord(revenues) || !isRecord(revenues.units) || !Array.isArray(revenues.units.USD)) {
      throw new Error("MARA fixture is missing USD Revenues facts");
    }
    revenues.units.USD = revenues.units.USD.filter(
      (fact) => isRecord(fact) && typeof fact.end === "string" && fact.end <= "2024-12-31",
    );
    const execution = runOfflineFinancialStatementCorpus({ ...input, companyFacts: payload });
    const { payload: staleOnlyPayload, usGaap: staleOnlyUsGaap } =
      cloneCompanyFactsWithMutableUsGaap(payload);
    delete staleOnlyUsGaap[ASC_606_REVENUE_CONCEPT];
    delete staleOnlyUsGaap.SalesRevenueNet;
    delete staleOnlyUsGaap.RevenueFromContractWithCustomerIncludingAssessedTax;
    const staleOnly = runOfflineFinancialStatementCorpus({
      ...input,
      companyFacts: staleOnlyPayload,
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
    const execution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("nbis"),
    );
    const { revenue } = execution.projection.canonical.fundamentalHistory;
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
    const injected = injectCanonicalMutations(execution, [
      ["fundamentalHistory.revenue.annual", "set", [corrupted, ...revenue.annual.slice(1)]],
    ]);

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
    const allowances = await loadOfflineCorpusAllowances();
    const execution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("nbis"),
    );
    const { netMargin } = execution.projection.canonical.fundamentalHistory;
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
    const injected = injectCanonicalMutations(execution, [
      ["fundamentalHistory.netMargin.annual", "set", annual],
      ["fundamentalHistory.netMargin.marginChange", "set", marginChange],
    ]);
    const regeneratedAllowances = regenerateCanonicalAllowanceHashes(allowances, injected, [
      "fundamentalHistory.netMargin.annual",
      "fundamentalHistory.netMargin.marginChange",
    ]);

    expect(netMargin.annual).toHaveLength(5);
    expect(annual).toHaveLength(3);
    expect(marginChange.percentagePoints).toBeCloseTo(-2446.67, 2);
    expect(marginChange.years).toBeCloseTo(2.001, 3);
    expect(() => classifyOfflineCorpusDifferences(injected, regeneratedAllowances)).not.toThrow();
    const verdict = verifyHistoryAnnualRosters(injected).get("canonical.netMargin");
    expect(verdict?.kind).toBe("failed");
    if (verdict?.kind !== "failed") {
      throw new Error("Truncated NBIS net-margin roster was not rejected");
    }
    expect(verdict.reason).toContain('missingPeriodEnds=["2021-12-31","2022-12-31"]');
  });

  test("catches consistently truncated NBIS revenue history after hashes are regenerated", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const execution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("nbis"),
    );
    const { revenue } = execution.projection.canonical.fundamentalHistory;
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
    const injected = injectCanonicalMutations(execution, [
      ["fundamentalHistory.revenue.annual", "set", annual],
      ["fundamentalHistory.revenue.cagr", "set", cagr],
    ]);
    const regeneratedAllowances = regenerateCanonicalAllowanceHashes(allowances, injected, [
      "fundamentalHistory.revenue.annual",
      "fundamentalHistory.revenue.cagr",
    ]);

    expect(revenue.annual).toHaveLength(5);
    expect(annual).toHaveLength(3);
    expect(cagr.percent).toBeCloseTo(634.23, 2);
    expect(cagr.years).toBeCloseTo(2, 2);
    expect(() => classifyOfflineCorpusDifferences(injected, regeneratedAllowances)).not.toThrow();
    const verdict = verifyHistoryAnnualRosters(injected).get("canonical.revenue");
    expect(verdict?.kind).toBe("failed");
    if (verdict?.kind !== "failed") {
      throw new Error("Truncated NBIS revenue roster was not rejected");
    }
    expect(verdict.reason).toContain('missingPeriodEnds=["2021-12-31","2022-12-31"]');
  });

  test("catches MARA diluted-EPS truncation beyond legitimate joint-cap displacement", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const execution = await runFixture("mara");
    const { dilutedEps } = execution.projection.canonical.fundamentalHistory;
    const annual = dilutedEps?.annual.slice(-5);
    if (dilutedEps === undefined || annual === undefined) {
      throw new Error("MARA golden is missing diluted-EPS history");
    }
    const injected = injectCanonicalMutations(execution, [
      ["fundamentalHistory.dilutedEps.annual", "set", annual],
    ]);
    const regeneratedAllowances = regenerateCanonicalAllowanceHashes(allowances, injected, [
      "fundamentalHistory.dilutedEps.annual",
    ]);

    expect(dilutedEps.annual).toHaveLength(8);
    expect(annual).toHaveLength(5);
    expect(() => classifyOfflineCorpusDifferences(injected, regeneratedAllowances)).not.toThrow();
    const verdict = verifyHistoryAnnualRosters(injected).get("canonical.dilutedEps");
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
    const allowances = await loadOfflineCorpusAllowances();
    const execution = runOfflineFinancialStatementCorpus(
      await loadOfflineFinancialStatementInput("mara"),
    );
    const maraAllowances = allowances.filter((allowance) => allowance.fixture === "mara");
    const exactPeriodPaths = maraAllowances
      .filter((allowance) => allowance.kind === "canonical-exact-period-correction")
      .map((allowance) => allowance.path)
      .toSorted();

    expect(maraAllowances.map((allowance) => allowance.path).toSorted()).toEqual([
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
      execution.differences.find(
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
      execution.differences.find(
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
    expect(execution.projection.statements.revenue).toMatchObject({
      selectedConcept: "Revenues",
    });
    expect(JSON.stringify(execution.input.companyFacts)).toContain(
      "RevenueFromContractWithCustomerExcludingAssessedTax",
    );
    expect(() => classifyOfflineCorpusDifferences(execution, allowances)).not.toThrow();
  });

  test("re-derives or explicitly reclassifies every history allowance", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const historyAllowances = allowances.filter((allowance) =>
      allowance.path.startsWith("fundamentalHistory."),
    );
    const projections = new Map(
      await Promise.all(
        OFFLINE_FINANCIAL_STATEMENT_FIXTURES.map(async (fixture) => {
          const { projection } = await runFixture(fixture);
          return [fixture, projection] as const;
        }),
      ),
    );
    const reclassified = historyAllowances.filter(
      (allowance) => allowance.kind === "history-property-not-rederivable",
    );
    const wouldFailReDerivation = historyAllowances.filter((allowance) => {
      const [, seriesKey, field] = allowance.path.split(".");
      const projection = projections.get(allowance.fixture)!;
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
      const allowances = await loadOfflineCorpusAllowances();
      const execution = await runFixture(fixture);
      const injected = injectCanonicalMutations(execution, mutations);
      const regenerated = regenerateCanonicalAllowanceHashes(allowances, injected, hashPaths);

      if (balanceUnchangedPath !== undefined) {
        expectFpiBalanceRelations(execution, injected, balanceUnchangedPath);
      }
      for (const path of lensPaths ?? []) {
        expectPreChangeLensClassifierAcceptance(injected, regenerated, path);
      }
      expect(() => classifyOfflineCorpusDifferences(injected, regenerated)).toThrow(expected);
    });
  }

  test("does not permit property-bearing annual or TTM allowances to claim reclassification", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const maraExecution = await runFixture("mara");
    const invalidMaraAllowances = allowances.map((allowance) =>
      allowance.fixture === "mara" && allowance.path === "fundamentalHistory.capex.annual"
        ? { ...allowance, kind: "history-property-not-rederivable" as const }
        : allowance,
    );
    const fpiExecution = await runFixture("fpi-quarterly");
    const invalidFpiAllowances = allowances.map((allowance) =>
      allowance.fixture === "fpi-quarterly" && allowance.path === "fundamentalHistory.revenue.ttm"
        ? { ...allowance, kind: "history-property-not-rederivable" as const }
        : allowance,
    );

    expect(() => classifyOfflineCorpusDifferences(maraExecution, invalidMaraAllowances)).toThrow(
      /mara fundamentalHistory\.capex\.annual is not eligible for history-property reclassification/u,
    );
    expect(() => classifyOfflineCorpusDifferences(fpiExecution, invalidFpiAllowances)).toThrow(
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
    const allowances = await loadOfflineCorpusAllowances();
    const execution = await runFixture("nbis");
    const strength = execution.projection.canonical.financialLens["Financial Strength"];
    if (strength === undefined) {
      throw new Error("NBIS golden is missing Financial Strength");
    }
    for (const criterion of ["netDebtToMarketCap", "debtToMarketCap", "payoutRatio"] as const) {
      const injected = injectCanonicalMutations(execution, [
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
      ]);
      const path = "financialLens.Financial Strength.posture";
      const allowance = allowances.find((item) => item.fixture === "nbis" && item.path === path);
      const difference = injected.differences.find((item) => item.path === path);
      if (allowance === undefined || difference === undefined) {
        throw new Error("NBIS Financial Strength posture allowance is missing");
      }

      expect(() => verifyLensAllowanceProperties(injected, allowance, difference)).toThrow(
        new RegExp(`Financial Strength projected metrics unexpectedly contain ${criterion}`, "u"),
      );
    }
  });

  test("fails loudly when Financial Strength receives valuation net-debt input", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const execution = await runFixture("nbis");
    const injected = injectCanonicalMutations(execution, [
      [`${FINANCIAL_STRENGTH_PATH}.metrics.netDebt.value`, "set", -1],
      [`${FINANCIAL_STRENGTH_PATH}.posture`, "set", "criteria-supported"],
    ]);
    const valuationCoupled = {
      ...injected,
      canonicalFinancialLensInputCategories: ["sec-edgar", "valuation"],
    };
    const path = "financialLens.Financial Strength.posture";
    const allowance = allowances.find((item) => item.fixture === "nbis" && item.path === path);
    const difference = injected.differences.find((item) => item.path === path);
    if (allowance === undefined || difference === undefined) {
      throw new Error("NBIS Financial Strength posture allowance is missing");
    }

    expect(() => verifyLensAllowanceProperties(valuationCoupled, allowance, difference)).toThrow(
      /Financial Strength unexpectedly received valuation input/u,
    );
  });

  test("property-verifies all 64 financial-lens allowances and fails closed", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const lensAllowances = allowances.filter((allowance) =>
      allowance.path.startsWith("financialLens."),
    );
    const executions = new Map(
      await Promise.all(
        OFFLINE_FINANCIAL_STATEMENT_FIXTURES.map(
          async (fixture) => [fixture, await runFixture(fixture)] as const,
        ),
      ),
    );
    const failed = lensAllowances.flatMap((allowance) => {
      const execution = executions.get(allowance.fixture);
      const difference = execution?.differences.find((item) => item.path === allowance.path);
      return execution === undefined ||
        difference === undefined ||
        !verifyLensAllowanceProperties(execution, allowance, difference)
        ? [`${allowance.fixture}:${allowance.path}`]
        : [];
    });
    const nbisExecution = executions.get("nbis");
    const sampleAllowance = lensAllowances.find((allowance) => allowance.fixture === "nbis");
    if (nbisExecution === undefined || sampleAllowance === undefined) {
      throw new Error("NBIS financial-lens allowance is missing");
    }

    expect(lensAllowances).toHaveLength(64);
    expect(failed).toEqual([]);
    expect(
      verifyLensAllowanceProperties(
        nbisExecution,
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
        nbisExecution,
        { ...sampleAllowance, path: "financialLens.Unknown.posture" },
        { path: "financialLens.Unknown.posture", canonical: "criteria-supported", legacy: null },
      ),
    ).toBeFalse();
  });

  test("rejects dumping an unsupported concept shape into the reclassification bucket", async () => {
    const execution = await runFixture("msft");
    const { revenue } = execution.projection.canonical.fundamentalHistory;
    if (revenue === undefined) {
      throw new Error("MSFT golden is missing revenue history");
    }
    const injected = injectCanonicalMutations(execution, [
      ["fundamentalHistory.revenue.concept", "set", "InjectedConcept"],
    ]);
    const changed = injected.differences.find(
      (difference) => difference.path === "fundamentalHistory.revenue.concept",
    );
    if (changed === undefined) {
      throw new Error("Injected MSFT revenue concept difference is missing");
    }
    const dumpedAllowance = {
      fixture: "msft" as const,
      path: changed.path,
      canonicalSha256: exactValueHash(changed.canonical),
      legacySha256: exactValueHash(changed.legacy),
      kind: "history-property-not-rederivable" as const,
      justification: "Injected concept bucket probe",
    };

    expect(() => classifyOfflineCorpusDifferences(injected, [dumpedAllowance])).toThrow(
      /msft fundamentalHistory\.revenue\.concept is not eligible for history-property reclassification/u,
    );
  });

  test("fires the test-only comparator alarm on an injected ROE mismatch", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const execution = await runFixture("msft");
    const quality = execution.projection.canonical.financialLens.Quality;
    const roe = quality?.metrics.roe;
    if (quality === undefined || roe === undefined || typeof roe.value !== "number") {
      throw new Error("MSFT golden is missing canonical ROE");
    }
    const injected = injectCanonicalMutations(execution, [
      ["financialLens.Quality.metrics.roe.value", "add-cent"],
    ]);

    expect(() => classifyOfflineCorpusDifferences(injected, allowances)).toThrow(
      /Offline comparator alarm: unclassified msft difference financialLens\.Quality\.metrics\.roe/u,
    );
  });

  test("rejects the original truncated-history defect on an allowance-backed path", async () => {
    const allowances = await loadOfflineCorpusAllowances();
    const maraExecution = await runFixture("mara");
    const msftExecution = await runFixture("msft");
    const { grossMargin: maraGrossMargin } = maraExecution.projection.canonical.fundamentalHistory;
    const { grossMargin: msftGrossMargin } = msftExecution.projection.canonical.fundamentalHistory;
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
    expect(allowances).toContainEqual(
      expect.objectContaining({
        fixture: "mara",
        path: "fundamentalHistory.grossMargin.annual",
      }),
    );
    expect(allowances).toContainEqual(
      expect.objectContaining({
        fixture: "mara",
        path: "fundamentalHistory.grossMargin.marginChange",
      }),
    );
    expect(() => classifyOfflineCorpusDifferences(maraExecution, allowances)).not.toThrow();

    const injectedMarginChange = {
      percentagePoints: (last.value - first.value) * 100,
      years:
        (Date.parse(last.periodEnd) - Date.parse(first.periodEnd)) /
        (365.2425 * 24 * 60 * 60 * 1000),
      periodStart: first.periodEnd,
      periodEnd: last.periodEnd,
    };
    const injected = injectCanonicalMutations(maraExecution, [
      [MARGIN_ANNUAL_PATH, "set", annual],
      [MARGIN_CHANGE_PATH, "set", injectedMarginChange],
    ]);

    expect(originalMarginChange.percentagePoints).toBeCloseTo(3.42, 2);
    expect(originalMarginChange.years).toBeCloseTo(9, 2);
    expect(injectedMarginChange.percentagePoints).toBeCloseTo(-0.46, 2);
    expect(injectedMarginChange.years).toBeCloseTo(4, 2);
    expect(() => classifyOfflineCorpusDifferences(injected, allowances)).toThrow(
      /Offline comparator alarm: unclassified mara difference/u,
    );
  });
});
