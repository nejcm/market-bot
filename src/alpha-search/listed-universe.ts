import { sourceGap } from "../domain/source-gaps";
import type { SourceGap } from "../domain/types";
import {
  isFetchTextResult,
  type RawSourceSnapshot,
  type SourceRequestExecutor,
} from "../sources/types";

const NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
const NASDAQ_OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";
const CBOE_LISTED_CSV_URL =
  "https://www.cboe.com/us/equities/market_statistics/listed_symbols/csv/";
const SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/u;
const MAX_LISTED_UNIVERSE_ROWS = 25_000;
const SUPPORTED_STOCK_NAME_RE =
  /\b(?:common stock|common shares|ordinary shares|american depositary shares|american depositary receipt|adr)\b/iu;
const UNSUPPORTED_STOCK_NAME_RE =
  /\b(?:etf|exchange traded fund|etn|fund|unit|units|warrant|warrants|right|rights|preferred|preference|note|notes|debenture|bond)\b/iu;

export type ListedUniverseSource = "nasdaq-listed" | "nasdaq-other-listed" | "cboe-listed";

export interface ListedUniverseEntry {
  readonly symbol: string;
  readonly name?: string;
  readonly listingVenue?: string;
  readonly source: ListedUniverseSource;
  readonly sourceIds: readonly string[];
  readonly isEtfOrFund?: boolean;
  readonly isActive: boolean;
  readonly isTestIssue?: boolean;
  readonly isSupportedStock?: boolean;
}

export interface ListedUniverseCollectionResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly entries: readonly ListedUniverseEntry[];
  readonly sourceGaps: readonly SourceGap[];
}

export interface ListedUniverseCandidate {
  readonly symbol: string;
  readonly sourceIds: readonly string[];
}

export interface ListedUniverseRejectedCandidate<TCandidate extends ListedUniverseCandidate> {
  readonly candidate: TCandidate;
  readonly reason: string;
}

export interface ListedUniverseCandidateFilterResult<TCandidate extends ListedUniverseCandidate> {
  readonly eligibleCandidates: readonly TCandidate[];
  readonly rejectedCandidates: readonly ListedUniverseRejectedCandidate<TCandidate>[];
}

function normalizeSymbol(value: string | undefined): string | undefined {
  const symbol = value?.trim().toUpperCase();
  return symbol !== undefined && SYMBOL_RE.test(symbol) ? symbol : undefined;
}

function sourceId(source: ListedUniverseSource, symbol: string): string {
  return `listed-universe-${source}-${symbol}`;
}

function parsePipeRows(text: string): readonly Record<string, string>[] {
  const rows = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("File Creation Time"));
  const [headerLine] = rows;
  const lines = rows.slice(1, MAX_LISTED_UNIVERSE_ROWS + 1);
  if (headerLine === undefined) {
    return [];
  }
  const headers = headerLine.split("|").map((header) => header.trim());
  return lines.flatMap((line) => {
    const values = line.split("|");
    if (values.length !== headers.length) {
      return [];
    }
    return [
      Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""])),
    ];
  });
}

function parseCsvLine(line: string): readonly string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}

function parseCsvRows(text: string): readonly Record<string, string>[] {
  const rows = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const [headerLine] = rows;
  const lines = rows.slice(1, MAX_LISTED_UNIVERSE_ROWS + 1);
  if (headerLine === undefined) {
    return [];
  }
  const headers = parseCsvLine(headerLine);
  return lines.flatMap((line) => {
    const values = parseCsvLine(line);
    if (values.length !== headers.length) {
      return [];
    }
    return [
      Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""])),
    ];
  });
}

function parseYesNo(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toUpperCase();
  if (normalized === "Y") {
    return true;
  }
  if (normalized === "N") {
    return false;
  }
  return undefined;
}

function isSupportedStockName(name: string | undefined): boolean {
  return (
    name !== undefined &&
    SUPPORTED_STOCK_NAME_RE.test(name) &&
    !UNSUPPORTED_STOCK_NAME_RE.test(name)
  );
}

export function parseNasdaqListedPayload(text: string): readonly ListedUniverseEntry[] {
  return parsePipeRows(text).flatMap((row) => {
    const symbol = normalizeSymbol(row.Symbol);
    if (symbol === undefined) {
      return [];
    }
    const name = row["Security Name"] === "" ? undefined : row["Security Name"];
    const isEtfOrFund = parseYesNo(row.ETF);
    const isTestIssue = parseYesNo(row["Test Issue"]);
    return [
      {
        symbol,
        ...(name !== undefined ? { name } : {}),
        listingVenue: "NASDAQ",
        source: "nasdaq-listed",
        sourceIds: [sourceId("nasdaq-listed", symbol)],
        ...(isEtfOrFund !== undefined ? { isEtfOrFund } : {}),
        isActive: isTestIssue !== true,
        ...(isTestIssue !== undefined ? { isTestIssue } : {}),
        isSupportedStock: isSupportedStockName(name),
      },
    ];
  });
}

export function parseNasdaqOtherListedPayload(text: string): readonly ListedUniverseEntry[] {
  return parsePipeRows(text).flatMap((row) => {
    const symbol = normalizeSymbol(row["ACT Symbol"]);
    if (symbol === undefined) {
      return [];
    }
    const name = row["Security Name"] === "" ? undefined : row["Security Name"];
    const isEtfOrFund = parseYesNo(row.ETF);
    const isTestIssue = parseYesNo(row["Test Issue"]);
    return [
      {
        symbol,
        ...(name !== undefined ? { name } : {}),
        ...(row.Exchange !== "" ? { listingVenue: row.Exchange } : {}),
        source: "nasdaq-other-listed",
        sourceIds: [sourceId("nasdaq-other-listed", symbol)],
        ...(isEtfOrFund !== undefined ? { isEtfOrFund } : {}),
        isActive: isTestIssue !== true,
        ...(isTestIssue !== undefined ? { isTestIssue } : {}),
        isSupportedStock: isSupportedStockName(name),
      },
    ];
  });
}

export function parseCboeListedPayload(text: string): readonly ListedUniverseEntry[] {
  return parseCsvRows(text).flatMap((row) => {
    const symbol = normalizeSymbol(row.Symbol ?? row.Name);
    if (symbol === undefined) {
      return [];
    }
    return [
      {
        symbol,
        listingVenue: "CBOE",
        source: "cboe-listed",
        sourceIds: [sourceId("cboe-listed", symbol)],
        isActive: true,
      },
    ];
  });
}

function malformedGap(source: ListedUniverseSource, message: string): SourceGap {
  return sourceGap({
    source,
    provider: source,
    capability: "market-data",
    cause: "malformed-response",
    evidenceQualityImpact: "core-cap",
    message,
  });
}

function entriesFromText(
  result: Awaited<ReturnType<SourceRequestExecutor["text"]>>,
  parser: (text: string) => readonly ListedUniverseEntry[],
  source: ListedUniverseSource,
): {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly entries: readonly ListedUniverseEntry[];
  readonly sourceGaps: readonly SourceGap[];
} {
  if (!isFetchTextResult(result)) {
    return { rawSnapshots: [], entries: [], sourceGaps: [result] };
  }
  const entries = parser(result.payload);
  return entries.length === 0
    ? {
        rawSnapshots: [result.rawSnapshot],
        entries: [],
        sourceGaps: [malformedGap(source, `${source} response did not include listed symbols`)],
      }
    : { rawSnapshots: [result.rawSnapshot], entries, sourceGaps: [] };
}

export async function collectListedUniverse(
  request: SourceRequestExecutor,
): Promise<ListedUniverseCollectionResult> {
  const [nasdaqListed, nasdaqOtherListed, cboeListed] = await Promise.all([
    request.text({ url: NASDAQ_LISTED_URL, adapter: "nasdaq-listed" }),
    request.text({ url: NASDAQ_OTHER_LISTED_URL, adapter: "nasdaq-other-listed" }),
    request.text({ url: CBOE_LISTED_CSV_URL, adapter: "cboe-listed" }),
  ]);
  const parsed = [
    entriesFromText(nasdaqListed, parseNasdaqListedPayload, "nasdaq-listed"),
    entriesFromText(nasdaqOtherListed, parseNasdaqOtherListedPayload, "nasdaq-other-listed"),
    entriesFromText(cboeListed, parseCboeListedPayload, "cboe-listed"),
  ];

  return {
    rawSnapshots: parsed.flatMap((item) => item.rawSnapshots),
    entries: parsed.flatMap((item) => item.entries),
    sourceGaps: parsed.flatMap((item) => item.sourceGaps),
  };
}

function rejectionReason(entries: readonly ListedUniverseEntry[] | undefined): string | undefined {
  if (entries === undefined || entries.length === 0) {
    return "Official listing universe did not resolve candidate";
  }
  if (entries.every((entry) => entry.isTestIssue === true)) {
    return "Official listing universe marks candidate as test issue";
  }
  if (entries.every((entry) => !entry.isActive)) {
    return "Official listing universe marks candidate as inactive";
  }
  if (entries.some((entry) => entry.isEtfOrFund === true)) {
    return "Official listing universe marks candidate as ETF or fund";
  }
  if (!entries.some((entry) => entry.isSupportedStock === true)) {
    return "Official listing universe marks candidate as unsupported listing type";
  }
  return undefined;
}

export function filterListedUniverseCandidates<TCandidate extends ListedUniverseCandidate>(input: {
  readonly candidates: readonly TCandidate[];
  readonly entries: readonly ListedUniverseEntry[];
}): ListedUniverseCandidateFilterResult<TCandidate> {
  const entriesBySymbol = new Map<string, ListedUniverseEntry[]>();
  for (const entry of input.entries) {
    entriesBySymbol.set(entry.symbol, [...(entriesBySymbol.get(entry.symbol) ?? []), entry]);
  }
  const validations = input.candidates.map((candidate) => {
    const reason = rejectionReason(entriesBySymbol.get(candidate.symbol));
    return reason === undefined ? { candidate, reason: undefined } : { candidate, reason };
  });

  return {
    eligibleCandidates: validations.flatMap((validation) =>
      validation.reason === undefined ? [validation.candidate] : [],
    ),
    rejectedCandidates: validations.flatMap((validation) =>
      validation.reason === undefined
        ? []
        : [{ candidate: validation.candidate, reason: validation.reason }],
    ),
  };
}
