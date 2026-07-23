import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveConfig } from "../src/config";
import { sourceGapStatusCode } from "../src/domain/source-gaps";
import { createCollectContext } from "../src/sources/source-request";
import { isFetchJsonResult } from "../src/sources/types";
import { encodeQuery } from "../src/sources/extended-evidence/utils";

type ProbeStatus = "available" | "forbidden-403" | "missing-credential" | "error";

interface ProbeResult {
  readonly endpoint: string;
  readonly status: ProbeStatus;
  readonly observedAt: string;
}

interface CandidateEndpoint {
  readonly endpoint: string;
  readonly params: Readonly<Record<string, string>>;
}

const OUTPUT_PATH = join("data", "provider-health", "feasibility.json");
const SYMBOL = "AAPL";
const observedAt = new Date().toISOString();
const from = observedAt.slice(0, 10);
const to = new Date(Date.parse(observedAt) + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const candidates: readonly CandidateEndpoint[] = [
  { endpoint: "/calendar/earnings", params: { symbol: SYMBOL, from, to } },
  { endpoint: "/stock/dividend", params: { symbol: SYMBOL, from, to } },
  { endpoint: "/stock/split", params: { symbol: SYMBOL, from, to } },
  { endpoint: "/stock/eps-estimate", params: { symbol: SYMBOL, freq: "quarterly" } },
  { endpoint: "/stock/revenue-estimate", params: { symbol: SYMBOL, freq: "quarterly" } },
  { endpoint: "/stock/ebitda-estimate", params: { symbol: SYMBOL, freq: "quarterly" } },
  { endpoint: "/stock/earnings", params: { symbol: SYMBOL, limit: "1" } },
  { endpoint: "/stock/price-target", params: { symbol: SYMBOL } },
];

const config = resolveConfig(process.env, { validateAlphaSearchOptions: false });
const command = {
  jobType: "equity",
  assetClass: "equity",
  symbol: SYMBOL,
  depth: "brief",
} as const;
const { context } = createCollectContext(command, config.sourceOptions, new Date(observedAt));

async function probe(candidate: CandidateEndpoint): Promise<ProbeResult> {
  if (context.finnhubApiToken === undefined) {
    return { endpoint: candidate.endpoint, status: "missing-credential", observedAt };
  }
  const query = encodeQuery({ ...candidate.params, token: context.finnhubApiToken });
  const result = await context.request.json({
    url: `https://finnhub.io/api/v1${candidate.endpoint}?${query}`,
    adapter: `finnhub-feasibility-${candidate.endpoint.slice(1).replaceAll("/", "-")}`,
  });
  if (isFetchJsonResult(result)) {
    return { endpoint: candidate.endpoint, status: "available", observedAt };
  }
  return {
    endpoint: candidate.endpoint,
    status: sourceGapStatusCode(result.message) === "403" ? "forbidden-403" : "error",
    observedAt,
  };
}

const results = await Promise.all(candidates.map((candidate) => probe(candidate)));
await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`, "utf8");
process.stdout.write(`${OUTPUT_PATH}\n`);
