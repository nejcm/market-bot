import type { AlphaSearchCandidate, AlphaSearchSecFiling } from "./candidates";
import { sourceGap } from "../domain/source-gaps";
import type { SourceGap } from "../domain/types";
import { isRecord, readNumber, readString } from "../sources/guards";
import {
  isFetchJsonResult,
  isFetchTextResult,
  type RawSourceSnapshot,
  type SourceRequestExecutor,
} from "../sources/types";

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const SEC_CURRENT_FILINGS_URL = "https://www.sec.gov/cgi-bin/browse-edgar";
const CIK_RE = /\bCIK(?:=|:)?\s*0*(\d{1,10})\b/iu;
const TITLE_CIK_RE = /\(0*(\d{1,10})\)\s*\(Filer\)/iu;
const ACCESSION_RE = /\b\d{10}-\d{2}-\d{6}\b/u;
const FILED_DATE_RE = /\bFiled:\s*(\d{4}-\d{2}-\d{2})\b/iu;
const SEC_SYMBOL_RE = /^[A-Z][A-Z0-9.-]{0,9}$/u;
const MAX_SEC_NAME_LENGTH = 160;

export interface SecDiscoveryOptions {
  readonly formTypes: readonly string[];
  readonly candidateLimit: number;
  readonly secUserAgent?: string;
  readonly request: SourceRequestExecutor;
}

export interface SecDiscoveryCandidate extends AlphaSearchCandidate {
  readonly discoverySources: readonly ["sec-filings"];
  readonly secCik: string;
  readonly secCompanyName: string;
  readonly recentSecFilings: readonly [AlphaSearchSecFiling, ...AlphaSearchSecFiling[]];
}

export interface SecDiscoveryResult {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly candidates: readonly SecDiscoveryCandidate[];
  readonly sourceGaps: readonly SourceGap[];
}

interface SecTickerMapping {
  readonly cik: string;
  readonly ticker: string;
  readonly name: string;
}

interface SecFeedEntry {
  readonly form: string;
  readonly filingDate: string;
  readonly reportDate?: string;
  readonly accessionNumber?: string;
  readonly cik?: string;
  readonly companyName?: string;
  readonly sourceId: string;
}

function secRequestInit(userAgent: string | undefined, accept: string): RequestInit | undefined {
  return {
    headers: {
      accept,
      ...(userAgent !== undefined ? { "user-agent": userAgent } : {}),
    },
  };
}

function currentFilingsUrl(formType: string): string {
  const params = new URLSearchParams({
    action: "getcurrent",
    CIK: "",
    type: formType,
    company: "",
    dateb: "",
    owner: "include",
    start: "0",
    count: "40",
    output: "atom",
  });
  return `${SEC_CURRENT_FILINGS_URL}?${params.toString()}`;
}

function decodeXmlEntities(value: string): string {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function tagText(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "iu").exec(xml);
  return match?.[1] === undefined ? undefined : decodeXmlEntities(match[1].trim());
}

function entryXml(atom: string): readonly string[] {
  return [...atom.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/giu)].map((match) => match[0]);
}

function sourceIdFor(
  form: string,
  cik: string | undefined,
  accessionNumber: string | undefined,
): string {
  return `sec-alpha-search-${form}-${cik ?? "unknown"}-${accessionNumber ?? "no-accession"}`;
}

function parseCik(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = CIK_RE.exec(value);
  return match?.[1] === undefined ? undefined : match[1].padStart(10, "0");
}

function parseTitleCik(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = TITLE_CIK_RE.exec(value);
  return match?.[1] === undefined ? undefined : match[1].padStart(10, "0");
}

function parseAccession(value: string | undefined): string | undefined {
  return value === undefined ? undefined : ACCESSION_RE.exec(value)?.[0];
}

function parseFiledDate(value: string | undefined): string | undefined {
  return value === undefined ? undefined : FILED_DATE_RE.exec(value)?.[1];
}

function parseCompanyName(title: string | undefined): string | undefined {
  if (title === undefined) {
    return undefined;
  }
  const withoutForm = title.replace(/^\s*[0-9A-Z-]+\s*-\s*/u, "");
  return withoutForm.split("(")[0]?.trim() || undefined;
}

function normalizeSecTicker(value: string | undefined): string | undefined {
  const ticker = value?.trim().toUpperCase();
  return ticker !== undefined && SEC_SYMBOL_RE.test(ticker) ? ticker : undefined;
}

function withoutControlCharacters(value: string): string {
  return [...value]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code <= 31 || code === 127 ? " " : char;
    })
    .join("");
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const name =
    value === undefined
      ? undefined
      : withoutControlCharacters(value).replaceAll(/\s+/gu, " ").trim();
  return name === undefined || name === "" ? undefined : name.slice(0, MAX_SEC_NAME_LENGTH);
}

function malformedSecGap(message: string): SourceGap {
  return sourceGap({
    source: "sec-alpha-search",
    provider: "sec-edgar",
    capability: "market-data",
    cause: "malformed-response",
    evidenceQualityImpact: "no-cap",
    message,
  });
}

export function parseSecCurrentFilingsAtom(
  atom: string,
  formType: string,
): readonly SecFeedEntry[] {
  return entryXml(atom).flatMap((entry) => {
    const title = tagText(entry, "title");
    const updated = tagText(entry, "updated");
    const summary = tagText(entry, "summary");
    const id = tagText(entry, "id");
    const filingDate =
      tagText(entry, "filing-date") ?? parseFiledDate(summary) ?? updated?.slice(0, 10);
    if (filingDate === undefined) {
      return [];
    }
    const cik = parseCik(summary) ?? parseCik(title) ?? parseTitleCik(title) ?? parseCik(id);
    const accessionNumber = parseAccession(id) ?? parseAccession(summary) ?? parseAccession(title);
    const reportDate = tagText(entry, "period");
    const companyName = parseCompanyName(title);
    return [
      {
        form: formType,
        filingDate,
        ...(reportDate !== undefined ? { reportDate } : {}),
        ...(accessionNumber !== undefined ? { accessionNumber } : {}),
        ...(cik !== undefined ? { cik } : {}),
        ...(companyName !== undefined ? { companyName } : {}),
        sourceId: sourceIdFor(formType, cik, accessionNumber),
      },
    ];
  });
}

export function readSecTickerMappings(payload: unknown): readonly SecTickerMapping[] {
  if (!isRecord(payload)) {
    return [];
  }
  return Object.values(payload).flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const ticker = normalizeSecTicker(readString(entry, "ticker"));
    const cikNumber = readNumber(entry, "cik_str");
    const name = normalizeDisplayName(readString(entry, "title"));
    if (ticker === undefined || cikNumber === undefined || name === undefined) {
      return [];
    }
    return [{ ticker, name, cik: String(cikNumber).padStart(10, "0") }];
  });
}

function rankCandidates(
  candidates: readonly SecDiscoveryCandidate[],
  formTypes: readonly string[],
): readonly SecDiscoveryCandidate[] {
  const formPriority = new Map(formTypes.map((form, index) => [form, index]));
  return candidates.toSorted((left, right) => {
    const [leftFiling] = left.recentSecFilings;
    const [rightFiling] = right.recentSecFilings;
    return (
      (formPriority.get(leftFiling.form) ?? formTypes.length) -
        (formPriority.get(rightFiling.form) ?? formTypes.length) ||
      rightFiling.filingDate.localeCompare(leftFiling.filingDate) ||
      left.symbol.localeCompare(right.symbol)
    );
  });
}

function candidateFromEntry(entry: SecFeedEntry, mapping: SecTickerMapping): SecDiscoveryCandidate {
  const filing: AlphaSearchSecFiling = {
    form: entry.form,
    filingDate: entry.filingDate,
    ...(entry.reportDate !== undefined ? { reportDate: entry.reportDate } : {}),
    ...(entry.accessionNumber !== undefined ? { accessionNumber: entry.accessionNumber } : {}),
    sourceIds: [entry.sourceId],
  };
  return {
    symbol: mapping.ticker,
    name: mapping.name,
    sourceIds: [entry.sourceId],
    discoverySources: ["sec-filings"],
    secCik: mapping.cik,
    secCompanyName: mapping.name,
    recentSecFilings: [filing],
  };
}

function missingMappingGap(entry: SecFeedEntry): SourceGap {
  return sourceGap({
    source: "sec-alpha-search",
    provider: "sec-edgar",
    capability: "market-data",
    cause: "unsupported-coverage",
    evidenceQualityImpact: "no-cap",
    message: `SEC filing ${entry.form} ${entry.filingDate} did not map to a ticker`,
  });
}

function mergeSecCandidates(
  candidates: readonly SecDiscoveryCandidate[],
): readonly SecDiscoveryCandidate[] {
  const bySymbol = new Map<string, SecDiscoveryCandidate>();
  for (const candidate of candidates) {
    const existing = bySymbol.get(candidate.symbol);
    if (existing === undefined) {
      bySymbol.set(candidate.symbol, candidate);
      continue;
    }
    const filings = [...existing.recentSecFilings, ...candidate.recentSecFilings] as [
      AlphaSearchSecFiling,
      ...AlphaSearchSecFiling[],
    ];
    bySymbol.set(candidate.symbol, {
      ...existing,
      sourceIds: [...new Set([...existing.sourceIds, ...candidate.sourceIds])],
      recentSecFilings: filings,
    });
  }
  return [...bySymbol.values()];
}

export async function discoverSecAlphaSearchCandidates(
  options: SecDiscoveryOptions,
): Promise<SecDiscoveryResult> {
  if (options.candidateLimit <= 0 || options.formTypes.length === 0) {
    return { rawSnapshots: [], candidates: [], sourceGaps: [] };
  }
  const tickers = await options.request.json({
    url: SEC_TICKERS_URL,
    adapter: "sec-alpha-search-tickers",
    init: secRequestInit(options.secUserAgent, "application/json"),
  });
  if (!isFetchJsonResult(tickers)) {
    return { rawSnapshots: [], candidates: [], sourceGaps: [tickers] };
  }
  const mappings = readSecTickerMappings(tickers.payload);
  if (mappings.length === 0) {
    return {
      rawSnapshots: [tickers.rawSnapshot],
      candidates: [],
      sourceGaps: [
        malformedSecGap("SEC company ticker mapping response did not include usable tickers"),
      ],
    };
  }
  const mappingsByCik = new Map(mappings.map((item) => [item.cik, item]));
  const feeds = await Promise.all(
    options.formTypes.map((formType) =>
      options.request.text({
        url: currentFilingsUrl(formType),
        adapter: `sec-alpha-search-current-${formType.toLowerCase()}`,
        init: secRequestInit(options.secUserAgent, "application/atom+xml"),
      }),
    ),
  );
  const rawSnapshots = [
    tickers.rawSnapshot,
    ...feeds.flatMap((feed) => (isFetchTextResult(feed) ? [feed.rawSnapshot] : [])),
  ];
  const fetchGaps = feeds.filter((feed): feed is SourceGap => !isFetchTextResult(feed));
  const parsedFeeds = feeds.map((feed, index) => {
    if (!isFetchTextResult(feed)) {
      return { entries: [], sourceGaps: [] };
    }
    const entries = parseSecCurrentFilingsAtom(feed.payload, options.formTypes[index] ?? "UNKNOWN");
    const hasEntryXml = entryXml(feed.payload).length > 0;
    const isAtom = /<feed(?:\s|>)/iu.test(feed.payload);
    const sourceGaps =
      !isAtom || (hasEntryXml && entries.length === 0)
        ? [
            malformedSecGap(
              `SEC current filings response for ${options.formTypes[index] ?? "UNKNOWN"} was malformed`,
            ),
          ]
        : [];
    return { entries, sourceGaps };
  });
  const entries = parsedFeeds.flatMap((feed) => feed.entries);
  const candidates = entries.flatMap((entry) => {
    const mapping = entry.cik === undefined ? undefined : mappingsByCik.get(entry.cik);
    return mapping === undefined ? [] : [candidateFromEntry(entry, mapping)];
  });
  const mappingGaps = entries.flatMap((entry) => {
    const mapping = entry.cik === undefined ? undefined : mappingsByCik.get(entry.cik);
    return mapping === undefined ? [missingMappingGap(entry)] : [];
  });

  return {
    rawSnapshots,
    candidates: rankCandidates(mergeSecCandidates(candidates), options.formTypes).slice(
      0,
      options.candidateLimit,
    ),
    sourceGaps: [...fetchGaps, ...parsedFeeds.flatMap((feed) => feed.sourceGaps), ...mappingGaps],
  };
}
