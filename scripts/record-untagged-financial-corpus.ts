import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface CorpusSpec {
  readonly id: string;
  readonly symbol: string;
  readonly accessionNumber: string;
  readonly documentName: string;
  readonly filedAt: string;
  readonly reportDate: string;
  readonly layoutFamily: string;
  readonly expectedSupport: "html-table" | "html-of-image";
  readonly url: string;
}

const CORPUS_DIR = join(import.meta.dir, "..", "tests", "fixtures", "untagged-financial-corpus");
const RAW_DIR = join(CORPUS_DIR, "raw");
const USER_AGENT =
  process.env.MARKET_BOT_SEC_USER_AGENT ?? "market-bot phase3 corpus recorder phase3@example.com";
const SPECS: readonly CorpusSpec[] = [
  {
    id: "nbis-2026-q1",
    symbol: "NBIS",
    accessionNumber: "0001104659-26-064092",
    documentName: "nbis-20260331xex99d2.htm",
    filedAt: "2026-05-20",
    reportDate: "2026-03-31",
    layoutFamily: "toppan-spacer-grid",
    expectedSupport: "html-table",
    url: "https://www.sec.gov/Archives/edgar/data/1513845/000110465926064092/nbis-20260331xex99d2.htm",
  },
  {
    id: "se-2026-q1",
    symbol: "SE",
    accessionNumber: "0001193125-26-219378",
    documentName: "d78490dex991.htm",
    filedAt: "2026-05-12",
    reportDate: "2026-03-31",
    layoutFamily: "merrill-spacer-grid",
    expectedSupport: "html-table",
    url: "https://www.sec.gov/Archives/edgar/data/1703399/000119312526219378/d78490dex991.htm",
  },
  {
    id: "pdd-2026-q1",
    symbol: "PDD",
    accessionNumber: "0001104659-26-067186",
    documentName: "tm2615739d1_ex99-1.htm",
    filedAt: "2026-05-28",
    reportDate: "2026-03-31",
    layoutFamily: "toppan-spacer-grid",
    expectedSupport: "html-table",
    url: "https://www.sec.gov/Archives/edgar/data/1737806/000110465926067186/tm2615739d1_ex99-1.htm",
  },
  {
    id: "spot-2026-q1",
    symbol: "SPOT",
    accessionNumber: "0001628280-26-027951",
    documentName: "spot-20260331x6xk.htm",
    filedAt: "2026-04-28",
    reportDate: "2026-03-31",
    layoutFamily: "inline-xhtml",
    expectedSupport: "html-table",
    url: "https://www.sec.gov/Archives/edgar/data/1639920/000162828026027951/spot-20260331x6xk.htm",
  },
  {
    id: "arm-2026-fy",
    symbol: "ARM",
    accessionNumber: "0001973239-26-000062",
    documentName: "exhibit992fye26q431-marx26.htm",
    filedAt: "2026-05-06",
    reportDate: "2026-03-31",
    layoutFamily: "issuer-native-grid",
    expectedSupport: "html-table",
    url: "https://www.sec.gov/Archives/edgar/data/1973239/000197323926000062/exhibit992fye26q431-marx26.htm",
  },
  {
    id: "tsm-2026-q2",
    symbol: "TSM",
    accessionNumber: "0001046179-26-000451",
    documentName: "a2q26e_withguidancexfinal.htm",
    filedAt: "2026-07-16",
    reportDate: "2026-06-30",
    layoutFamily: "issuer-native-grid",
    expectedSupport: "html-table",
    url: "https://www.sec.gov/Archives/edgar/data/1046179/000104617926000451/a2q26e_withguidancexfinal.htm",
  },
  {
    id: "nvo-2026-q1",
    symbol: "NVO",
    accessionNumber: "0000353278-26-000018",
    documentName: "caq12026.htm",
    filedAt: "2026-05-06",
    reportDate: "2026-03-31",
    layoutFamily: "inline-xhtml",
    expectedSupport: "html-table",
    url: "https://www.sec.gov/Archives/edgar/data/353278/000035327826000018/caq12026.htm",
  },
  {
    id: "baba-2026-fy",
    symbol: "BABA",
    accessionNumber: "0001104659-26-060224",
    documentName: "tm2614494d1_ex99-1.htm",
    filedAt: "2026-05-13",
    reportDate: "2026-03-31",
    layoutFamily: "toppan-spacer-grid",
    expectedSupport: "html-table",
    url: "https://www.sec.gov/Archives/edgar/data/1577552/000110465926060224/tm2614494d1_ex99-1.htm",
  },
  {
    id: "grab-2026-q1",
    symbol: "GRAB",
    accessionNumber: "0001855612-26-000077",
    documentName: "a42026q1-earningspressrele.htm",
    filedAt: "2026-05-05",
    reportDate: "2026-03-31",
    layoutFamily: "inline-xhtml",
    expectedSupport: "html-table",
    url: "https://www.sec.gov/Archives/edgar/data/1855612/000185561226000077/a42026q1-earningspressrele.htm",
  },
  {
    id: "asml-2026-q2-image",
    symbol: "ASML",
    accessionNumber: "0001628280-26-048235",
    documentName: "financialstatementsusgaa.htm",
    filedAt: "2026-07-15",
    reportDate: "2026-06-28",
    layoutFamily: "html-image-wrapper",
    expectedSupport: "html-of-image",
    url: "https://www.sec.gov/Archives/edgar/data/937966/000162828026048235/financialstatementsusgaa.htm",
  },
];

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(value).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function evaluationClass(
  spec: CorpusSpec,
): "insufficient-statement-coverage" | "supported-full-statement" | "unsupported-layout" {
  if (spec.expectedSupport === "html-of-image") {
    return "unsupported-layout";
  }
  return spec.id === "tsm-2026-q2" ? "insufficient-statement-coverage" : "supported-full-statement";
}

await mkdir(RAW_DIR, { recursive: true });
const cases = [];
for (const spec of SPECS) {
  // SEC corpus recording stays sequential to respect the public endpoint's rate limits.
  // eslint-disable-next-line no-await-in-loop
  const response = await fetch(spec.url, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`SEC corpus request failed (${String(response.status)}): ${spec.url}`);
  }
  // eslint-disable-next-line no-await-in-loop
  const bytes = new Uint8Array(await response.arrayBuffer());
  const rawFile = `raw/${spec.id}.html`;
  // eslint-disable-next-line no-await-in-loop
  await writeFile(join(CORPUS_DIR, rawFile), bytes);
  cases.push({
    ...spec,
    evaluationClass: evaluationClass(spec),
    rawFile,
    mappingFile: `mappings/${spec.id}.json`,
    // Corpus integrity is tied to the exact public filing bytes.
    // eslint-disable-next-line no-await-in-loop
    sha256: await sha256Hex(bytes),
    bytes: bytes.byteLength,
    contentType: response.headers.get("content-type") ?? "text/html",
    lastModified: response.headers.get("last-modified"),
  });
}

await writeFile(
  join(CORPUS_DIR, "manifest.json"),
  `${JSON.stringify({ version: 1, recordedAt: "2026-07-23", cases }, null, 2)}\n`,
  "utf8",
);
