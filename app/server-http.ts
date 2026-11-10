export const INSTRUMENT_SYMBOL_PATTERN = /^[A-Z0-9._-]{1,20}$/u;

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function decodePathname(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
}

export function isAssetClass(value: string): value is "equity" | "crypto" {
  return value === "equity" || value === "crypto";
}

export async function readRequestJson(request: Request): Promise<unknown> {
  try {
    return (await request.json()) as unknown;
  } catch {
    throw new Error("Request body must be JSON");
  }
}
