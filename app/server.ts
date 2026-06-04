import { existsSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { resolveResearchConsoleConfig } from "../src/config";

const DIST_DIR = resolve(import.meta.dir, "dist");

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path)] ?? "application/octet-stream";
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

export async function handleResearchConsoleRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
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
    fetch: handleResearchConsoleRequest,
  });

  process.stdout.write(`Research Console listening at http://${config.host}:${config.port}\n`);
}
