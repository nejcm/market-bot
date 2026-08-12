import type { AssetClass, ExtendedEvidenceItem } from "../../domain/types";

export interface OperatingKpiDefinition {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly cadence: "quarterly" | "semiannual" | "annual" | "irregular";
  readonly conceptAliases: readonly string[];
  readonly sourceSectionRules: readonly string[];
}

export interface OperatingKpiRegistryEntry {
  readonly symbol: string;
  readonly assetClass: "equity";
  readonly applicability: "kpi-declared" | "not-applicable";
  readonly kpis: readonly OperatingKpiDefinition[];
  readonly notApplicable?: {
    readonly reasonCode: string;
    readonly evidenceCategories: readonly ExtendedEvidenceItem["category"][];
  };
}

export interface OperatingKpiRegistryValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export const DEFAULT_OPERATING_KPI_REGISTRY: readonly OperatingKpiRegistryEntry[] =
  validateDefaultRegistry([
    {
      symbol: "ASTS",
      assetClass: "equity",
      applicability: "kpi-declared",
      kpis: [
        {
          key: "satellites-launched",
          label: "Satellites launched",
          unit: "satellites",
          cadence: "irregular",
          conceptAliases: ["satellites launched", "launched satellites"],
          sourceSectionRules: ["operational update", "satellite deployment"],
        },
        {
          key: "satellites-operational",
          label: "Satellites operational",
          unit: "satellites",
          cadence: "irregular",
          conceptAliases: ["satellites operational", "commercial satellites in orbit"],
          sourceSectionRules: ["operational update", "constellation status"],
        },
      ],
    },
    {
      symbol: "NBIS",
      assetClass: "equity",
      applicability: "kpi-declared",
      kpis: [
        {
          key: "gpu-capacity",
          label: "GPU capacity",
          unit: "GPUs",
          cadence: "quarterly",
          conceptAliases: ["GPU capacity", "installed GPU capacity"],
          sourceSectionRules: ["business update", "AI infrastructure capacity"],
        },
        {
          key: "gpu-utilization",
          label: "GPU utilization",
          unit: "percent",
          cadence: "quarterly",
          conceptAliases: ["GPU utilization", "GPU fleet utilization"],
          sourceSectionRules: ["business update", "capacity utilization"],
        },
      ],
    },
  ]);

export function lookupOperatingKpiRegistry(
  symbol: string,
  assetClass: AssetClass,
  registry: readonly OperatingKpiRegistryEntry[] = DEFAULT_OPERATING_KPI_REGISTRY,
): OperatingKpiRegistryEntry | undefined {
  const canonicalSymbol = symbol.trim().toUpperCase();
  return registry.find(
    (entry) => entry.symbol === canonicalSymbol && entry.assetClass === assetClass,
  );
}

export function validateOperatingKpiRegistry(
  registry: readonly OperatingKpiRegistryEntry[] = DEFAULT_OPERATING_KPI_REGISTRY,
): OperatingKpiRegistryValidationResult {
  const errors: string[] = [];
  const symbols = new Set<string>();

  for (const entry of registry) {
    if (symbols.has(entry.symbol)) {
      errors.push(`${entry.symbol}: duplicate symbol`);
    }
    symbols.add(entry.symbol);

    if (entry.symbol !== entry.symbol.trim().toUpperCase()) {
      errors.push(`${entry.symbol}: symbol must be canonical uppercase`);
    }

    if (entry.applicability === "kpi-declared") {
      if (entry.kpis.length === 0) {
        errors.push(`${entry.symbol}: kpi-declared entries must include KPIs`);
      }
      const keys = new Set<string>();
      for (const kpi of entry.kpis) {
        if (keys.has(kpi.key)) {
          errors.push(`${entry.symbol}: duplicate KPI key ${kpi.key}`);
        }
        keys.add(kpi.key);
      }
      continue;
    }

    const reasonCode = entry.notApplicable?.reasonCode.trim() ?? "";
    if (reasonCode === "") {
      errors.push(`${entry.symbol}: not-applicable entries require a reasonCode`);
    } else if (/credential|entitlement/iu.test(reasonCode)) {
      errors.push(
        `${entry.symbol}: not-applicable reasonCode cannot cite credentials or entitlement`,
      );
    }
    if ((entry.notApplicable?.evidenceCategories.length ?? 0) === 0) {
      errors.push(`${entry.symbol}: not-applicable entries require evidenceCategories`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateDefaultRegistry(
  registry: readonly OperatingKpiRegistryEntry[],
): readonly OperatingKpiRegistryEntry[] {
  const validation = validateOperatingKpiRegistry(registry);
  if (!validation.valid) {
    throw new Error(`Invalid operating KPI registry: ${validation.errors.join("; ")}`);
  }
  return registry;
}
