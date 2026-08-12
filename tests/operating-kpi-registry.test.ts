import { describe, expect, test } from "bun:test";
import {
  DEFAULT_OPERATING_KPI_REGISTRY,
  lookupOperatingKpiRegistry,
  validateOperatingKpiRegistry,
  type OperatingKpiRegistryEntry,
} from "../src/sources/extended-evidence/operating-kpi-registry";

describe("operating KPI registry", () => {
  test("default registry is valid and contains the pilot issuers", () => {
    expect(validateOperatingKpiRegistry(DEFAULT_OPERATING_KPI_REGISTRY)).toEqual({
      valid: true,
      errors: [],
    });
    expect(DEFAULT_OPERATING_KPI_REGISTRY.map((entry) => entry.symbol)).toEqual(["ASTS", "NBIS"]);
  });

  test("looks up canonical equity symbols case-insensitively", () => {
    expect(lookupOperatingKpiRegistry(" nbis ", "equity")?.symbol).toBe("NBIS");
    expect(lookupOperatingKpiRegistry("NBIS", "crypto")).toBeUndefined();
  });

  test("rejects invalid applicability declarations", () => {
    const invalidRegistry: readonly OperatingKpiRegistryEntry[] = [
      {
        symbol: "TEST",
        assetClass: "equity",
        applicability: "kpi-declared",
        kpis: [],
      },
      {
        symbol: "TEST",
        assetClass: "equity",
        applicability: "not-applicable",
        kpis: [],
        notApplicable: {
          reasonCode: "provider-entitlement-missing",
          evidenceCategories: [],
        },
      },
    ];

    expect(validateOperatingKpiRegistry(invalidRegistry)).toEqual({
      valid: false,
      errors: [
        "TEST: kpi-declared entries must include KPIs",
        "TEST: duplicate symbol",
        "TEST: not-applicable reasonCode cannot cite credentials or entitlement",
        "TEST: not-applicable entries require evidenceCategories",
      ],
    });
  });
});
