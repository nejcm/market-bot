import { describe, expect, test } from "bun:test";
import { loadMcpCatalog } from "../src/sources/mcp/catalog";
import {
  McpMappingConfigError,
  loadMcpMappingRegistry,
  parseMcpMappingRegistry,
} from "../src/sources/mcp/mappings";
import type { McpServerCatalog } from "../src/sources/mcp/types";

const CATALOG: McpServerCatalog = {
  servers: [{ id: "mtnewswire", type: "http", url: "https://mt.test/mcp" }],
  gaps: [],
};

function validMapping(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "mcp__mtnewswire__search_news",
    server: "mtnewswire",
    tool: "search_news",
    shape: "news_search.v1",
    eligibility: [{ jobType: "research" }, { jobType: "equity", depth: "deep" }],
    sourceUnitCost: 2,
    cache: { freshnessTtlMinutes: 60 },
    source: { kind: "news", provider: "mtnewswire", persistence: "metadata-only" },
    entitlementEnvVar: "MARKET_BOT_MCP_MTNEWSWIRE_ENTITLED",
    ...overrides,
  };
}

function parse(
  mappings: readonly unknown[],
  version = 1,
): ReturnType<typeof parseMcpMappingRegistry> {
  return parseMcpMappingRegistry(JSON.stringify({ version, mappings }), CATALOG);
}

describe("parseMcpMappingRegistry (valid)", () => {
  test("parses the MT mapping", () => {
    const registry = parse([validMapping()]);
    expect(registry.version).toBe(1);
    expect(registry.mappings).toHaveLength(1);
    expect(registry.mappings[0]).toMatchObject({
      id: "mcp__mtnewswire__search_news",
      server: "mtnewswire",
      tool: "search_news",
      shape: "news_search.v1",
      sourceUnitCost: 2,
      cache: { freshnessTtlMinutes: 60 },
      source: { kind: "news", provider: "mtnewswire", persistence: "metadata-only" },
      entitlementEnvVar: "MARKET_BOT_MCP_MTNEWSWIRE_ENTITLED",
    });
  });
});

describe("parseMcpMappingRegistry (fast-fail)", () => {
  const cases: readonly [string, () => unknown][] = [
    ["duplicate ids", () => parse([validMapping(), validMapping()])],
    ["unknown server", () => parse([validMapping({ server: "ghost" })])],
    ["unknown shape", () => parse([validMapping({ shape: "document_search.v1" })])],
    [
      "unknown persistence",
      () =>
        parse([validMapping({ source: { kind: "news", provider: "mt", persistence: "cache" } })]),
    ],
    [
      "unknown source kind",
      () =>
        parse([validMapping({ source: { kind: "invalid", provider: "mt", persistence: "none" } })]),
    ],
    ["invalid job type", () => parse([validMapping({ eligibility: [{ jobType: "swing" }] })])],
    [
      "depth on non-depth job type",
      () => parse([validMapping({ eligibility: [{ jobType: "research", depth: "deep" }] })]),
    ],
    ["non-positive cost", () => parse([validMapping({ sourceUnitCost: 0 })])],
    ["fractional cost", () => parse([validMapping({ sourceUnitCost: 1.5 })])],
    ["non-positive ttl", () => parse([validMapping({ cache: { freshnessTtlMinutes: 0 } })])],
    [
      "entitlement as value not name",
      () => parse([validMapping({ entitlementEnvVar: "sk-secret-123" })]),
    ],
    ["bad mapping id", () => parse([validMapping({ id: "search_news" })])],
    ["missing version", () => parseMcpMappingRegistry(JSON.stringify({ mappings: [] }), CATALOG)],
    ["malformed json", () => parseMcpMappingRegistry("{ nope", CATALOG)],
  ];
  for (const [label, run] of cases) {
    test(`rejects ${label}`, () => {
      expect(run).toThrow(McpMappingConfigError);
    });
  }
});

describe("loadMcpMappingRegistry (repo root)", () => {
  test("loads the checked-in MT mapping against the checked-in catalog", async () => {
    const catalog = await loadMcpCatalog();
    const registry = await loadMcpMappingRegistry(catalog);
    expect(registry.mappings.map((m) => m.id)).toContain("mcp__mtnewswire__search_news");
  });
});
