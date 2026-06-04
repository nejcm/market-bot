import { existsSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { resolveResearchConsoleConfig } from "../src/config";
import { listRunSummaries, readProviderHealth, readRunDetail, readRunFile } from "./artifacts";

const DIST_DIR = resolve(import.meta.dir, "dist");

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

interface ResearchConsoleRequestOptions {
  readonly dataDir?: string;
}

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isWithinDirectory(root: string, path: string): boolean {
  const childPath = relative(root, path);
  return childPath === "" || (!childPath.startsWith("..") && !isAbsolute(childPath));
}

function decodePathname(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}

function hasParentSegment(pathname: string): boolean {
  return pathname.split(/[\\/]/u).includes("..");
}

export function researchConsoleStaticPath(
  pathname: string,
  distDir: string = DIST_DIR,
): string | undefined {
  const decoded = decodePathname(pathname);
  if (decoded === undefined || hasParentSegment(decoded)) {
    return undefined;
  }

  const normalizedPath = normalize(decoded).replace(/^([/\\])+/u, "");
  const candidate = resolve(distDir, normalizedPath === "" ? "index.html" : normalizedPath);

  if (!isWithinDirectory(distDir, candidate)) {
    return undefined;
  }

  if (existsSync(candidate)) {
    return candidate;
  }

  const indexPath = join(distDir, "index.html");
  return existsSync(indexPath) ? indexPath : undefined;
}

async function handleApiRequest(url: URL, dataDir: string): Promise<Response | undefined> {
  if (url.pathname === "/api/runs") {
    return jsonResponse({ runs: await listRunSummaries(dataDir) });
  }

  if (url.pathname === "/api/provider-health") {
    return jsonResponse(await readProviderHealth(dataDir));
  }

  const fileMatch = /^\/api\/runs\/([^/]+)\/files$/u.exec(url.pathname);
  if (fileMatch !== null) {
    const runId = decodePathname(fileMatch[1] ?? "");
    const requestedPath = url.searchParams.get("path");
    if (runId === undefined || requestedPath === null) {
      return jsonResponse({ error: "Invalid file request" }, 400);
    }

    const file = await readRunFile(dataDir, runId, requestedPath);
    return file === undefined ? jsonResponse({ error: "File not found" }, 404) : jsonResponse(file);
  }

  const runMatch = /^\/api\/runs\/([^/]+)$/u.exec(url.pathname);
  if (runMatch !== null) {
    const runId = decodePathname(runMatch[1] ?? "");
    if (runId === undefined) {
      return jsonResponse({ error: "Invalid run id" }, 400);
    }

    const detail = await readRunDetail(dataDir, runId);
    return detail === undefined
      ? jsonResponse({ error: "Run not found" }, 404)
      : jsonResponse(detail);
  }

  if (url.pathname.startsWith("/api/")) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  return undefined;
}

export async function handleResearchConsoleRequest(
  request: Request,
  options: ResearchConsoleRequestOptions = {},
): Promise<Response> {
  const url = new URL(request.url);
  const config = resolveResearchConsoleConfig();
  const apiResponse = await handleApiRequest(url, options.dataDir ?? config.dataDir);
  if (apiResponse !== undefined) {
    return apiResponse;
  }

  const path = researchConsoleStaticPath(url.pathname);

  if (path === undefined) {
    return new Response("Research Console assets not built. Run bun run console:build.\n", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(Bun.file(path), {
    headers: { "content-type": contentType(path) },
  });
}

if (import.meta.main) {
  const config = resolveResearchConsoleConfig();

  Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch: (request) => handleResearchConsoleRequest(request),
  });

  process.stdout.write(`Research Console listening at http://${config.host}:${config.port}\n`);
}
