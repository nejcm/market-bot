import { ASSET_CLASSES, JOB_TYPES, type AssetClass, type JobType } from "./domain/job-type";
import { isRecord } from "./guards";

// Value guards and primitive projections shared by more than one artifact
// Reader. Kept on their own leaf so the report reader can depend on the
// Snapshot reader without the snapshot reader depending back on it.

const ASSET_CLASS_SET: ReadonlySet<unknown> = new Set(ASSET_CLASSES);
const JOB_TYPE_SET: ReadonlySet<unknown> = new Set(JOB_TYPES);

export function isAssetClass(value: unknown): value is AssetClass {
  return ASSET_CLASS_SET.has(value);
}

export function isJobType(value: unknown): value is JobType {
  return JOB_TYPE_SET.has(value);
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
