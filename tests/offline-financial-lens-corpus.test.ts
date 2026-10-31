import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { isRecord } from "../src/guards";
import {
  OFFLINE_FINANCIAL_STATEMENT_FIXTURES,
  auditOfflineCorpusCase,
  loadOfflineCorpusCase,
  mutateOfflineCorpusCase,
  type OfflineCorpusAllowance,
  type OfflineCorpusExecution,
  type OfflineCorpusMutation,
} from "./support/offline-financial-statements-corpus";
import { verifyLensAllowanceProperties } from "./support/offline-financial-lens-properties";
import { verifyHistoryAnnualRosters } from "./support/offline-financial-history-roster";
import {
  classifierPattern,
  countNetworkAttemptsDuring,
  runOfflineCorpusFixture,
  type OfflineCorpusFixtureName,
} from "./support/offline-corpus-test-helpers";
import { cloneCompanyFactsWithMutableUsGaap } from "./support/offline-financial-history-fixtures";

const FINANCIAL_STRENGTH_PATH = "financialLens.Financial Strength";

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

function expectFpiBalanceRelations(
  execution: OfflineCorpusExecution,
  injected: OfflineCorpusExecution,
  unchangedPath: string,
): void {
  const strengthPath = `${FINANCIAL_STRENGTH_PATH}.metrics`;
  const netDebt = requiredCanonicalNumber(execution, `${strengthPath}.netDebt.value`);
  const debtToEquity = requiredCanonicalNumber(execution, `${strengthPath}.debtToEquity.value`);
  const debt = requiredCanonicalNumber(execution, `${strengthPath}.debt.value`);
  expect(netDebt).toBe(3_120_000_000);
  expect(debt / debtToEquity).toBe(3_120_000_000);
  expect(readCanonicalPath(injected, unchangedPath)).toEqual(
    readCanonicalPath(execution, unchangedPath),
  );
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

type LensClassifierFaultScenario = readonly [
  name: string,
  fixture: OfflineCorpusFixtureName,
  mutations: readonly OfflineCorpusMutation[],
  regeneratedHashPaths: readonly string[],
  expected: RegExp,
  preChangeLensPaths?: readonly string[] | undefined,
  balanceUnchangedPath?: string,
];

const LENS_CLASSIFIER_FAULT_SCENARIOS: readonly LensClassifierFaultScenario[] = [
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
    "fpi-quarterly",
    [
      [`${FINANCIAL_STRENGTH_PATH}.metrics.netDebt.value`, "set", -1],
      [`${FINANCIAL_STRENGTH_PATH}.posture`, "set", "criteria-supported"],
    ],
    [`${FINANCIAL_STRENGTH_PATH}.metrics.netDebt`, `${FINANCIAL_STRENGTH_PATH}.posture`],
    classifierPattern(
      "fpi-quarterly ",
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
    (metricKey, index): LensClassifierFaultScenario => {
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
  ...(["netDebt", "debtToEquity"] as const).map((metricKey): LensClassifierFaultScenario => {
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

describe("offline financial-statement corpus — financial-lens properties and classifier faults", () => {
  test("keeps financial-lens fault-injection fixtures offline", async () => {
    const networkAttempts = await countNetworkAttemptsDuring(async () => {
      for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
        await runOfflineCorpusFixture(fixture);
      }
      const nbisCase = await loadOfflineCorpusCase("nbis");
      const mutated = mutateOfflineCorpusCase(nbisCase, {
        mutations: [["financialLens.Quality.metrics.roa.value", "set", 999.5]],
      });
      const path = "financialLens.Quality.metrics.roa";
      const allowance = mutated.allowances.find((item) => item.path === path);
      const difference = mutated.execution.differences.find((item) => item.path === path);
      if (allowance !== undefined && difference !== undefined) {
        verifyLensAllowanceProperties(mutated.execution, allowance, difference);
      }
      try {
        auditOfflineCorpusCase(mutated);
      } catch {
        // Expected: this fault injection intentionally trips the comparator alarm.
      }
    });

    expect(networkAttempts).toBe(0);
  });

  test("pins the complete canonical financial-lens metric-key inventory", async () => {
    const keys = new Set<string>();
    for (const fixture of OFFLINE_FINANCIAL_STATEMENT_FIXTURES) {
      const execution = await runOfflineCorpusFixture(fixture);
      for (const lens of Object.values(execution.projection.canonical.financialLens)) {
        for (const key of Object.keys(lens.metrics)) {
          keys.add(key);
        }
      }
    }

    expect([...keys].toSorted()).toEqual([
      "capexDeltaPercent",
      "cash",
      "cashConversion",
      "consolidatedNetIncome",
      "continuingIncomeDeltaPercent",
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
      const execution = await runOfflineCorpusFixture(fixture);
      for (const lensName of ["Quality", "Growth", "Financial Strength"] as const) {
        postures.push(
          `${fixture}:${lensName}:${execution.projection.canonical.financialLens[lensName]?.posture}`,
        );
      }
    }

    expect(postures.toSorted()).toEqual([
      "fpi-ifrs-semiannual:Financial Strength:insufficient-data",
      "fpi-ifrs-semiannual:Growth:criteria-supported",
      "fpi-ifrs-semiannual:Quality:criteria-supported",
      "fpi-quarterly:Financial Strength:criteria-not-supported",
      "fpi-quarterly:Growth:criteria-supported",
      "fpi-quarterly:Quality:criteria-supported",
      "nbis:Financial Strength:insufficient-data",
      "nbis:Growth:criteria-mixed",
      "nbis:Quality:criteria-mixed",
    ]);
  });

  test("fails loudly when a projected Financial Strength valuation criterion appears", async () => {
    const fpiCase = await loadOfflineCorpusCase("fpi-quarterly");
    const strength = fpiCase.execution.projection.canonical.financialLens["Financial Strength"];
    if (strength === undefined) {
      throw new Error("FPI golden is missing Financial Strength");
    }
    for (const criterion of ["netDebtToMarketCap", "debtToMarketCap", "payoutRatio"] as const) {
      const mutated = mutateOfflineCorpusCase(fpiCase, {
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
        throw new Error("FPI Financial Strength posture allowance is missing");
      }

      expect(() => verifyLensAllowanceProperties(mutated.execution, allowance, difference)).toThrow(
        new RegExp(`Financial Strength projected metrics unexpectedly contain ${criterion}`, "u"),
      );
    }
  });

  test("fails loudly when Financial Strength receives valuation net-debt input", async () => {
    const fpiCase = await loadOfflineCorpusCase("fpi-quarterly");
    const mutated = mutateOfflineCorpusCase(fpiCase, {
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
      throw new Error("FPI Financial Strength posture allowance is missing");
    }

    expect(() => verifyLensAllowanceProperties(valuationCoupled, allowance, difference)).toThrow(
      /Financial Strength unexpectedly received valuation input/u,
    );
  });

  test("property-verifies all 69 financial-lens allowances and fails closed", async () => {
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

    expect(lensAllowances).toHaveLength(69);
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
    const maraCase = cases.get("mara")!;
    const consolidatedPath = "financialLens.Quality.metrics.consolidatedNetIncome";
    const consolidatedAllowance = maraCase.allowances.find(
      (allowance) => allowance.path === consolidatedPath,
    )!;
    for (const canonical of [
      { value: -1_311_480_000, periodEnd: "2025-12-31" },
      { value: -1_262_397_000, periodEnd: "2026-03-31" },
    ]) {
      expect(
        verifyLensAllowanceProperties(maraCase.execution, consolidatedAllowance, {
          path: consolidatedPath,
          canonical,
          legacy: null,
        }),
      ).toBeFalse();
    }
  });

  for (const scenario of LENS_CLASSIFIER_FAULT_SCENARIOS) {
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
});

test("the offline corpus uses statements and withholds MARA cash conversion without a latest-period partner", async () => {
  const { execution } = await loadOfflineCorpusCase("mara");
  const quality = execution.projection.canonical.financialLens.Quality;
  expect(quality?.metrics.cashConversion).toBeUndefined();
});

test("offline lens allowances reject a forged currency even after its hash is regenerated", async () => {
  const corpusCase = await loadOfflineCorpusCase("aapl");
  const path = "financialLens.Financial Strength.metrics.cash";
  const mutated = mutateOfflineCorpusCase(corpusCase, {
    mutations: [[`${path}.currency`, "set", "CAD"]],
    allowanceUpdates: [{ path }],
  });
  expect(() => auditOfflineCorpusCase(mutated)).toThrow(
    /not reproduced by financial-lens properties/u,
  );
});

test("offline lens net-margin oracle rejects parent continuing income when ProfitLoss differs from NetIncomeLoss", async () => {
  const maraCase = await loadOfflineCorpusCase("mara");
  const { payload, usGaap } = cloneCompanyFactsWithMutableUsGaap(
    maraCase.execution.input.companyFacts,
  );
  usGaap.IncomeLossFromContinuingOperations = structuredClone(usGaap.NetIncomeLoss);
  const { execution } = mutateOfflineCorpusCase(maraCase, { input: { companyFacts: payload } });
  const path = "financialLens.Quality.metrics.netMargin";
  const allowance = maraCase.allowances.find((item) => item.path === path)!;
  const { canonical } = maraCase.execution.differences.find((item) => item.path === path)!;
  if (!isRecord(canonical) || typeof canonical.value !== "number") {
    throw new Error("MARA golden is missing canonical net margin");
  }
  // MARA FY2025: ProfitLoss -1,311.892M, NetIncomeLoss -1,311.480M; parent-only continuing income with NCI evidence is withheld.
  const parentRatio = (canonical.value * 1_311_480_000) / 1_311_892_000;
  const verdict = (value: number) =>
    verifyLensAllowanceProperties(execution, allowance, {
      path,
      canonical: { ...canonical, value },
      legacy: null,
    });

  expect(execution.projection.canonical.financialLens.Quality?.metrics.netMargin).toBeUndefined();
  expect(
    verifyLensAllowanceProperties(maraCase.execution, allowance, { path, canonical, legacy: null }),
  ).toBeTrue();
  expect(verdict(parentRatio)).toBeFalse();
  expect(verdict(canonical.value)).toBeFalse();
});

function halveUnits(rows: Record<string, { val: number }[]>) {
  return Object.fromEntries(
    Object.entries(rows).map(([unit, list]) => [
      unit,
      list.map((fact) => ({ ...fact, val: fact.val / 2 })),
    ]),
  );
}

test("offline lens net-margin oracle rejects IFRS parent continuing income when NCI income is reported", async () => {
  const ifrsCase = await loadOfflineCorpusCase("fpi-ifrs-semiannual");
  const path = "financialLens.Quality.metrics.netMargin";
  const allowance = ifrsCase.allowances.find((item) => item.path === path)!;
  const { canonical } = ifrsCase.execution.differences.find((item) => item.path === path)!;
  if (!isRecord(canonical) || typeof canonical.value !== "number") {
    throw new Error("IFRS golden is missing canonical net margin");
  }
  const payload = structuredClone(ifrsCase.execution.input.companyFacts) as {
    facts: { "ifrs-full": Record<string, { units: Record<string, { val: number }[]> }> };
  };
  const ifrs = payload.facts["ifrs-full"];
  ifrs.ProfitLossFromContinuingOperationsAttributableToOwnersOfParent = {
    units: halveUnits(ifrs.ProfitLoss!.units),
  };
  ifrs.ProfitLossAttributableToNoncontrollingInterests = {
    units: halveUnits(ifrs.ProfitLoss!.units),
  };
  const { execution } = mutateOfflineCorpusCase(ifrsCase, { input: { companyFacts: payload } });

  expect(execution.projection.canonical.financialLens.Quality?.metrics.netMargin).toBeUndefined();
  expect(
    verifyLensAllowanceProperties(execution, allowance, {
      path,
      canonical: { ...canonical, value: canonical.value / 2 },
      legacy: null,
    }),
  ).toBeFalse();
  const parentAnnual = (
    ifrsCase.execution.projection.canonical.fundamentalHistory.netMargin?.annual ?? []
  ).map((point) => ({ ...point, value: point.value / 2 }));
  const forged = mutateOfflineCorpusCase(ifrsCase, {
    input: { companyFacts: payload },
    mutations: [["fundamentalHistory.netMargin.annual", "set", parentAnnual]],
  });
  expect(parentAnnual.length).toBeGreaterThan(0);
  expect(verifyHistoryAnnualRosters(forged.execution).get("canonical.netMargin")?.kind).toBe(
    "failed",
  );
});
