import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface UnsupportedInputSpec {
  readonly file: string;
  readonly form: "20-F" | "6-K";
  readonly role: "annual-filing" | "interim-filing" | "interim-exhibit";
  readonly url: string;
}

const FIXTURE_DIR = join(import.meta.dir, "..", "tests", "fixtures", "runs", "equity-nbis-deep");
const OUTPUT_DIR = join(FIXTURE_DIR, "unsupported-inputs");
const USER_AGENT =
  process.env.MARKET_BOT_SEC_USER_AGENT ?? "market-bot phase-0 fixture recorder phase0@example.com";
const INPUTS: readonly UnsupportedInputSpec[] = [
  {
    file: "nbis-20251231x20f.txt",
    form: "20-F",
    role: "annual-filing",
    url: "https://www.sec.gov/Archives/edgar/data/1513845/000110465926052948/nbis-20251231x20f.htm",
  },
  {
    file: "nbis-20260331x6k.txt",
    form: "6-K",
    role: "interim-filing",
    url: "https://www.sec.gov/Archives/edgar/data/1513845/000110465926064092/nbis-20260331x6k.htm",
  },
  {
    file: "nbis-20260331xex99d1.txt",
    form: "6-K",
    role: "interim-exhibit",
    url: "https://www.sec.gov/Archives/edgar/data/1513845/000110465926064092/nbis-20260331xex99d1.htm",
  },
  {
    file: "nbis-20260331xex99d2.txt",
    form: "6-K",
    role: "interim-exhibit",
    url: "https://www.sec.gov/Archives/edgar/data/1513845/000110465926064092/nbis-20260331xex99d2.htm",
  },
];

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

await mkdir(OUTPUT_DIR, { recursive: true });
const recorded = await Promise.all(
  INPUTS.map(async (input) => {
    const response = await fetch(input.url, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) {
      throw new Error(`SEC fixture request failed (${String(response.status)}): ${input.url}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(join(OUTPUT_DIR, input.file), bytes);
    return {
      ...input,
      sha256: await sha256Hex(bytes),
      bytes: bytes.byteLength,
      contentType: response.headers.get("content-type") ?? "text/html",
      lastModified: response.headers.get("last-modified"),
      structuredSupport: "unsupported" as const,
      reason:
        input.form === "20-F"
          ? "Phase 0 baseline: current structured SEC normalization accepts only 10-K/10-Q facts"
          : "Phase 0 baseline: untagged interim 6-K HTML is retained but not normalized",
    };
  }),
);

await writeFile(
  join(FIXTURE_DIR, "unsupported-inputs.json"),
  `${JSON.stringify(
    {
      version: 1,
      issuer: { symbol: "NBIS", name: "Nebius Group N.V.", cik: "0001513845" },
      inputs: recorded,
    },
    null,
    2,
  )}\n`,
  "utf8",
);
