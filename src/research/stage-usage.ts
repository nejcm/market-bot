import { USAGE_FIELDS, type ModelUsage } from "../model/types";

type UsageField = keyof ModelUsage;
type UsageCount = number | "unknown";

export type StageUsageRollup = {
  readonly stage: string;
  readonly calls: number;
  readonly failedCalls: number;
  readonly unreportedCalls: number;
  readonly tokenEstimate: number;
} & Readonly<Record<UsageField, UsageCount>>;

interface UsageCall {
  readonly stage: string;
  readonly status?: "ok" | "error";
  readonly tokenEstimate?: number;
  readonly usage?: ModelUsage | "unknown";
}

// A field sums only when every call in the stage reported it; a partial sum would misattribute a delta.
export function rollupStageUsage(calls: readonly UsageCall[]): readonly StageUsageRollup[] {
  const byStage = new Map<string, UsageCall[]>();
  for (const call of calls) {
    byStage.set(call.stage, [...(byStage.get(call.stage) ?? []), call]);
  }
  return [...byStage].map(([stage, stageCalls]) => {
    const reported = stageCalls.flatMap((call) =>
      call.usage === undefined || call.usage === "unknown" ? [] : [call.usage],
    );
    const fieldTotal = (field: UsageField): UsageCount =>
      reported.length === stageCalls.length && reported.every((usage) => usage[field] !== undefined)
        ? reported.reduce((total, usage) => total + (usage[field] ?? 0), 0)
        : "unknown";
    return {
      stage,
      calls: stageCalls.length,
      failedCalls: stageCalls.filter((call) => call.status === "error").length,
      unreportedCalls: stageCalls.length - reported.length,
      tokenEstimate: stageCalls.reduce((total, call) => total + (call.tokenEstimate ?? 0), 0),
      ...(Object.fromEntries(USAGE_FIELDS.map((field) => [field, fieldTotal(field)])) as Record<
        UsageField,
        UsageCount
      >),
    };
  });
}
