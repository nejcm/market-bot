export function isSameOriginPost(request: Request, url: URL): boolean {
  // Fetch Metadata (sec-fetch-site) is browser-set and cannot be forged by scripts.
  // When present it is the authoritative signal, so we trust it directly.
  // This also fixes the dev proxy: the client and API run on different ports, so the
  // Origin host never matches the request host.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null) {
    return fetchSite !== "cross-site";
  }

  // Fallback for clients without Fetch Metadata: compare Origin to the request host.
  const origin = request.headers.get("origin");
  if (origin === null) {
    return true;
  }

  try {
    const originUrl = new URL(origin);
    return originUrl.protocol === url.protocol && originUrl.host === url.host;
  } catch {
    return false;
  }
}
