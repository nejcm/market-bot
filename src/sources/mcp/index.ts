// Curated MCP evidence acquisition module (Slice 2A foundation).
export * from "./types";
export {
  MCP_CATALOG_FILENAME,
  loadMcpCatalog,
  parseMcpCatalog,
  resolveHeaderTemplate,
} from "./catalog";
export {
  MCP_MAPPINGS_FILENAME,
  McpMappingConfigError,
  loadMcpMappingRegistry,
  parseMcpMappingRegistry,
} from "./mappings";
export {
  isMappingEligibleForRun,
  isMappingEntitled,
  readMcpRuntimeOptions,
  selectEligibleMappings,
} from "./runtime";
export type { McpRunContext, McpRuntimeOptions } from "./runtime";
export {
  canonicalArgumentsJson,
  catalogServerFingerprint,
  mcpCacheKey,
  readMcpCache,
  writeMcpCache,
} from "./cache";
export type { McpCacheKeyInput, McpCacheOptions, McpCacheReadResult } from "./cache";
export {
  MissingCredentialError,
  UnsupportedTransportError,
  boundDiscoveredTool,
  openMcpSession,
  withMcpSession,
} from "./client";
export type {
  McpCallResult,
  McpContentBlock,
  McpDiscoveredTool,
  McpSession,
  OpenMcpSessionOptions,
} from "./client";
