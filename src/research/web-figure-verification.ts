import type { FigureQuote, WebFigureFailure, WebFigureFailureReason } from "../domain/report";
import type { Source } from "../domain/sources";
import { isRecord } from "../guards";
import { canonicalizeUrl } from "../sources/news-utils";

export interface WebSourceTexts {
  // Normalized stored text per web Source id; an empty list means the source kept nothing to check.
  readonly web: ReadonlyMap<string, readonly string[]>;
  readonly deterministic: ReadonlySet<string>;
}

interface WebFigureClaim {
  readonly text: string;
  readonly sourceIds: readonly string[];
  readonly figureQuotes?: readonly FigureQuote[];
}

interface Figure {
  readonly raw: string;
  readonly value: number;
  readonly scale: number;
  readonly currency: string;
  readonly unit: string;
}

const RAW_TEXT_ADAPTER_PATTERN = /^(?:exa|firecrawl)-/u;
const DETERMINISTIC_KINDS: ReadonlySet<Source["kind"]> = new Set([
  "market-data",
  "market-context",
  "extended-evidence",
]);
const MIN_QUOTE_CONTEXT_WORDS = 3;
const GAP_PREFIX = "Verified Web Figure check withheld";

const FIGURE_PATTERN =
  /(?<![\p{L}\d.,'’]|[\p{L}\d][-/])(?<prefix>US\$|S\$|HK\$|A\$|C\$|NT\$|USD|SGD|HKD|AUD|CAD|TWD|MYR|RMB|CNY|EUR|GBP|JPY|INR|IDR|THB|KRW|RM|Rs\.?|Rp|\p{Sc})?\s?(?<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(?<scaleWord>trillion|billion|million|thousand|tn|bn|mn|mln|mil|bil)|(?<scaleLetter>[kmb]))?(?:\s?(?<unit>%|per\s?cent|pct|percentage points?|pp|bps|basis points)|(?<multiple>x|×))?(?:\s(?<suffix>ringgit|dollars?|euros?|yen|yuan|baht|won|sen|cents?|USD|MYR|SGD|HKD|EUR|GBP|JPY|CNY|RMB))?(?![\p{L}\d]|[-.,]\p{L}|[.,]\d)/giu;
const CALENDAR_TOKEN_PATTERN =
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b(?:,?\s+\d{4})?|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b\.?(?:,?\s+\d{4})?|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]m)?\b/gu;

const CURRENCIES: Readonly<Record<string, string>> = {
  us$: "USD",
  usd: "USD",
  $: "USD",
  dollar: "USD",
  dollars: "USD",
  s$: "SGD",
  sgd: "SGD",
  hk$: "HKD",
  hkd: "HKD",
  a$: "AUD",
  aud: "AUD",
  c$: "CAD",
  cad: "CAD",
  nt$: "TWD",
  twd: "TWD",
  rm: "MYR",
  myr: "MYR",
  ringgit: "MYR",
  rmb: "CNY",
  cny: "CNY",
  yuan: "CNY",
  "€": "EUR",
  eur: "EUR",
  euro: "EUR",
  euros: "EUR",
  "£": "GBP",
  gbp: "GBP",
  jpy: "JPY",
  yen: "JPY",
  "₹": "INR",
  inr: "INR",
  rs: "INR",
  "rs.": "INR",
  rp: "IDR",
  idr: "IDR",
  "฿": "THB",
  thb: "THB",
  baht: "THB",
  "₩": "KRW",
  krw: "KRW",
  won: "KRW",
  sen: "MYR-sen",
  cent: "cent",
  cents: "cent",
};

const SCALES: Readonly<Record<string, number>> = {
  thousand: 1e3,
  k: 1e3,
  million: 1e6,
  m: 1e6,
  mn: 1e6,
  mln: 1e6,
  mil: 1e6,
  billion: 1e9,
  b: 1e9,
  bn: 1e9,
  bil: 1e9,
  trillion: 1e12,
  tn: 1e12,
};

const REASON_TEXT: Readonly<Record<WebFigureFailureReason, string>> = {
  "figure-not-quoted": "has no verbatim quote from its cited web source",
  "figure-not-in-quote": "does not appear in any verified quote",
  "scale-mismatch": "is quoted at a different scale",
  "currency-mismatch": "is quoted in a different currency",
  "unit-mismatch": "is quoted with a different unit",
  "quote-not-in-source": "rests on a quote not found in the stored source text",
  "quote-source-not-cited": "rests on a quote from a source the claim does not cite",
  "no-stored-text": "rests on a source with no stored text to check",
  "quote-too-short": "rests on a quote with too little text around the figure",
};

function unitOf(groups: Readonly<Record<string, string | undefined>>): string {
  if (groups.multiple !== undefined) {
    return "x";
  }
  const unit = groups.unit?.toLowerCase().replaceAll(/\s+/gu, " ");
  if (unit === undefined) {
    return "";
  }
  if (unit === "%" || unit === "pct" || unit.startsWith("per")) {
    return "%";
  }
  return unit === "pp" || unit.startsWith("percentage") ? "pp" : "bps";
}

export function figuresIn(text: string): readonly Figure[] {
  return [
    ...text.normalize("NFKC").replaceAll(CALENDAR_TOKEN_PATTERN, " ").matchAll(FIGURE_PATTERN),
  ].flatMap((match) => {
    const groups = match.groups ?? {};
    const num = groups.num ?? "";
    const scaleKey = (groups.scaleWord ?? groups.scaleLetter)?.toLowerCase();
    const currencyKey = (groups.prefix ?? groups.suffix)?.toLowerCase();
    const figure: Figure = {
      raw: match[0].trim(),
      value: Number(num.replaceAll(",", "")),
      scale: scaleKey === undefined ? 1 : (SCALES[scaleKey] ?? 1),
      currency: currencyKey === undefined ? "" : (CURRENCIES[currencyKey] ?? currencyKey),
      unit: unitOf(groups),
    };
    // Counts, ranks, years and model numbers ("iPhone 17", "top 10") are not figures.
    const bareInteger =
      figure.scale === 1 && figure.currency === "" && figure.unit === "" && !/[.,]/u.test(num);
    return bareInteger ? [] : [figure];
  });
}

function normalizedQuoteText(text: string): string {
  return text
    .normalize("NFKC")
    .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replaceAll(/[‘’‚‛′`]/gu, "'")
    .replaceAll(/[“”„‟″]/gu, '"')
    .replaceAll(/[‐‑‒–—―−]/gu, "-")
    .replaceAll(/[*_#]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

export function rawTextsByUrl(rawSnapshots: readonly unknown[]): ReadonlyMap<string, string[]> {
  const texts = new Map<string, string[]>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child));
      return;
    }
    if (!isRecord(node)) {
      return;
    }
    const metadata = isRecord(node.metadata) ? node.metadata : {};
    const url = [node.url, metadata.sourceURL, metadata.url].find(
      (value): value is string => typeof value === "string",
    );
    const text = [node.text, node.markdown].find(
      (value): value is string => typeof value === "string",
    );
    const key = canonicalizeUrl(url);
    if (key !== undefined && text !== undefined) {
      texts.set(key, [...(texts.get(key) ?? []), text]);
    }
    Object.values(node).forEach((child) => visit(child));
  };
  for (const snapshot of rawSnapshots) {
    if (
      isRecord(snapshot) &&
      typeof snapshot.adapter === "string" &&
      RAW_TEXT_ADAPTER_PATTERN.test(snapshot.adapter)
    ) {
      visit(snapshot.payload);
    }
  }
  return texts;
}

// Provider summaries are model-written abstracts, not source text, so only the snippet and page text count.
export function webSourceTexts(
  sources: readonly Source[],
  rawSnapshots: readonly unknown[] = [],
): WebSourceTexts {
  const raw = rawTextsByUrl(rawSnapshots);
  const texts = new Map<string, string[]>();
  const deterministic = new Set(
    sources.filter((row) => DETERMINISTIC_KINDS.has(row.kind)).map((row) => row.id),
  );
  for (const source of sources.filter((row) => row.kind === "web")) {
    const url = canonicalizeUrl(source.url);
    const stored = [source.snippet, ...(url === undefined ? [] : (raw.get(url) ?? []))]
      .filter((text): text is string => text !== undefined)
      .map((text) => normalizedQuoteText(text))
      .filter((text) => text !== "");
    texts.set(source.id, [...new Set([...(texts.get(source.id) ?? []), ...stored])]);
  }
  return { web: texts, deterministic };
}

export function readFigureQuotes(value: unknown): readonly FigureQuote[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((item) =>
    isRecord(item) &&
    typeof item.sourceId === "string" &&
    typeof item.quote === "string" &&
    item.quote.trim() !== ""
      ? [{ sourceId: item.sourceId, quote: item.quote }]
      : [],
  );
}

function sameFigure(left: Figure, right: Figure): boolean {
  return (
    left.value === right.value &&
    left.scale === right.scale &&
    left.currency === right.currency &&
    left.unit === right.unit
  );
}

function quoteFailure(
  quote: FigureQuote,
  sourceIds: readonly string[],
  texts: WebSourceTexts,
): WebFigureFailureReason | undefined {
  if (!sourceIds.includes(quote.sourceId)) {
    return "quote-source-not-cited";
  }
  const stored = texts.web.get(quote.sourceId) ?? [];
  if (stored.length === 0) {
    return "no-stored-text";
  }
  const needle = normalizedQuoteText(quote.quote);
  const contextWords = needle.replaceAll(FIGURE_PATTERN, " ").match(/\p{L}{2,}/gu) ?? [];
  if (contextWords.length < MIN_QUOTE_CONTEXT_WORDS) {
    return "quote-too-short";
  }
  return stored.some((text) => text.includes(needle)) ? undefined : "quote-not-in-source";
}

function mismatchReason(figure: Figure, near: Figure): WebFigureFailureReason {
  if (near.scale !== figure.scale) {
    return "scale-mismatch";
  }
  return near.currency === figure.currency ? "unit-mismatch" : "currency-mismatch";
}

// Every persisted quote must verify. Uncovered figures pass only when a deterministic source is also cited.
export function unverifiedWebFigure(
  claim: WebFigureClaim,
  texts: WebSourceTexts,
): WebFigureFailure | undefined {
  const citedWeb = claim.sourceIds.filter((id) => texts.web.has(id));
  const figures = citedWeb.length === 0 ? [] : figuresIn(claim.text);
  const quotes = (claim.figureQuotes ?? []).map((quote) => ({
    sourceId: quote.sourceId,
    failure: quoteFailure(quote, claim.sourceIds, texts),
    figures: figuresIn(quote.quote),
  }));
  const failed = quotes.find((quote) => quote.failure !== undefined);
  if (failed?.failure !== undefined) {
    const figure = failed.figures[0]?.raw ?? figures[0]?.raw ?? "a quoted figure";
    return { reason: failed.failure, figure, sourceIds: [failed.sourceId] };
  }
  const quotedFigures = quotes.flatMap((quote) => quote.figures);
  const deterministicSupport = claim.sourceIds.some((id) => texts.deterministic.has(id));
  for (const figure of figures) {
    if (deterministicSupport || quotedFigures.some((quoted) => sameFigure(quoted, figure))) {
      continue;
    }
    const near = quotedFigures.find((quoted) => quoted.value === figure.value);
    let reason: WebFigureFailureReason = "figure-not-quoted";
    if (near !== undefined) {
      reason = mismatchReason(figure, near);
    } else if (quotes.length > 0) {
      reason = "figure-not-in-quote";
    } else if (citedWeb.every((id) => texts.web.get(id)?.length === 0)) {
      reason = "no-stored-text";
    }
    return { reason, figure: figure.raw, sourceIds: citedWeb };
  }
  return undefined;
}

export function isWebFigureGapText(text: string): boolean {
  return text.startsWith(GAP_PREFIX);
}

export function webFigureGapText(location: string, failure: WebFigureFailure): string {
  return `${GAP_PREFIX} ${location}: ${failure.figure} ${REASON_TEXT[failure.reason]} (${failure.sourceIds.join(", ")}).`;
}
