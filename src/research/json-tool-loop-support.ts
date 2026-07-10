import type { JsonToolLoopAuditEntry, SourceGap, SourceGapCapability } from "../domain/types";
import { sourceGap } from "../domain/source-gaps";

export interface JsonToolRejectionGapOptions {
  readonly source: string;
  readonly provider?: string;
  readonly capability: SourceGapCapability;
  readonly gapMessage?: string;
}

export interface JsonToolBudgetValidation {
  readonly maxToolCalls: number;
  readonly sourceBudget: number;
  readonly toolCallsUsed: number;
  readonly sourceUnitsUsed: number;
  readonly requestSourceUnits: number;
  readonly toolCallExceededReason: string;
  readonly sourceBudgetExceededReason: string;
}

export interface StaleFallbackGapCollector {
  readonly staleFallbackGaps: readonly SourceGap[];
}

export interface ToolOutputWithGaps {
  readonly gaps: readonly SourceGap[];
}

export function acceptedJsonToolAuditEntry(
  round: number,
  tool: string,
  args: unknown,
  rationale: string,
  sourceUnits: number,
): JsonToolLoopAuditEntry {
  return {
    round,
    tool,
    args,
    rationale,
    status: "accepted",
    sourceUnits,
  };
}

export function budgetRejectionReason(options: JsonToolBudgetValidation): string | undefined {
  if (options.toolCallsUsed + 1 > options.maxToolCalls) {
    return options.toolCallExceededReason;
  }
  if (options.sourceUnitsUsed + options.requestSourceUnits > options.sourceBudget) {
    return options.sourceBudgetExceededReason;
  }
  return undefined;
}

export function rejectedJsonToolRequest(
  round: number,
  tool: string,
  args: unknown,
  rationale: string | undefined,
  reason: string,
  options: JsonToolRejectionGapOptions,
): { readonly audit: JsonToolLoopAuditEntry; readonly gap: SourceGap } {
  return {
    audit: {
      round,
      tool,
      ...(args !== undefined ? { args } : {}),
      ...(rationale !== undefined ? { rationale } : {}),
      status: "rejected",
      reason,
    },
    gap: sourceGap({
      source: options.source,
      message: options.gapMessage ?? `${tool}: ${reason}`,
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      capability: options.capability,
      cause: "validation-failed",
      evidenceQualityImpact: "extended-evidence-cap",
    }),
  };
}

export async function withStaleFallbackGaps<TOutput extends ToolOutputWithGaps>(
  collector: StaleFallbackGapCollector,
  execute: () => Promise<TOutput>,
): Promise<TOutput> {
  const staleStart = collector.staleFallbackGaps.length;
  const output = await execute();
  const staleGaps = collector.staleFallbackGaps.slice(staleStart);
  return { ...output, gaps: [...output.gaps, ...staleGaps] };
}
