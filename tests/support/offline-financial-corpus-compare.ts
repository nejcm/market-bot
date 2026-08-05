import { createHash } from "node:crypto";
import type { FundamentalHistorySeries } from "../../src/sources/extended-evidence/fundamental-history";
import type {
  OfflineCorpusAllowance,
  OfflineCorpusDifference,
} from "./offline-financial-statements-corpus";

// Leaf comparison engine for the offline financial-statements corpus: the projected-consumer shapes, field-by-field diffing of canonical vs. legacy, and the stable hash/key helpers used to match a computed difference against its checked-in allowance. Kept as a private mechanics module — the corpus test suites never import from here directly.

export interface ProjectedLensMetric {
  readonly key: string;
  readonly label: string;
  readonly value: number | string;
  readonly unit: string;
  readonly sourceIds: readonly string[];
  readonly currency?: string;
  readonly periodEnd?: string;
  readonly periodMonths?: number;
}

export interface ProjectedLens {
  readonly posture: string;
  readonly metrics: Readonly<Record<string, ProjectedLensMetric>>;
}

export interface ProjectedHistorySeries {
  readonly concept: string | null;
  readonly annual: FundamentalHistorySeries["annual"];
  readonly ttm: FundamentalHistorySeries["ttm"] | null;
  readonly cagr: FundamentalHistorySeries["cagr"] | null;
  readonly marginChange: FundamentalHistorySeries["marginChange"] | null;
}

export interface ProjectedConsumers {
  readonly fundamentalHistory: Readonly<Record<string, ProjectedHistorySeries>>;
  readonly financialLens: Readonly<Record<string, ProjectedLens>>;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareField(
  differences: OfflineCorpusDifference[],
  path: string,
  canonical: unknown,
  legacy: unknown,
): void {
  if (!sameValue(canonical, legacy)) {
    differences.push({ path, canonical: canonical ?? null, legacy: legacy ?? null });
  }
}

export function compareConsumers(
  canonical: ProjectedConsumers,
  legacy: ProjectedConsumers,
): readonly OfflineCorpusDifference[] {
  const differences: OfflineCorpusDifference[] = [];
  const historyKeys = [
    ...new Set([
      ...Object.keys(canonical.fundamentalHistory),
      ...Object.keys(legacy.fundamentalHistory),
    ]),
  ].toSorted();
  for (const key of historyKeys) {
    const current = canonical.fundamentalHistory[key];
    const previous = legacy.fundamentalHistory[key];
    for (const field of ["concept", "annual", "ttm", "cagr", "marginChange"] as const) {
      compareField(
        differences,
        `fundamentalHistory.${key}.${field}`,
        current?.[field],
        previous?.[field],
      );
    }
  }
  const lensNames = [
    ...new Set([...Object.keys(canonical.financialLens), ...Object.keys(legacy.financialLens)]),
  ].toSorted();
  for (const name of lensNames) {
    const current = canonical.financialLens[name];
    const previous = legacy.financialLens[name];
    compareField(differences, `financialLens.${name}.posture`, current?.posture, previous?.posture);
    const metricKeys = [
      ...new Set([...Object.keys(current?.metrics ?? {}), ...Object.keys(previous?.metrics ?? {})]),
    ].toSorted();
    for (const key of metricKeys) {
      compareField(
        differences,
        `financialLens.${name}.metrics.${key}`,
        current?.metrics[key],
        previous?.metrics[key],
      );
    }
  }
  return differences;
}

export function countComparableFields(
  canonical: ProjectedConsumers,
  legacy: ProjectedConsumers,
): number {
  let count =
    new Set([
      ...Object.keys(canonical.fundamentalHistory),
      ...Object.keys(legacy.fundamentalHistory),
    ]).size * 5;
  const lensNames = new Set([
    ...Object.keys(canonical.financialLens),
    ...Object.keys(legacy.financialLens),
  ]);
  for (const name of lensNames) {
    count += 1;
    count += new Set([
      ...Object.keys(canonical.financialLens[name]?.metrics ?? {}),
      ...Object.keys(legacy.financialLens[name]?.metrics ?? {}),
    ]).size;
  }
  return count;
}

export function exactValueHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

export function differenceKey(value: OfflineCorpusDifference): string {
  return JSON.stringify([
    value.path,
    exactValueHash(value.canonical),
    exactValueHash(value.legacy),
  ]);
}

export function allowanceKey(value: OfflineCorpusAllowance): string {
  return JSON.stringify([value.path, value.canonicalSha256, value.legacySha256]);
}
