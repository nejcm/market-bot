import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFinancialTablePacket } from "../src/sources/extended-evidence/untagged-financial-table-packet";
import {
  parseFinancialTableMappingOutput,
  validateFinancialTableMapping,
} from "../src/sources/extended-evidence/untagged-financial-table-validation";

const CORPUS_DIR = join(import.meta.dir, "..", "tests", "fixtures", "untagged-financial-corpus");
const URL =
  "https://www.sec.gov/Archives/edgar/data/1513845/000110465926064092/nbis-20260331xex99d2.htm";
const SOURCE = {
  url: URL,
  accessionNumber: "0001104659-26-064092",
  documentName: "nbis-20260331xex99d2.htm",
  filedAt: "2026-05-20",
  form: "6-K" as const,
};
const USER_AGENT =
  process.env.MARKET_BOT_SEC_USER_AGENT ?? "market-bot phase3 live verification phase3@example.com";

function valueSummary(
  validation: ReturnType<typeof validateFinancialTableMapping>,
): readonly Record<string, unknown>[] {
  return validation.values.map((value) => ({
    field: value.field,
    displayedValue: value.displayedValue,
    periodEnd: value.periodEnd,
    valueCellRef: value.trace.valueCellRef,
    ...(value.trace.signCellRef !== undefined ? { signCellRef: value.trace.signCellRef } : {}),
  }));
}

const fixtureHtml = await readFile(join(CORPUS_DIR, "raw", "nbis-2026-q1.html"), "utf8");
const mappingOutput = parseFinancialTableMappingOutput(
  await readFile(join(CORPUS_DIR, "mappings", "nbis-2026-q1.json"), "utf8"),
);
if (!("mapping" in mappingOutput)) {
  throw new Error("NBIS mapping cassette is invalid");
}
const fixturePacket = await buildFinancialTablePacket(fixtureHtml, SOURCE);
const fixtureValidation = validateFinancialTableMapping({
  packet: fixturePacket,
  mapping: mappingOutput.mapping,
  filingReportDate: "2026-03-31",
});

let comparison: Record<string, unknown> = {};
try {
  const response = await fetch(URL, { headers: { "user-agent": USER_AGENT } });
  if (!response.ok) {
    throw new Error(`SEC returned HTTP ${String(response.status)}`);
  }
  const liveHtml = await response.text();
  const livePacket = await buildFinancialTablePacket(liveHtml, SOURCE);
  const liveValidation = validateFinancialTableMapping({
    packet: livePacket,
    mapping: mappingOutput.mapping,
    filingReportDate: "2026-03-31",
  });
  const fixtureValues = valueSummary(fixtureValidation);
  const liveValues = valueSummary(liveValidation);
  comparison = {
    version: 1,
    checkedAt: "2026-07-23T00:00:00.000Z",
    reachable: true,
    url: URL,
    fixturePacketSha256: fixturePacket.source.sha256,
    livePacketSha256: livePacket.source.sha256,
    byteIdentical: fixturePacket.source.sha256 === livePacket.source.sha256,
    fixtureStatus: fixtureValidation.status,
    liveStatus: liveValidation.status,
    valueCount: liveValues.length,
    cellValuesIdentical: JSON.stringify(fixtureValues) === JSON.stringify(liveValues),
  };
} catch (error) {
  comparison = {
    version: 1,
    checkedAt: "2026-07-23T00:00:00.000Z",
    reachable: false,
    url: URL,
    fixturePacketSha256: fixturePacket.source.sha256,
    fixtureStatus: fixtureValidation.status,
    error: error instanceof Error ? error.message : String(error),
  };
}

const serialized = `${JSON.stringify(comparison, null, 2)}\n`;
if (process.argv.includes("--write")) {
  await writeFile(join(CORPUS_DIR, "nbis-live-comparison.json"), serialized, "utf8");
} else {
  process.stdout.write(serialized);
}

if (
  comparison.reachable !== true ||
  comparison.liveStatus !== "accepted" ||
  comparison.cellValuesIdentical !== true
) {
  process.exitCode = 1;
}
