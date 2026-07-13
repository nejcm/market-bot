// MCP runtime options, entitlement gating, and run eligibility. MCP
// Infrastructure is active by default; MARKET_BOT_MCP_DISABLED disables all
// Discovery and acquisition. An entitlement-gated mapping stays unavailable even
// While MCP infrastructure is active.

import type { McpMappingRegistry, McpToolMapping } from "./types";

export interface McpRuntimeOptions {
  readonly disabled: boolean;
  readonly maxRounds: number;
  readonly maxToolCalls: number;
  // Generic ceiling on mapping-declared source units per run, not a news-item
  // Allowance. Result-item count is bounded separately by the packet shape and
  // The final news limit.
  readonly sourceBudget: number;
}

// Matches config.ts readBoolean: only "1"/"true" enable.
function readBoolean(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function readNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Expected non-negative integer, received ${value}`);
  }
  return parsed;
}

export function readMcpRuntimeOptions(
  env: Record<string, string | undefined> = process.env,
): McpRuntimeOptions {
  return {
    disabled: readBoolean(env.MARKET_BOT_MCP_DISABLED),
    maxRounds: readNonNegativeInteger(env.MARKET_BOT_MCP_MAX_ROUNDS, 2),
    maxToolCalls: readNonNegativeInteger(env.MARKET_BOT_MCP_MAX_TOOL_CALLS, 2),
    sourceBudget: readNonNegativeInteger(env.MARKET_BOT_MCP_SOURCE_BUDGET, 8),
  };
}

// True when the mapping has no entitlement gate, or its named boolean
// Environment variable is enabled.
export function isMappingEntitled(
  mapping: McpToolMapping,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (mapping.entitlementEnvVar === undefined) {
    return true;
  }
  return readBoolean(env[mapping.entitlementEnvVar]);
}

export interface McpRunContext {
  readonly jobType: string;
  readonly deep: boolean;
}

// True when the mapping declares an eligibility rule that matches this run's job
// Type and depth. A "deep" rule requires a --deep run; a rule without depth is
// Eligible at any depth.
export function isMappingEligibleForRun(mapping: McpToolMapping, ctx: McpRunContext): boolean {
  return mapping.eligibility.some(
    (rule) => rule.jobType === ctx.jobType && (rule.depth !== "deep" || ctx.deep),
  );
}

// The mappings a run may present to the model: MCP infrastructure enabled, the
// Run job/depth eligible, and the entitlement gate satisfied. When disabled or
// Nothing survives, returns an empty list — callers skip the model stage.
export function selectEligibleMappings(
  registry: McpMappingRegistry,
  ctx: McpRunContext,
  env: Record<string, string | undefined> = process.env,
  options: McpRuntimeOptions = readMcpRuntimeOptions(env),
): readonly McpToolMapping[] {
  if (options.disabled) {
    return [];
  }
  return registry.mappings.filter(
    (mapping) => isMappingEligibleForRun(mapping, ctx) && isMappingEntitled(mapping, env),
  );
}
