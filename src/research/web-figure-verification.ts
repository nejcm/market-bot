import type { FigureQuote, WebFigureFailure, WebFigureFailureReason } from "../domain/report";
import type { Source } from "../domain/sources";
import { isRecord } from "../guards";
import type { MetricSection } from "../sources/extended-evidence/metric-engine";
import { formatMetricValue } from "../sources/extended-evidence/value-format";
import { canonicalizeUrl } from "../sources/news-utils";

export interface WebSourceTexts {
  // Normalized stored text per web Source id; an empty list means the source kept nothing to check.
  readonly web: ReadonlyMap<string, readonly string[]>;
  readonly deterministic: ReadonlySet<string>;
  // Figures code rendered from a web-sourced Metric Section, which a metric reference substitutes into a claim.
  readonly codeFigures: ReadonlyMap<string, readonly Figure[]>;
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

const CURRENCY_PREFIX = String.raw`US\$|S\$|HK\$|A\$|C\$|NT\$|USD|SGD|HKD|AUD|CAD|TWD|MYR|RMB|CNY|EUR|GBP|JPY|INR|IDR|THB|KRW|RM|Rs\.?|Rp|\p{Sc}`;
// A dash before a digit or currency prefix joins a range ("RM5m-RM6m").
const RANGE_TAIL = String.raw`-(?:(?:${CURRENCY_PREFIX})\s?)?\d`;
const SCALE_WORDS = "trillion|billion|million|thousand|tn|bn|mn|mln|mil|bil";
const UNIT_WORDS = String.raw`per\s?cent|pct|percentage points?|pp|bps|bp|basis points`;
// Words a bare count may be glued to and still be no figure ("52-week", "10-K"); any other word may be a unit.
const COUNT_WORD_AFTER =
  /^-(?:[AC-JLN-Z]|(?:[Dd]ay|[Ww]eek|[Mm]onth|[Qq]uarter|[Yy]ear|[Yy]r|[Hh]our)s?|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?!\p{L})/u;
// K, M and B may be scales, so only the SEC form codes keep them.
const SEC_K_FORM = /^(?:6|8|10|11)-K(?!\p{L})/u;
const FIGURE_PATTERN = new RegExp(
  String.raw`(?<![\p{L}\d.,'’%×]|[\p{L}\d]/)(?<sign>[-−](?=\S))?(?<prefix>${CURRENCY_PREFIX})?\s?(?<innerSign>[-−])?(?<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s?(?<scaleWord>${SCALE_WORDS})|(?<scaleLetter>[kmb]))?(?:\s?(?<unit>%|${UNIT_WORDS})|(?<multiple>x|×))?(?:\s(?<suffix>ringgit|dollars?|euros?|yen|yuan|baht|won|sen|cents?|USD|MYR|SGD|HKD|EUR|GBP|JPY|CNY|RMB)(?!-\p{L}))?(?![\p{L}\d]|[.,]\p{L}|[.,]\d)`,
  "giu",
);
const RANGE_TAIL_START = new RegExp(`^${RANGE_TAIL}`, "iu");
const CURRENCY_BEFORE = new RegExp(`(?:${CURRENCY_PREFIX})\\s*$`, "u");
const SEC_ACCESSION_PATTERN = /[\p{L}\d-]*\d{10}-\d{2}-\d{6}/gu;
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
  "figure-ambiguous": "has a sign or range structure that cannot be read reliably",
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
  if (unit === "pp" || unit.startsWith("percentage")) {
    return "pp";
  }
  return unit === "%" || unit === "pct" || unit.startsWith("per") ? "%" : "bps";
}

interface PlacedFigure {
  readonly figure: Figure;
  readonly numStart: number;
  readonly numEnd: number;
}

const DASHES = /[‐‑‒–—―−]/gu;
const SEPARATED_SIGN = /(?<!-)-\s+$/u;
const OPEN_PAREN = /\(\s*$/u;
const CLOSE_PAREN = /^\s*\)/u;

interface ParsedRow {
  readonly figure: Figure;
  readonly num: string;
  readonly scaled: boolean;
  readonly rawStart: number;
  readonly rawEnd: number;
  readonly numStart: number;
}

function differ(left: string, right: string): boolean {
  return left !== "" && right !== "" && left !== right;
}

function mixedRange(low: Figure, high: Figure): boolean {
  return (
    differ(low.currency, high.currency) ||
    differ(low.unit, high.unit) ||
    (low.currency !== "" && high.unit !== "") ||
    (low.unit !== "" && high.currency !== "")
  );
}

// Counts, ranks, years and model numbers ("iPhone 17", "top 10") are not figures.
function isBare(row: ParsedRow, figure: Figure): boolean {
  return (
    figure.scale === 1 && figure.currency === "" && figure.unit === "" && !/[.,]/u.test(row.num)
  );
}

function placedRow(row: ParsedRow, figure: Figure): PlacedFigure {
  return { figure, numStart: row.numStart, numEnd: row.numStart + row.num.length };
}

function parenthesizedRange(low: ParsedRow, high: ParsedRow, blanked: string): boolean {
  return (
    OPEN_PAREN.test(blanked.slice(Math.max(0, low.rawStart - 8), low.rawStart)) &&
    CLOSE_PAREN.test(blanked.slice(high.rawEnd, high.rawEnd + 8))
  );
}

// The low endpoint takes the scale, unit and currency written once on the high ("$1.2-1.4 billion").
// A pair is unverifiable when sharing cannot reconcile it or its dash may be a sign (parenthesized, descending, signed).
function tightRange(low: ParsedRow, high: ParsedRow, blanked: string): readonly [Figure, Figure] {
  const raw = blanked.slice(low.rawStart, high.rawEnd);
  const bottom: Figure = {
    ...low.figure,
    raw,
    scale: low.scaled ? low.figure.scale : high.figure.scale,
    unit: low.figure.unit || high.figure.unit,
    currency: low.figure.currency || high.figure.currency,
  };
  const top: Figure = {
    ...high.figure,
    raw,
    currency: high.figure.currency || low.figure.currency,
  };
  const unverifiable =
    parenthesizedRange(low, high, blanked) ||
    mixedRange(low.figure, high.figure) ||
    CURRENCY_BEFORE.test(blanked.slice(Math.max(0, low.rawStart - 8), low.rawStart)) ||
    (low.scaled && !high.scaled) ||
    (low.figure.unit !== "" && high.figure.unit === "") ||
    Number.isNaN(low.figure.value) ||
    Number.isNaN(high.figure.value) ||
    (bottom.value < 0 && top.value > 0) ||
    bottom.value * bottom.scale > top.value * top.scale;
  return [
    { ...bottom, value: unverifiable ? Number.NaN : bottom.value },
    { ...top, value: unverifiable ? Number.NaN : top.value },
  ];
}

// A spaced gap joins a range only through a dash, alone or as a bare next number's sign ("7% -15").
function rangeGap(
  blanked: string,
  row: ParsedRow | undefined,
  next: ParsedRow | undefined,
): "tight" | "spaced" | undefined {
  if (row === undefined || next === undefined) {
    return undefined;
  }
  const gap = blanked.slice(row.rawEnd, next.rawStart);
  if (gap === "-") {
    return "tight";
  }
  const signedNext =
    /^\s+$/u.test(gap) && blanked[next.rawStart] === "-" && isBare(next, next.figure);
  return /^\s*-\s*$/u.test(gap) || signedNext ? "spaced" : undefined;
}

// A spaced range never shares, so endpoints written with different scale, unit or currency cannot verify.
function spacedRange(low: ParsedRow, high: ParsedRow, blanked: string): readonly [Figure, Figure] {
  const unshared =
    parenthesizedRange(low, high, blanked) ||
    low.scaled !== high.scaled ||
    (low.figure.unit === "") !== (high.figure.unit === "") ||
    (low.figure.currency === "") !== (high.figure.currency === "");
  const value = (figure: Figure) => (unshared ? Number.NaN : figure.value);
  return [
    { ...low.figure, value: value(low.figure) },
    { ...high.figure, value: value(high.figure) },
  ];
}

// A range keeps both endpoints when either is a figure, and a bare one it keeps cannot verify.
function rangeFigures(
  low: ParsedRow,
  high: ParsedRow,
  [bottom, top]: readonly [Figure, Figure],
): PlacedFigure[] {
  if (isBare(low, bottom) && isBare(high, top)) {
    return [];
  }
  const kept = (row: ParsedRow, figure: Figure) =>
    placedRow(row, isBare(row, figure) ? { ...figure, value: Number.NaN } : figure);
  return [kept(low, bottom), kept(high, top)];
}

// Accounting parentheses are negative only around a whole table cell; elsewhere a paren or spaced dash is ambiguous.
function placedFiguresIn(text: string, cell = false): readonly PlacedFigure[] {
  const blanked = text
    .normalize("NFKC")
    .replaceAll(DASHES, "-")
    .replaceAll(CALENDAR_TOKEN_PATTERN, (token) => " ".repeat(token.length))
    .replaceAll(SEC_ACCESSION_PATTERN, (token) => " ".repeat(token.length));
  const rows = [...blanked.matchAll(FIGURE_PATTERN)].map((match) => {
    const groups = match.groups ?? {};
    const num = groups.num ?? "";
    const scaleKey = (groups.scaleWord ?? groups.scaleLetter)?.toLowerCase();
    const currencyKey = (groups.prefix ?? groups.suffix)?.toLowerCase();
    const raw = match[0].trim();
    const rawStart = match.index + match[0].indexOf(raw);
    const before = blanked.slice(Math.max(0, rawStart - 8), rawStart);
    const after = blanked.slice(rawStart + raw.length, rawStart + raw.length + 8);
    const parenthesized = OPEN_PAREN.test(before) && CLOSE_PAREN.test(after);
    const accounting =
      parenthesized &&
      cell &&
      blanked.slice(0, rawStart).trim() === "(" &&
      blanked.slice(rawStart + raw.length).trim() === ")";
    const explicitSign = (groups.sign ?? groups.innerSign) !== undefined;
    const ambiguousSign =
      (parenthesized && !accounting && !explicitSign) ||
      (groups.sign === undefined && SEPARATED_SIGN.test(before));
    const negative = explicitSign || accounting;
    const magnitude = Number(num.replaceAll(",", ""));
    const signed = negative ? -magnitude : magnitude;
    const figure: Figure = {
      raw,
      // NaN never equals a figure, so an ambiguous sign cannot verify either reading.
      value: ambiguousSign ? Number.NaN : signed,
      scale: scaleKey === undefined ? 1 : (SCALES[scaleKey] ?? 1),
      currency: currencyKey === undefined ? "" : (CURRENCIES[currencyKey] ?? currencyKey),
      unit: unitOf(groups),
    };
    const numStart = match.index + match[0].indexOf(num);
    return {
      figure,
      num,
      scaled: scaleKey !== undefined,
      rawStart,
      rawEnd: rawStart + raw.length,
      numStart,
    };
  });
  const gluedBefore = (row: ParsedRow) =>
    /[\p{L}\d]-$/u.test(blanked.slice(Math.max(0, row.rawStart - 2), row.rawStart));
  const gluedAfter = (row: ParsedRow) =>
    /^-\p{L}/u.test(blanked.slice(row.rawEnd)) && !RANGE_TAIL_START.test(blanked.slice(row.rawEnd));
  const countWordAfter = (row: ParsedRow) =>
    COUNT_WORD_AFTER.test(blanked.slice(row.rawEnd)) ||
    SEC_K_FORM.test(blanked.slice(row.rawStart));
  const placed: PlacedFigure[] = [];
  for (let index = 0; index < rows.length; ) {
    let end = index + 1;
    const compound = (link: ParsedRow | undefined) =>
      link !== undefined && isBare(link, link.figure) && countWordAfter(link);
    // A count glued to a word ("52-week") ends a range rather than extending it.
    while (rangeGap(blanked, rows[end - 1], rows[end]) !== undefined && !compound(rows[end])) {
      end += 1;
    }
    const chain = rows.slice(index, end);
    index = end;
    const [row, next] = chain;
    if (row === undefined) {
      break;
    }
    const last = chain.at(-1) ?? row;
    // A word-glued dash may be a sign before a figure ("profit-5m") or hide a scale after one ("$5-million").
    const glued = gluedBefore(row) || (gluedAfter(last) && !last.scaled && last.figure.unit === "");
    // A dash chain ("1-2-3%") is not a range, so none of it verifies.
    if (glued || chain.length > 2) {
      const unitAfter = gluedAfter(last) && !countWordAfter(last);
      if (unitAfter || !chain.every((link) => isBare(link, link.figure))) {
        placed.push(...chain.map((link) => placedRow(link, { ...link.figure, value: Number.NaN })));
      }
    } else if (next !== undefined) {
      const pair: readonly [Figure, Figure] =
        rangeGap(blanked, row, next) === "tight"
          ? tightRange(row, next, blanked)
          : spacedRange(row, next, blanked);
      placed.push(...rangeFigures(row, next, pair));
    } else if (RANGE_TAIL_START.test(blanked.slice(row.rawEnd))) {
      placed.push(placedRow(row, { ...row.figure, value: Number.NaN }));
    } else if (!isBare(row, row.figure)) {
      placed.push(placedRow(row, row.figure));
    }
  }
  return placed;
}

export function figuresIn(text: string): readonly Figure[] {
  return placedFiguresIn(text).map(({ figure }) => figure);
}

// Table cell edges survive normalization so a quoted figure is read whole from its own cell.
const CELL_EDGE = "\u0000";
// Edge after a row with no closing "|": the next line may wrap the cell or start a row, so its figures are withheld.
const AMBIGUOUS_EDGE = "\u0001";
// Outer edge of a row, so a pipe-free line between two rows is never read as a cell.
const ROW_EDGE = "\u0002";
const EDGE_CHARS = `${CELL_EDGE}${AMBIGUOUS_EDGE}${ROW_EDGE}`;
const EDGES = new RegExp(`[${EDGE_CHARS}]`, "gu");

function withCellEdges(lines: readonly string[]): string {
  let open = false;
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed === "") {
        const closing = open ? AMBIGUOUS_EDGE : "";
        open = false;
        return closing;
      }
      if (!open && !trimmed.includes("|")) {
        return line;
      }
      const opening = open ? AMBIGUOUS_EDGE : ROW_EDGE;
      open = trimmed.startsWith("|") && !trimmed.endsWith("|");
      return `${opening} ${line.replaceAll("|", ` ${CELL_EDGE} `)} ${open ? "" : ROW_EDGE}`;
    })
    .join("\n");
}

function normalizedSourceText(text: string): string {
  return withCellEdges(
    text
      .normalize("NFKC")
      .replaceAll(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
      .replaceAll(/[‘’‚‛′`]/gu, "'")
      .replaceAll(/[“”„‟″]/gu, '"')
      .replaceAll(/[‐‑‒–—―−]/gu, "-")
      .replaceAll(/[*_#]/gu, "")
      .split(/\r?\n/u),
  )
    .replaceAll(/\s+/gu, " ")
    .trim();
}

function normalizedQuoteText(text: string): string {
  return normalizedSourceText(text).replaceAll(EDGES, " ").replaceAll(/\s+/gu, " ").trim();
}

function placedSourceFigures(text: string): readonly PlacedFigure[] {
  const placed: PlacedFigure[] = [];
  let offset = 0;
  let ambiguousBefore = false;
  for (const cell of text.split(EDGES)) {
    const end = offset + cell.length;
    const ambiguousAfter = text[end] === AMBIGUOUS_EDGE;
    if (!ambiguousBefore && !ambiguousAfter) {
      const tableCell =
        offset > 0 &&
        text[end] !== undefined &&
        (text[offset - 1] === CELL_EDGE || text[end] === CELL_EDGE);
      for (const figure of placedFiguresIn(cell, tableCell)) {
        placed.push({
          figure: figure.figure,
          numStart: offset + figure.numStart,
          numEnd: offset + figure.numEnd,
        });
      }
    }
    ambiguousBefore = ambiguousAfter;
    offset = end + 1;
  }
  return placed;
}

function figuresTouching(placed: readonly PlacedFigure[], start: number, end: number): Figure[] {
  let low = 0;
  let high = placed.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((placed[middle]?.numEnd ?? 0) > start) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  const figures: Figure[] = [];
  for (let index = low; index < placed.length; index += 1) {
    const row = placed[index];
    if (row === undefined || row.numStart >= end) {
      break;
    }
    figures.push(row.figure);
  }
  return figures;
}

// Every match, overlapping ones included, yields the source figures whose number it touches.
function quotedSourceFigures(needle: string, stored: readonly string[]): readonly Figure[][] {
  const pattern = new RegExp(
    needle
      .split(" ")
      .map((word) => word.replaceAll(/[\\^$.*+?()[\]{}|/]/gu, String.raw`\$&`))
      .join(`[\\s${EDGE_CHARS}]+`),
    "giu",
  );
  return stored.flatMap((text) => {
    const placed = placedSourceFigures(text);
    const spans: Figure[][] = [];
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      spans.push(figuresTouching(placed, match.index, match.index + match[0].length));
      pattern.lastIndex = match.index + 1;
    }
    return spans;
  });
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
  metricSections: readonly MetricSection[] = [],
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
      .map((text) => normalizedSourceText(text))
      .filter((text) => text !== "");
    texts.set(source.id, [...new Set([...(texts.get(source.id) ?? []), ...stored])]);
  }
  const codeFigures = new Map<string, Figure[]>();
  for (const metric of metricSections.flatMap((section) => section.metrics)) {
    const rendered =
      metric.status === "value"
        ? formatMetricValue(metric.value, metric.unit, metric.currency)
        : undefined;
    for (const id of rendered === undefined
      ? []
      : metric.sourceIds.filter((row) => texts.has(row))) {
      codeFigures.set(id, [...(codeFigures.get(id) ?? []), ...figuresIn(rendered ?? "")]);
    }
  }
  return { web: texts, deterministic, codeFigures };
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

interface QuoteCheck {
  readonly failure?: WebFigureFailureReason;
  readonly figures: readonly Figure[];
}

function checkedQuote(
  quote: FigureQuote,
  sourceIds: readonly string[],
  texts: WebSourceTexts,
  claimFigures: readonly Figure[],
): QuoteCheck {
  const failed = (failure: WebFigureFailureReason): QuoteCheck => ({
    failure,
    figures: figuresIn(quote.quote),
  });
  if (!sourceIds.includes(quote.sourceId)) {
    return failed("quote-source-not-cited");
  }
  const stored = texts.web.get(quote.sourceId) ?? [];
  if (stored.length === 0) {
    return failed("no-stored-text");
  }
  const needle = normalizedQuoteText(quote.quote);
  const contextWords = needle.replaceAll(FIGURE_PATTERN, " ").match(/\p{L}{2,}/gu) ?? [];
  if (contextWords.length < MIN_QUOTE_CONTEXT_WORDS) {
    return failed("quote-too-short");
  }
  const spans = quotedSourceFigures(needle, stored);
  const covered = (figures: readonly Figure[]) =>
    claimFigures.filter((claimed) => figures.some((quoted) => sameFigure(quoted, claimed))).length;
  const [best] = spans.toSorted((left, right) => covered(right) - covered(left));
  return best === undefined ? failed("quote-not-in-source") : { figures: best };
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
    ...checkedQuote(quote, claim.sourceIds, texts, figures),
  }));
  const failed = quotes.find((quote) => quote.failure !== undefined);
  if (failed?.failure !== undefined) {
    const figure = failed.figures[0]?.raw ?? figures[0]?.raw ?? "a quoted figure";
    return { reason: failed.failure, figure, sourceIds: [failed.sourceId] };
  }
  const quotedFigures = quotes.flatMap((quote) => quote.figures);
  const deterministicSupport = claim.sourceIds.some((id) => texts.deterministic.has(id));
  for (const figure of figures) {
    const codeRendered = citedWeb.some((id) =>
      texts.codeFigures.get(id)?.some((rendered) => sameFigure(rendered, figure)),
    );
    if (
      deterministicSupport ||
      codeRendered ||
      quotedFigures.some((quoted) => sameFigure(quoted, figure))
    ) {
      continue;
    }
    const near = quotedFigures.find((quoted) => quoted.value === figure.value);
    let reason: WebFigureFailureReason = "figure-not-quoted";
    if (Number.isNaN(figure.value)) {
      reason = "figure-ambiguous";
    } else if (near !== undefined) {
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
