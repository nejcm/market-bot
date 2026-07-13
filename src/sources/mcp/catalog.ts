// Loads the repo-root `.mcp.json` connection catalog. Syntax failures and
// Unusable individual entries are non-fatal: they produce content-free MCP
// SourceGaps and the run continues. Authorization is separate and comes only
// From the mapping registry — an unmapped catalog server is never contacted.

import { join } from "node:path";
import { sourceGap } from "../../domain/source-gaps";
import type { SourceGap } from "../../domain/types";
import { isRecord } from "../guards";
import type {
  McpHttpServerEntry,
  McpServerCatalog,
  McpServerEntry,
  McpStdioServerEntry,
} from "./types";

export const MCP_CATALOG_FILENAME = ".mcp.json";

// A header value must resolve its secret from the environment: it has to embed
// At least one well-formed ${VAR} reference. A value with no reference is
// Treated as a literal credential and rejected. The static scheme prefix in
// E.g. `Bearer ${TOKEN}` is allowed; only the ${VAR} part is substituted.
const ENV_TEMPLATE_RE = /\$\{(?<name>[A-Za-z_][A-Za-z0-9_]*)\}/gu;

// A header value must be one supported auth scheme followed by exactly one
// ${VAR} reference, or a bare ${VAR}. An arbitrary token cannot occupy the
// Scheme position and smuggle a literal credential beside an unused reference.
const STRICT_HEADER_TEMPLATE_RE = /^(?:(?:Bearer|Basic|Token) )?\$\{[A-Za-z_][A-Za-z0-9_]*\}$/iu;

// Query parameter names that would carry a literal credential in a checked-in URL.
const CREDENTIAL_QUERY_PARAMS: ReadonlySet<string> = new Set([
  "api_key",
  "api-key",
  "api_token",
  "apikey",
  "authorization",
  "token",
  "access_token",
  "x-api-key",
  "sig",
  "key",
  "secret",
  "password",
]);

function mcpCatalogGap(message: string): SourceGap {
  return sourceGap({
    source: "mcp-catalog",
    message,
    capability: "mcp",
    cause: "validation-failed",
    evidenceQualityImpact: "no-cap",
  });
}

function emptyCatalog(): McpServerCatalog {
  return { servers: [], declaredServerIds: [], declarationsUnavailable: false, gaps: [] };
}

function catalogFailure(message: string): McpServerCatalog {
  return {
    servers: [],
    declaredServerIds: [],
    declarationsUnavailable: true,
    gaps: [mcpCatalogGap(message)],
  };
}

function isStrictHeaderTemplate(value: string): boolean {
  return STRICT_HEADER_TEMPLATE_RE.test(value);
}

// Validates optional headers: every value must be a strict template that resolves
// Its secret from an environment reference. Returns the headers on success or an
// Error message describing the first problem.
function validateHeaders(
  raw: unknown,
): { readonly headers?: Record<string, string> } | { readonly error: string } {
  if (raw === undefined) {
    return {};
  }
  if (!isRecord(raw)) {
    return { error: "headers must be an object" };
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      return { error: `header "${key}" must be a string` };
    }
    if (!isStrictHeaderTemplate(value)) {
      return {
        error: `header "${key}" must be a supported auth scheme plus a single \${VAR} reference, or a bare \${VAR}; literal values are rejected`,
      };
    }
    headers[key] = value;
  }
  return { headers };
}

function validateHttpEntry(
  id: string,
  raw: Record<string, unknown>,
): { readonly entry: McpHttpServerEntry } | { readonly error: string } {
  const { url } = raw;
  if (typeof url !== "string" || url.length === 0) {
    return { error: `server "${id}" http entry requires a url` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `server "${id}" has an invalid url` };
  }
  if (parsed.protocol !== "https:") {
    return { error: `server "${id}" http url must use https` };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { error: `server "${id}" http url must not embed credentials` };
  }
  for (const queryKey of parsed.searchParams.keys()) {
    if (CREDENTIAL_QUERY_PARAMS.has(queryKey.toLowerCase())) {
      return { error: `server "${id}" http url must not embed credential query parameters` };
    }
  }
  const headerResult = validateHeaders(raw.headers);
  if ("error" in headerResult) {
    return { error: `server "${id}" ${headerResult.error}` };
  }
  return {
    entry: {
      id,
      type: "http",
      url,
      ...(headerResult.headers !== undefined ? { headers: headerResult.headers } : {}),
    },
  };
}

function validateStdioEntry(
  id: string,
  raw: Record<string, unknown>,
): { readonly entry: McpStdioServerEntry } | { readonly error: string } {
  // Stdio is recognized but never initialized in Slice 2. Keep validation light:
  // A well-formed command is enough to represent the entry; an eligible mapping
  // That references it emits an unsupported-transport gap at connect time.
  const { command } = raw;
  if (typeof command !== "string" || command.length === 0) {
    return { error: `server "${id}" stdio entry requires a command` };
  }
  const args =
    Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string")
      ? (raw.args as string[])
      : undefined;
  return {
    entry: {
      id,
      type: "stdio",
      command,
      ...(args !== undefined ? { args } : {}),
    },
  };
}

function validateEntry(
  id: string,
  raw: unknown,
): { readonly entry: McpServerEntry } | { readonly error: string } {
  if (!isRecord(raw)) {
    return { error: `server "${id}" must be an object` };
  }
  const { type } = raw;
  if (type === "http") {
    return validateHttpEntry(id, raw);
  }
  if (type === "stdio") {
    return validateStdioEntry(id, raw);
  }
  return { error: `server "${id}" has unsupported type ${JSON.stringify(type)}` };
}

// Parses catalog content already read into memory. Exposed for tests.
export function parseMcpCatalog(content: string): McpServerCatalog {
  let doc: unknown;
  try {
    doc = JSON.parse(content);
  } catch {
    return catalogFailure("catalog JSON could not be parsed");
  }
  if (!isRecord(doc)) {
    return catalogFailure("catalog root must be an object");
  }
  const { mcpServers } = doc;
  if (mcpServers === undefined) {
    return emptyCatalog();
  }
  if (!isRecord(mcpServers)) {
    return catalogFailure("mcpServers must be an object");
  }

  const servers: McpServerEntry[] = [];
  const gaps: SourceGap[] = [];
  for (const [id, raw] of Object.entries(mcpServers)) {
    const result = validateEntry(id, raw);
    if ("error" in result) {
      gaps.push(mcpCatalogGap(result.error));
      continue;
    }
    servers.push(result.entry);
  }
  return {
    servers,
    declaredServerIds: Object.keys(mcpServers),
    declarationsUnavailable: false,
    gaps,
  };
}

export interface LoadMcpCatalogOptions {
  readonly path?: string;
  readonly cwd?: string;
}

// Reads and parses the catalog file. A missing file yields an empty catalog with
// No gap (nothing configured). All other issues are surfaced as non-fatal gaps.
export async function loadMcpCatalog(
  options: LoadMcpCatalogOptions = {},
): Promise<McpServerCatalog> {
  const path = options.path ?? join(options.cwd ?? process.cwd(), MCP_CATALOG_FILENAME);
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return emptyCatalog();
  }
  let content: string;
  try {
    content = await file.text();
  } catch {
    return catalogFailure("catalog file could not be read");
  }
  return parseMcpCatalog(content);
}

// Resolves a `${VAR}` header template against the environment. Returns the
// Resolved value, or undefined when any referenced variable is unset (the header
// — and therefore the credential — is unavailable). Never logs values.
export function resolveHeaderTemplate(
  template: string,
  env: Record<string, string | undefined>,
): string | undefined {
  let missing = false;
  const resolved = template.replaceAll(ENV_TEMPLATE_RE, (_match, name: string) => {
    const value = env[name];
    if (value === undefined || value === "") {
      missing = true;
      return "";
    }
    return value;
  });
  return missing ? undefined : resolved;
}
