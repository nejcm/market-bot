import { describe, expect, test } from "bun:test";
import {
  isMappingEligibleForRun,
  isMappingEntitled,
  readMcpRuntimeOptions,
  selectEligibleMappings,
} from "../src/sources/mcp/runtime";
import type { McpMappingRegistry, McpToolMapping } from "../src/sources/mcp/types";

const MT: McpToolMapping = {
  id: "mcp__mtnewswire__search_news",
  server: "mtnewswire",
  tool: "search_news",
  shape: "news_search.v1",
  eligibility: [{ jobType: "research" }, { jobType: "equity", depth: "deep" }],
  sourceUnitCost: 2,
  cache: { freshnessTtlMinutes: 60 },
  source: { kind: "news", provider: "mtnewswire", persistence: "metadata-only" },
  entitlementEnvVar: "MARKET_BOT_MCP_MTNEWSWIRE_ENTITLED",
};
const REGISTRY: McpMappingRegistry = { version: 1, mappings: [MT] };
const ENTITLED = { MARKET_BOT_MCP_MTNEWSWIRE_ENTITLED: "true" };

describe("readMcpRuntimeOptions", () => {
  test("uses documented defaults", () => {
    expect(readMcpRuntimeOptions({})).toEqual({
      disabled: false,
      maxRounds: 2,
      maxToolCalls: 2,
      sourceBudget: 8,
    });
  });

  test("honors overrides and the disable switch", () => {
    expect(
      readMcpRuntimeOptions({
        MARKET_BOT_MCP_DISABLED: "true",
        MARKET_BOT_MCP_MAX_ROUNDS: "1",
        MARKET_BOT_MCP_MAX_TOOL_CALLS: "3",
        MARKET_BOT_MCP_SOURCE_BUDGET: "4",
      }),
    ).toEqual({ disabled: true, maxRounds: 1, maxToolCalls: 3, sourceBudget: 4 });
  });
});

describe("isMappingEligibleForRun", () => {
  test("research at any depth", () => {
    expect(isMappingEligibleForRun(MT, { jobType: "research", deep: false })).toBe(true);
    expect(isMappingEligibleForRun(MT, { jobType: "research", deep: true })).toBe(true);
  });

  test("equity only when deep", () => {
    expect(isMappingEligibleForRun(MT, { jobType: "equity", deep: true })).toBe(true);
    expect(isMappingEligibleForRun(MT, { jobType: "equity", deep: false })).toBe(false);
  });

  test("ineligible run types", () => {
    for (const jobType of ["crypto", "market-overview", "daily", "weekly", "alpha-search"]) {
      expect(isMappingEligibleForRun(MT, { jobType, deep: true })).toBe(false);
    }
  });
});

describe("isMappingEntitled", () => {
  test("gate must be enabled", () => {
    expect(isMappingEntitled(MT, {})).toBe(false);
    expect(isMappingEntitled(MT, { MARKET_BOT_MCP_MTNEWSWIRE_ENTITLED: "false" })).toBe(false);
    expect(isMappingEntitled(MT, ENTITLED)).toBe(true);
  });

  test("ungated mapping is always entitled", () => {
    const { entitlementEnvVar: _entitlementEnvVar, ...rest } = MT;
    expect(isMappingEntitled(rest as McpToolMapping, {})).toBe(true);
  });
});

describe("selectEligibleMappings", () => {
  test("present only for entitled, eligible runs", () => {
    expect(
      selectEligibleMappings(REGISTRY, { jobType: "research", deep: false }, ENTITLED),
    ).toEqual([MT]);
    expect(selectEligibleMappings(REGISTRY, { jobType: "equity", deep: true }, ENTITLED)).toEqual([
      MT,
    ]);
  });

  test("absent without the entitlement attestation on every run", () => {
    for (const ctx of [
      { jobType: "research", deep: false },
      { jobType: "equity", deep: true },
    ]) {
      expect(selectEligibleMappings(REGISTRY, ctx, {})).toEqual([]);
    }
  });

  test("absent for ineligible runs even when entitled", () => {
    expect(selectEligibleMappings(REGISTRY, { jobType: "equity", deep: false }, ENTITLED)).toEqual(
      [],
    );
    expect(selectEligibleMappings(REGISTRY, { jobType: "crypto", deep: true }, ENTITLED)).toEqual(
      [],
    );
  });

  test("disabled infrastructure yields nothing", () => {
    expect(
      selectEligibleMappings(REGISTRY, { jobType: "research", deep: false }, ENTITLED, {
        disabled: true,
        maxRounds: 2,
        maxToolCalls: 2,
        sourceBudget: 8,
      }),
    ).toEqual([]);
  });
});
