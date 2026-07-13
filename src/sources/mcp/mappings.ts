// Loads the repo-root `.mcp-mappings.json` authorization registry. Unlike the
// Catalog, invalid mapping policy is a checked-in configuration error and fails
// Fast — a run must never proceed with an ambiguous authorization surface.

import { join } from "node:path";
import { isResearchJobType, runTypeSupportsDepth } from "../../domain/run-types";
import { SOURCE_KINDS } from "../../domain/types";
import type { SourceKind } from "../../domain/types";
import type { McpServerCatalog } from "./types";
import type {
  McpEvidencePacketShape,
  McpMappingEligibilityRule,
  McpMappingRegistry,
  McpPersistencePolicy,
  McpToolMapping,
} from "./types";

export const MCP_MAPPINGS_FILENAME = ".mcp-mappings.json";

const SUPPORTED_SHAPES: ReadonlySet<McpEvidencePacketShape> = new Set(["news_search.v1"]);
const SUPPORTED_PERSISTENCE: ReadonlySet<McpPersistencePolicy> = new Set([
  "metadata-only",
  "full",
  "none",
]);
const SOURCE_KIND_SET: ReadonlySet<string> = new Set(SOURCE_KINDS);
const MAPPING_ID_RE = /^mcp__[A-Za-z0-9-]+__[A-Za-z0-9._-]+$/u;
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export class McpMappingConfigError extends Error {
  constructor(message: string) {
    super(`Invalid .mcp-mappings.json: ${message}`);
    this.name = "McpMappingConfigError";
  }
}

function fail(message: string): never {
  throw new McpMappingConfigError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function parseEligibility(raw: unknown, mappingId: string): readonly McpMappingEligibilityRule[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    fail(`mapping "${mappingId}" eligibility must be a non-empty array`);
  }
  return raw.map((entry, index) => {
    const label = `mapping "${mappingId}" eligibility[${String(index)}]`;
    if (!isRecord(entry)) {
      fail(`${label} must be an object`);
    }
    const jobType = requireString(entry.jobType, `${label}.jobType`);
    if (!isResearchJobType(jobType)) {
      fail(`${label}.jobType "${jobType}" is not a research job type`);
    }
    if (entry.depth === undefined) {
      return { jobType };
    }
    if (entry.depth !== "deep") {
      fail(`${label}.depth must be "deep" when present`);
    }
    if (!runTypeSupportsDepth(jobType)) {
      fail(`${label} sets depth "deep" but job type "${jobType}" has no depth`);
    }
    return { jobType, depth: "deep" };
  });
}

// Returns the parsed mapping, or undefined when it must be skipped non-fatally
// (its declared catalog server was dropped as unusable). Throws on genuine
// Checked-in policy errors, including references to servers never declared.
function parseMapping(
  raw: unknown,
  index: number,
  catalog: McpServerCatalog,
  seenIds: Set<string>,
): McpToolMapping | undefined {
  const label = `mappings[${String(index)}]`;
  if (!isRecord(raw)) {
    fail(`${label} must be an object`);
  }
  const id = requireString(raw.id, `${label}.id`);
  if (!MAPPING_ID_RE.test(id)) {
    fail(`mapping "${id}" id must match mcp__<server>__<tool>`);
  }
  if (seenIds.has(id)) {
    fail(`duplicate mapping id "${id}"`);
  }
  seenIds.add(id);

  const server = requireString(raw.server, `mapping "${id}".server`);
  if (!catalog.servers.some((entry) => entry.id === server)) {
    if (catalog.declaredServerIds.includes(server)) {
      // The server is declared but its catalog entry was dropped as unusable — a
      // Non-fatal catalog issue. Skip this mapping instead of aborting the run;
      // The catalog gap already records the underlying cause.
      return undefined;
    }
    fail(`mapping "${id}" references unknown server "${server}"`);
  }
  const tool = requireString(raw.tool, `mapping "${id}".tool`);

  const shape = requireString(raw.shape, `mapping "${id}".shape`);
  if (!SUPPORTED_SHAPES.has(shape as McpEvidencePacketShape)) {
    fail(`mapping "${id}" has unknown shape "${shape}"`);
  }

  const eligibility = parseEligibility(raw.eligibility, id);

  if (!isPositiveInteger(raw.sourceUnitCost)) {
    fail(`mapping "${id}" sourceUnitCost must be a positive integer`);
  }

  if (!isRecord(raw.cache) || typeof raw.cache.freshnessTtlMinutes !== "number") {
    fail(`mapping "${id}" cache.freshnessTtlMinutes must be a number`);
  }
  const { freshnessTtlMinutes } = raw.cache;
  if (!(freshnessTtlMinutes > 0) || !Number.isFinite(freshnessTtlMinutes)) {
    fail(`mapping "${id}" cache.freshnessTtlMinutes must be positive`);
  }

  if (!isRecord(raw.source)) {
    fail(`mapping "${id}".source must be an object`);
  }
  const kind = requireString(raw.source.kind, `mapping "${id}".source.kind`);
  if (!SOURCE_KIND_SET.has(kind)) {
    fail(`mapping "${id}".source.kind "${kind}" is not a source kind`);
  }
  const provider = requireString(raw.source.provider, `mapping "${id}".source.provider`);
  const persistence = requireString(raw.source.persistence, `mapping "${id}".source.persistence`);
  if (!SUPPORTED_PERSISTENCE.has(persistence as McpPersistencePolicy)) {
    fail(`mapping "${id}".source.persistence "${persistence}" is unknown`);
  }

  let entitlementEnvVar: string | undefined;
  if (raw.entitlementEnvVar !== undefined) {
    entitlementEnvVar = requireString(raw.entitlementEnvVar, `mapping "${id}".entitlementEnvVar`);
    if (!ENV_VAR_NAME_RE.test(entitlementEnvVar)) {
      fail(`mapping "${id}".entitlementEnvVar must be an environment variable name, not a value`);
    }
  }

  return {
    id,
    server,
    tool,
    shape: shape as McpEvidencePacketShape,
    eligibility,
    sourceUnitCost: raw.sourceUnitCost,
    cache: { freshnessTtlMinutes },
    source: {
      kind: kind as SourceKind,
      provider,
      persistence: persistence as McpPersistencePolicy,
    },
    ...(entitlementEnvVar !== undefined ? { entitlementEnvVar } : {}),
  };
}

// Parses registry content already read into memory. Throws McpMappingConfigError
// On any invalid policy. Exposed for tests.
export function parseMcpMappingRegistry(
  content: string,
  catalog: McpServerCatalog,
): McpMappingRegistry {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    fail("file is not valid JSON");
  }
  if (!isRecord(doc)) {
    fail("root must be an object");
  }
  if (!isPositiveInteger(doc.version)) {
    fail("version must be a positive integer");
  }
  if (!Array.isArray(doc.mappings)) {
    fail("mappings must be an array");
  }
  const seenIds = new Set<string>();
  const mappings = doc.mappings
    .map((raw, index) => parseMapping(raw, index, catalog, seenIds))
    .filter((mapping): mapping is McpToolMapping => mapping !== undefined);
  return { version: doc.version, mappings };
}

export interface LoadMcpMappingRegistryOptions {
  readonly path?: string;
  readonly cwd?: string;
}

// Reads and parses the mapping registry. A missing file yields an empty registry
// (nothing authorized). A present-but-invalid file throws.
export async function loadMcpMappingRegistry(
  catalog: McpServerCatalog,
  options: LoadMcpMappingRegistryOptions = {},
): Promise<McpMappingRegistry> {
  const path = options.path ?? join(options.cwd ?? process.cwd(), MCP_MAPPINGS_FILENAME);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return { version: 1, mappings: [] };
  }
  const content = await file.text();
  return parseMcpMappingRegistry(content, catalog);
}
