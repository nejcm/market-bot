import type { AssetClass, JobType } from "./domain/types";
import { isRecord } from "./guards";

// Value guards and primitive projections shared by more than one artifact
// Reader. Kept on their own leaf so the report reader can depend on the
// Snapshot reader without the snapshot reader depending back on it.

export function isAssetClass(value: unknown): value is AssetClass {
  return value === "equity" || value === "crypto";
}

export function isJobType(value: unknown): value is JobType {
  return (
    value === "market-overview" ||
    value === "daily" ||
    value === "weekly" ||
    value === "equity" ||
    value === "crypto" ||
    value === "alpha-search" ||
    value === "research"
  );
}

export function readPrimitiveEvidence(value: unknown): Record<string, number | string> | undefined {
  if (!isRecord(value)) {
    return;
  }
  const evidence: Record<string, number | string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item)) {
      evidence[key] = item;
    } else if (typeof item === "string") {
      evidence[key] = item;
    }
  }
  return evidence;
}
