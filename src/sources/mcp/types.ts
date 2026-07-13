// Curated MCP evidence acquisition — public types for the catalog, mapping
// Registry, evidence packets, and normalized audit. See ADR 0042 (Slice 2B) and
// Plans/02.mcp-support-slice-2.md. Slice 2A ships these types plus the loaders,
// Entitlement gating, Streamable HTTP client, and cache primitives; no
// Production run calls a mapped MCP tool in Slice 2A.

import type { ResearchJobType } from "../../domain/run-types";
import type { SourceGap, SourceKind } from "../../domain/types";

// ---------------------------------------------------------------------------
// Catalog (.mcp.json) — Claude-compatible `mcpServers` object.
// ---------------------------------------------------------------------------

// Streamable HTTP is the only transport initialized in Slice 2. stdio entries
// Are recognized but never spawned; an eligible mapping referencing one emits an
// Unsupported-transport gap.
export type McpTransportType = "http" | "stdio";

export interface McpHttpServerEntry {
  readonly id: string;
  readonly type: "http";
  readonly url: string;
  // Header values are environment templates such as `Bearer ${MTNEWSWIRE_TOKEN}`.
  // Literal credential values are rejected by the loader.
  readonly headers?: Readonly<Record<string, string>>;
}

export interface McpStdioServerEntry {
  readonly id: string;
  readonly type: "stdio";
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export type McpServerEntry = McpHttpServerEntry | McpStdioServerEntry;

export interface McpServerCatalog {
  // Only entries that parsed into a usable shape. Individual bad entries are
  // Isolated as gaps rather than aborting the catalog.
  readonly servers: readonly McpServerEntry[];
  // Non-fatal, content-free issues from syntax or per-entry validation.
  readonly gaps: readonly SourceGap[];
}

// ---------------------------------------------------------------------------
// Mapping registry (.mcp-mappings.json) — authorization + runtime policy.
// Invalid mapping policy is a checked-in configuration error and fails fast.
// ---------------------------------------------------------------------------

export type McpEvidencePacketShape = "news_search.v1";
export type McpPersistencePolicy = "metadata-only" | "full" | "none";
export type McpMappingDepth = "deep";

export interface McpMappingEligibilityRule {
  readonly jobType: ResearchJobType;
  // When "deep", the mapping is eligible only on a --deep run of that job type.
  // Absent means eligible at any depth for that job type.
  readonly depth?: McpMappingDepth;
}

export interface McpMappingSourcePolicy {
  readonly kind: SourceKind;
  readonly provider: string;
  readonly persistence: McpPersistencePolicy;
}

export interface McpMappingCachePolicy {
  readonly freshnessTtlMinutes: number;
}

export interface McpToolMapping {
  // Stable namespaced ID, e.g. `mcp__mtnewswire__search_news`.
  readonly id: string;
  // Catalog server ID and exact remote tool name.
  readonly server: string;
  readonly tool: string;
  readonly shape: McpEvidencePacketShape;
  readonly eligibility: readonly McpMappingEligibilityRule[];
  readonly sourceUnitCost: number;
  readonly cache: McpMappingCachePolicy;
  readonly source: McpMappingSourcePolicy;
  // Optional entitlement gate naming a boolean environment variable that must be
  // `true` before this mapping is discovered, cached, exposed, or called.
  readonly entitlementEnvVar?: string;
}

export interface McpMappingRegistry {
  readonly version: number;
  readonly mappings: readonly McpToolMapping[];
}

// ---------------------------------------------------------------------------
// Evidence packets. `news_search.v1` is a bounded list of news metadata. Full
// Article body is never a packet field.
// ---------------------------------------------------------------------------

export interface NewsSearchV1Item {
  readonly title: string;
  readonly publishedAt: string;
  readonly providerArticleId: string;
  readonly url?: string;
  readonly publisher?: string;
  readonly summary?: string;
  readonly snippet?: string;
}

export interface NewsSearchV1Packet {
  readonly shape: "news_search.v1";
  readonly items: readonly NewsSearchV1Item[];
}

export type McpEvidencePacket = NewsSearchV1Packet;

// ---------------------------------------------------------------------------
// Normalized MCP audit. Content-free: never carries credentials or raw provider
// Text. Persisted as a run-artifact sidecar in Slice 2B.
// ---------------------------------------------------------------------------

export type McpTransportOutcome =
  | "ok"
  | "unsupported-transport"
  | "init-failed"
  | "discovery-failed"
  | "tool-missing"
  | "call-failed"
  | "timeout"
  | "aborted";

export type McpCacheOutcome = "disabled" | "hit-fresh" | "miss" | "stale-fallback";

export interface McpCallAudit {
  readonly mappingId: string;
  readonly server: string;
  readonly tool: string;
  readonly transport: McpTransportType;
  readonly transportOutcome: McpTransportOutcome;
  readonly cacheOutcome: McpCacheOutcome;
  readonly sourceUnitsSpent: number;
  readonly itemCount?: number;
}

export interface McpAuditSidecar {
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly sourceUnitBudget: number;
  readonly sourceUnitsSpent: number;
  readonly calls: readonly McpCallAudit[];
  readonly gaps: readonly SourceGap[];
}
