import {
  exchangeProfileFor,
  issuerReportHostKind,
  type ExchangeProfile,
  type IssuerReportHostKind,
} from "../domain/exchange-profile";
import type { ResearchCommand } from "../cli/args";
import type { AppConfig } from "../config";
import type { ResolvedRunParams } from "../config/runs";
import { sourceGap } from "../domain/source-gaps";
import type { Source, SourceGap } from "../domain/sources";
import { isRecord } from "../guards";
import type { ModelProvider } from "../model/types";
import { withUntrustedModelInputRule } from "../model/trust-guard";
import type {
  MetricInput,
  MetricResult,
  MetricSection,
} from "../sources/extended-evidence/metric-engine";
import {
  notMeaningfulYoyReason,
  revenueShareCheck,
} from "../sources/extended-evidence/financial-lens-inputs";
import { deltaPercent } from "../sources/extended-evidence/sec-fundamentals-format";
import { canonicalizeUrl } from "../sources/news-utils";
import type { CollectedSources, RawSourceSnapshot } from "../sources/types";
import type { StageOutput } from "./final-synthesis";
import { withIssuerReportFramework } from "./issuer-report-framework";
import { loadStagePrompt } from "./prompt-loader";
import { withholdProviderEps } from "./provider-eps-withholding";
import {
  SCALE_CELL,
  SUBUNIT_LABEL,
  UNIT_CELL,
  cellNumber,
  columnHeaders,
  columnUnit,
  declaredLabel,
  rowLabel,
  valueColumns,
} from "./unit-header";
import { rawTextsByUrl } from "./web-figure-verification";

type ConceptKind = "flow" | "stock" | "per-share";

const CONCEPTS = {
  revenue: { label: "Revenue", kind: "flow", row: /^(?!.*\bcost\b).*\b(?:revenue|turnover)\b/iu },
  "profit-before-tax": {
    label: "Profit before tax",
    kind: "flow",
    row: /^(?!.*\b(?:share of|associates?|joint ventures?|attributable)\b).*\b(?:profit|loss)\b.*\bbefore tax/iu,
  },
  "profit-for-period": {
    label: "Profit for the period",
    kind: "flow",
    row: /^(?!.*(?:attributable|before tax|\bgross\b|\boperating\b|\bmargin\b|comprehensive)).*\bprofit\b.*\bfor the (?:financial )?(?:period|year)\b/iu,
  },
  "profit-attributable-to-owners": {
    label: "Profit attributable to owners of the parent",
    kind: "flow",
    row: /^(?!.*comprehensive).*\bprofit\b.*\battributable to\b.*\b(?:owners|ordinary equity holders|equity holders|shareholders)\b/iu,
  },
  "basic-eps": {
    label: "Basic EPS",
    kind: "per-share",
    row: /^(?=.*\bbasic\b)(?=.*(?:per share|\beps\b))/iu,
  },
  "dividend-per-share": { label: "Dividend per share", kind: "per-share", row: /\bdividends?\b/iu },
  "operating-cash-flow": {
    label: "Net cash from operating activities",
    kind: "flow",
    row: /\bnet cash\b.*\boperating activities\b/iu,
  },
  "capital-expenditure": {
    label: "Purchase of property, plant and equipment",
    kind: "flow",
    row: /\b(?:purchases?|acquisitions?|additions?) (?:of|to) property,? plant and equipment\b/iu,
  },
  "cash-and-equivalents": {
    label: "Cash and cash equivalents",
    kind: "stock",
    row: /\bcash and (?:cash equivalents|bank balances?)\b/iu,
  },
  "current-assets": {
    label: "Total current assets",
    kind: "stock",
    row: /\btotal current assets\b/iu,
  },
  "current-liabilities": {
    label: "Total current liabilities",
    kind: "stock",
    row: /\btotal current liabilities\b/iu,
  },
  "total-equity": {
    label: "Total equity",
    kind: "stock",
    row: /^(?!.*attributable)total equity\b(?! and)/iu,
  },
} as const satisfies Record<
  string,
  { readonly label: string; readonly kind: ConceptKind; readonly row: RegExp }
>;

type IssuerReportConcept = keyof typeof CONCEPTS;
type PeriodBasis = "quarter" | "ytd" | "annual" | "instant";
type FigureScope = "total" | "continuing";
type StatedScope = FigureScope | "discontinued" | "unproven";

const ISSUER_REPORT_CONCEPTS = Object.keys(CONCEPTS) as readonly IssuerReportConcept[];
const ISSUER_REPORT_SECTION_ID = "issuer-report";

const MAX_DOCUMENTS = 4;
const GAP_SOURCE = "issuer-report";
const PROVIDER_EPS_WITHHELD =
  "Yahoo trailing EPS is below an issuer-reported basic EPS for a period its trailing twelve months would contain, so it is withheld; see the issuer-report Source Gap";
const DATE_PATTERN = /\b(\d{1,2})[\s\-/.]+([A-Za-z]{3,9}|\d{1,2})[\s\-/.,]+(\d{4}|\d{2})\b/gu;
const CELL_REF = /^t(\d+):r(\d+):c(\d+)$/u;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RESTATED_HEADER = /\brestated\b|\bre-?presented\b/iu;
const RESTATED_NOTE = "; column headed as a restated or re-presented comparative";
const MONTH_BASES: Readonly<Record<number, PeriodBasis>> = { 3: "quarter", 12: "annual" };
const PERIOD_TYPES = {
  quarter: "interim",
  ytd: "interim",
  annual: "annual",
  instant: "instant",
} as const satisfies Record<PeriodBasis, MetricInput["periodType"]>;
const MONTHS_WORDS: Readonly<Record<string, number>> = { three: 3, six: 6, nine: 9, twelve: 12 };
const SCOPE_CUE =
  /continu|held[\s-]+for[\s-]+(?:sale|distribution)|\b(?:nca)?hfs\b|disposal\s+group|\b(?:cont|disc)\.?\s*ops?\b|berterusan|diteruskan|dihentikan/iu;
const PROSE_SCOPE_CUE =
  /continu\w*\s+(?:operations?|activities|business(?:es)?|segments?)|held[\s-]+for[\s-]+(?:sale|distribution)|\b(?:nca)?hfs\b|disposal\s+group|\b(?:cont|disc)\.\s*ops?\b|operasi\s+(?:yang\s+)?(?:berterusan|tidak\s+diteruskan|dihentikan)/iu;
const INCLUSIVE_SCOPE =
  /\bcontinuing\s+and\s+discontinued\s+operations?\b|\bincluding\s+discontinued\s+operations?\b/iu;
const CONTINUING_SCOPE = /\bcontinuing\s+operations?\b/iu;
const NEGATION =
  /\b(?:not|no|non|excluding|except|without|exclusive\s+of|other\s+than)\b|\bnon(?=continu)/iu;
const DASHES = /[\u2010-\u2015\u2212]/gu;
const TOTAL_LABEL = /\btotal\b/iu;
const MENTIONS_DISCONTINUED =
  /discontinu|held[\s-]+for[\s-]+(?:sale|distribution)|\b(?:nca)?hfs\b|disposal\s+group|\bdisc\.?\s*ops?\b|tidak\s+diteruskan|dihentikan/iu;
const DISCONTINUED_SCOPE =
  /\bdiscontinued\s+(?:operations?|business(?:es)?|segments?)\b|held[\s-]+for[\s-]+(?:sale|distribution)|\b(?:nca)?hfs\b|disposal\s+group|\bdisc\.?\s*ops?\b|tidak\s+diteruskan|dihentikan/iu;
const SCOPE_ORDER: readonly FigureScope[] = ["total", "continuing"];
const SCOPE_OUTCOMES = {
  total: "total",
  continuing: "continuing",
  discontinued: "discontinued-operations",
  unproven: "unproven-scope",
} as const satisfies Record<StatedScope, FigureScope | IssuerReportFailureReason>;
const MIXED_SCOPE_REASON =
  "inputs are of different Accounting Scope (continuing vs total operations)";
const PARENT_PROFIT_ONLY_REASON =
  "no checked profit for the period; profit attributable to owners of the parent leaves out non-controlling interests, and no checked figure shows the period has none";

type IssuerReportFailureReason =
  | "unknown-concept"
  | "cell-not-found"
  | "cell-not-numeric"
  | "period-not-declared"
  | "period-ambiguous"
  | "period-length-not-declared"
  | "basis-mismatch"
  | "unit-not-declared"
  | "unit-ambiguous"
  | "unit-mismatch"
  | "currency-not-declared"
  | "currency-mismatch"
  | "period-after-announcement"
  | "label-mismatch"
  | "discontinued-operations"
  | "unproven-scope"
  | "cell-reused"
  | "conflicting-figures";

interface IssuerReportCell {
  readonly ref: string;
  readonly text: string;
}

interface IssuerReportTable {
  readonly id: string;
  readonly rows: readonly (readonly string[])[];
}

interface IssuerReportDocument {
  readonly sourceId: string;
  readonly title: string;
  readonly host: string;
  readonly hostKind: IssuerReportHostKind;
  readonly announcedAt: string;
  readonly announcedAtBasis: "announcement" | "source-date";
  readonly fiscalYearEndMonth?: number;
  readonly declaredCurrency?: string;
  readonly proseScopeCue: boolean;
  readonly tables: readonly IssuerReportTable[];
}

export interface IssuerReportPacket {
  readonly documents: readonly IssuerReportDocument[];
}

interface IssuerReportFigure {
  readonly concept: IssuerReportConcept;
  readonly sourceId: string;
  readonly rowLabel: string;
  readonly cellText: string;
  readonly unitText: string;
  readonly value: number;
  readonly currency: string;
  readonly periodEnd: string;
  readonly basis: PeriodBasis;
  readonly periodMonths?: number;
  readonly restated: boolean;
  readonly scope: FigureScope;
  readonly document: IssuerReportDocument;
}

interface IssuerReportFailure {
  readonly cell: string;
  readonly concept: string;
  readonly reason: IssuerReportFailureReason;
}

interface IssuerReportReading {
  readonly figures: readonly IssuerReportFigure[];
  readonly failures: readonly IssuerReportFailure[];
}

function isoDate(day: number, month: number, year: number): string | undefined {
  const fullYear = year < 100 ? 2000 + year : year;
  const date = new Date(Date.UTC(fullYear, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? date.toISOString().slice(0, 10)
    : undefined;
}

export function datesIn(text: string): readonly string[] {
  return [...text.matchAll(DATE_PATTERN)].flatMap((match) => {
    const token = match[2] ?? "";
    const day = Number(match[1]);
    const numeric = /^\d+$/u.test(token);
    // An all-numeric date with both fields ≤ 12 reads either day- or month-first, so it is withheld.
    if (numeric && day <= 12 && day !== Number(token)) {
      return [];
    }
    const month = numeric ? Number(token) : MONTHS.indexOf(token.slice(0, 3).toLowerCase()) + 1;
    const date = isoDate(day, month, Number(match[3]));
    return date === undefined ? [] : [date];
  });
}

export function markdownTables(text: string): readonly (readonly string[])[][] {
  const tables: string[][][] = [];
  let current: string[][] | undefined = undefined;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) {
      current = undefined;
      continue;
    }
    if (/^[|\s:-]+$/u.test(trimmed) && trimmed.includes("-")) {
      continue;
    }
    const cells = trimmed
      .replace(/^\|/u, "")
      .replace(/\|$/u, "")
      .split("|")
      .map((cell) => cell.trim());
    if (current === undefined) {
      current = [];
      tables.push(current);
    }
    current.push(cells);
  }
  return tables.filter((rows) =>
    rows.some((row) => row.some((cell) => cellNumber(cell) !== undefined)),
  );
}

function labelledDate(text: string, label: RegExp): string | undefined {
  const line = text.split(/\r?\n/u).find((row) => label.test(row));
  return line === undefined ? undefined : datesIn(line)[0];
}

function issuerReportDocument(
  source: Source,
  text: string,
  profile: ExchangeProfile,
  tableOffset: number,
): IssuerReportDocument | undefined {
  const hostKind = issuerReportHostKind(profile, source.url);
  const host = URL.parse(source.url ?? "")?.hostname.toLowerCase();
  const tables = markdownTables(text);
  if (hostKind === undefined || host === undefined || tables.length === 0) {
    return undefined;
  }
  const announced = labelledDate(text, /date announced/iu);
  const fiscalYearEnd = labelledDate(text, /financial year end/iu);
  const declaredCurrency = text
    .match(/currency:\s*[^\n(|]*\((?<code>[A-Z]{3})\)/iu)
    ?.groups?.code?.toUpperCase();
  return {
    sourceId: source.id,
    title: source.title,
    host,
    hostKind,
    announcedAt: announced ?? source.fetchedAt.slice(0, 10),
    announcedAtBasis: announced === undefined ? "source-date" : "announcement",
    ...(fiscalYearEnd === undefined
      ? {}
      : { fiscalYearEndMonth: Number(fiscalYearEnd.slice(5, 7)) }),
    ...(declaredCurrency === undefined ? {} : { declaredCurrency }),
    proseScopeCue: text
      .split(/\r?\n/u)
      .some((line) => !line.trim().startsWith("|") && PROSE_SCOPE_CUE.test(scopeText(line))),
    tables: tables.map((rows, index) => ({ id: `t${String(tableOffset + index + 1)}`, rows })),
  };
}

// Reads the stored page text of web sources on the Exchange Profile's report hosts (ADR 0006).
export function issuerReportPacket(
  symbol: string,
  sources: readonly Source[],
  rawSnapshots: readonly RawSourceSnapshot[],
  maxDocuments = MAX_DOCUMENTS,
): IssuerReportPacket {
  const profile = exchangeProfileFor(symbol);
  if (profile === undefined) {
    return { documents: [] };
  }
  const rawTexts = rawTextsByUrl(rawSnapshots);
  const candidates = sources
    .filter((source) => source.kind === "web" && issuerReportHostKind(profile, source.url))
    .toSorted((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))
    .slice(0, maxDocuments);
  const documents: IssuerReportDocument[] = [];
  for (const source of candidates) {
    const stored = rawTexts.get(canonicalizeUrl(source.url) ?? "") ?? [];
    const text = stored.toSorted((left, right) => right.length - left.length)[0] ?? source.snippet;
    const offset = documents.reduce((count, document) => count + document.tables.length, 0);
    const document =
      text === undefined ? undefined : issuerReportDocument(source, text, profile, offset);
    if (document !== undefined) {
      documents.push(document);
    }
  }
  return { documents };
}

export function issuerReportMappingInput(packet: IssuerReportPacket): Record<string, unknown> {
  return {
    allowedConcepts: ISSUER_REPORT_CONCEPTS,
    documents: packet.documents.map((document) => ({
      sourceId: document.sourceId,
      title: document.title,
      tables: document.tables.map((table) => ({
        id: table.id,
        rows: table.rows.map((row, rowIndex) =>
          row.flatMap((text, columnIndex): readonly IssuerReportCell[] =>
            text === ""
              ? []
              : [{ ref: `${table.id}:r${String(rowIndex)}:c${String(columnIndex)}`, text }],
          ),
        ),
      })),
    })),
  };
}

function periodBasis(
  headerText: string,
  fiscalYearEndMonth: number | undefined,
  periodEnd: string,
): { readonly basis: PeriodBasis; readonly months?: number } | undefined {
  const text = headerText.toLowerCase();
  if (/\bas at\b/u.test(text)) {
    return { basis: "instant" };
  }
  const stated = text.match(/\b(\d{1,2}|three|six|nine|twelve)[\s-]+months?\b/u)?.[1];
  const months = stated === undefined ? undefined : (MONTHS_WORDS[stated] ?? Number(stated));
  if (months !== undefined) {
    return { basis: MONTH_BASES[months] ?? "ytd", months };
  }
  if (/to[\s-]date|cumulative/u.test(text)) {
    const ytdMonths =
      fiscalYearEndMonth === undefined
        ? undefined
        : (Number(periodEnd.slice(5, 7)) - fiscalYearEndMonth + 12) % 12 || 12;
    return ytdMonths === undefined ? { basis: "ytd" } : { basis: "ytd", months: ytdMonths };
  }
  if (/quarter/u.test(text)) {
    return { basis: "quarter", months: 3 };
  }
  return /financial year|year ended/u.test(text) ? { basis: "annual", months: 12 } : undefined;
}

function scopeText(text: string): string {
  return text.replace(DASHES, "-");
}

function statedScope(label: string): StatedScope | undefined {
  const text = scopeText(label);
  if (!SCOPE_CUE.test(text)) {
    return undefined;
  }
  if (NEGATION.test(text)) {
    return "unproven";
  }
  if (CONTINUING_SCOPE.test(text)) {
    return MENTIONS_DISCONTINUED.test(text) ? "unproven" : "continuing";
  }
  if (INCLUSIVE_SCOPE.test(text)) {
    return "total";
  }
  return DISCONTINUED_SCOPE.test(text) ? "discontinued" : "unproven";
}

function closesSection(label: string): boolean {
  const stated = statedScope(label);
  return (stated !== undefined && stated !== "continuing") || TOTAL_LABEL.test(label);
}

// The closest caption row (no amounts right of its label) above the row, past unit rows, within its
// Header block; a flow also stops at a total or non-continuing data row, which closes the section.
function captionScope(
  rows: readonly (readonly string[])[],
  rowIndex: number,
  stopAtClosingRow: boolean,
): StatedScope | "unstated" | undefined {
  const columns = valueColumns(rows);
  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    const row = rows[index] ?? [];
    const labelAt = row.findIndex((cell) => cell !== "" && cellNumber(cell) === undefined);
    const amounts = row.filter(
      (cell, cellIndex) =>
        cell !== "" && columns.has(cellIndex) && (columns.has(labelAt) || cellIndex > labelAt),
    );
    const isData = amounts.some((cell) => cellNumber(cell) !== undefined && !SCALE_CELL.test(cell));
    const label = rowLabel(row);
    if (isData) {
      if (stopAtClosingRow && closesSection(label)) {
        return "unproven";
      }
      const stated = statedScope(label);
      if (!stopAtClosingRow && stated !== undefined) {
        return stated === "total" ? "unproven" : stated;
      }
      continue;
    }
    if (amounts.some((cell) => !UNIT_CELL.test(cell) && !SCALE_CELL.test(cell))) {
      return undefined;
    }
    if (amounts.length === 0 && label !== "") {
      return statedScope(label) ?? "unstated";
    }
  }
  return undefined;
}

// Fails closed: a flow is total only in a table and page with no scope cue, else it needs a stated scope.
function figureScope(
  kind: ConceptKind,
  document: IssuerReportDocument,
  rows: readonly (readonly string[])[],
  rowIndex: number,
): FigureScope | IssuerReportFailureReason {
  const label = rowLabel(rows[rowIndex] ?? []);
  const own = statedScope(label);
  if (own !== undefined) {
    return kind === "stock" ? "unproven-scope" : SCOPE_OUTCOMES[own];
  }
  const cued =
    document.proseScopeCue ||
    rows.some((row) => row.some((cell) => SCOPE_CUE.test(scopeText(cell))));
  if (!cued) {
    return "total";
  }
  const caption = captionScope(rows, rowIndex, kind !== "stock");
  if (kind === "stock") {
    if (caption === "total") {
      return "total";
    }
    return caption === "discontinued" ? "discontinued-operations" : "unproven-scope";
  }
  if (caption === undefined || caption === "unstated") {
    return "unproven-scope";
  }
  return caption === "continuing" && TOTAL_LABEL.test(label)
    ? "unproven-scope"
    : SCOPE_OUTCOMES[caption];
}

function readFigure(
  concept: string,
  cell: string,
  packet: IssuerReportPacket,
): IssuerReportFigure | IssuerReportFailureReason {
  if (!Object.hasOwn(CONCEPTS, concept)) {
    return "unknown-concept";
  }
  const known = concept as IssuerReportConcept;
  const ref = cell.match(CELL_REF);
  const tableId = ref === null ? undefined : `t${ref[1] ?? ""}`;
  const document = packet.documents.find((row) => row.tables.some((table) => table.id === tableId));
  const rows = document?.tables.find((table) => table.id === tableId)?.rows;
  const rowIndex = Number(ref?.[2]);
  const column = Number(ref?.[3]);
  const row = rows?.[rowIndex];
  const cellText = row?.[column];
  if (document === undefined || rows === undefined || row === undefined || cellText === undefined) {
    return "cell-not-found";
  }
  const number = cellNumber(cellText);
  if (number === undefined) {
    return "cell-not-numeric";
  }
  const headers = columnHeaders(rows, rowIndex, column);
  const dates = [...new Set(headers.raw.flatMap((text) => datesIn(text)))];
  if (dates.length === 0) {
    return "period-not-declared";
  }
  const [periodEnd] = dates;
  if (dates.length > 1 || periodEnd === undefined) {
    return "period-ambiguous";
  }
  const period = periodBasis(headers.filled.join(" "), document.fiscalYearEndMonth, periodEnd);
  const { kind } = CONCEPTS[known];
  if (period === undefined) {
    return "period-length-not-declared";
  }
  if ((kind === "stock") !== (period.basis === "instant")) {
    return "basis-mismatch";
  }
  if (period.basis !== "instant" && period.months === undefined) {
    return "period-length-not-declared";
  }
  const { units, scaleCells, scales, currency: columnCurrency, unparsed } = columnUnit(headers.raw);
  const label = rowLabel(row);
  const declared = declaredLabel(rows, rowIndex);
  if (!CONCEPTS[known].row.test(declared)) {
    return "label-mismatch";
  }
  const scope = figureScope(kind, document, rows, rowIndex);
  if (scope !== "total" && scope !== "continuing") {
    return scope;
  }
  const perShare = SUBUNIT_LABEL.test(declared);
  const [unitText] = units;
  if (units.length > 1 || unparsed) {
    return "unit-ambiguous";
  }
  if ((kind === "per-share") !== perShare) {
    return kind === "per-share" || unitText !== undefined ? "unit-mismatch" : "unit-not-declared";
  }
  if (unitText === undefined && !perShare) {
    return "unit-not-declared";
  }
  if (!perShare && scales.size > 1) {
    return "unit-ambiguous";
  }
  if (
    columnCurrency !== undefined &&
    document.declaredCurrency !== undefined &&
    columnCurrency !== document.declaredCurrency
  ) {
    return "currency-mismatch";
  }
  const currency = columnCurrency ?? document.declaredCurrency;
  if (currency === undefined) {
    return "currency-not-declared";
  }
  if (periodEnd > document.announcedAt) {
    return "period-after-announcement";
  }
  const scale = perShare ? 0.01 : ([...scales][0] ?? 1);
  return {
    concept: known,
    sourceId: document.sourceId,
    rowLabel: label,
    cellText,
    unitText: perShare ? declared : [unitText ?? "", ...scaleCells].join(" "),
    value: Number((number * scale).toPrecision(12)),
    currency,
    periodEnd,
    basis: period.basis,
    ...(period.months === undefined ? {} : { periodMonths: period.months }),
    restated: RESTATED_HEADER.test(headers.filled.join(" ")),
    scope,
    document,
  };
}

function figureKey(figure: IssuerReportFigure): string {
  return `${figure.concept}|${figure.scope}|${figure.basis}|${figure.periodEnd}|${String(figure.periodMonths)}`;
}

export function readIssuerReportMapping(
  content: string,
  packet: IssuerReportPacket,
): IssuerReportReading | undefined {
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.figures)) {
    return undefined;
  }
  const failures: IssuerReportFailure[] = [];
  const byKey = new Map<string, IssuerReportFigure>();
  const conflicted = new Set<string>();
  const entries = parsed.figures.map((entry: unknown) => ({
    concept: isRecord(entry) && typeof entry.concept === "string" ? entry.concept : "",
    cell: isRecord(entry) && typeof entry.cell === "string" ? entry.cell : "",
  }));
  for (const { concept, cell } of entries) {
    const reused = entries.some((entry) => entry.cell === cell && entry.concept !== concept);
    const figure = reused ? "cell-reused" : readFigure(concept, cell, packet);
    if (typeof figure === "string") {
      failures.push({ cell, concept, reason: figure });
      continue;
    }
    const key = figureKey(figure);
    const prior = byKey.get(key);
    if (prior === undefined) {
      byKey.set(key, figure);
    } else if (prior.value !== figure.value || prior.currency !== figure.currency) {
      conflicted.add(key);
      failures.push({ cell, concept, reason: "conflicting-figures" });
    }
  }
  const figures = [...byKey.entries()].flatMap(([key, figure]) =>
    conflicted.has(key) ? [] : [figure],
  );
  return { figures, failures };
}

const BASIS_LABELS: Readonly<Record<PeriodBasis, string>> = {
  quarter: "quarter",
  ytd: "year to date",
  annual: "financial year",
  instant: "as at period end",
};

function documentBasis(document: IssuerReportDocument): string {
  const origin =
    document.hostKind === "primary"
      ? `issuer document "${document.title}" (${document.host})`
      : `mirror copy of the issuer document "${document.title}" at ${document.host}, not the exchange's own page`;
  const dated =
    document.announcedAtBasis === "announcement"
      ? `announced ${document.announcedAt}`
      : `public by ${document.announcedAt} (provider published date, else fetch date)`;
  return `${origin}; ${dated}`;
}

function figureInput(figure: IssuerReportFigure): MetricInput {
  return {
    label: figure.rowLabel,
    value: figure.cellText,
    artifact: "issuerReport",
    periodType: PERIOD_TYPES[figure.basis],
    periodEnd: figure.periodEnd,
    unit: figure.unitText,
    currency: figure.currency,
    sourceIds: [figure.sourceId],
  };
}

function subunitWord(figure: IssuerReportFigure): string {
  if (/\bsen\b/iu.test(figure.unitText) || figure.currency === "MYR") {
    return "sen";
  }
  return /\bcents?\b/iu.test(figure.unitText) ? "cents" : "subunits";
}

function scopeSuffix(figures: readonly IssuerReportFigure[]): string {
  return figures.every((figure) => figure.scope === "continuing") ? ", continuing operations" : "";
}

function figureMetric(figure: IssuerReportFigure): MetricResult {
  const { label, kind } = CONCEPTS[figure.concept];
  const scopeId = figure.scope === "total" ? "" : `-${figure.scope}`;
  return {
    id: `issuer-report-${figure.concept}${scopeId}-${figure.basis}-${figure.periodEnd}`,
    label: `${label}, ${BASIS_LABELS[figure.basis]}${scopeSuffix([figure])}`,
    unit: kind === "per-share" ? "currency-per-share" : "currency",
    basis: `Declared unit "${figure.unitText}"; ${documentBasis(figure.document)}${figure.restated ? RESTATED_NOTE : ""}`,
    status: "value",
    value:
      kind === "per-share"
        ? `${figure.currency} ${String(figure.value)} or ${figure.cellText} ${subunitWord(figure)}`
        : figure.value,
    currency: figure.currency,
    periodEnd: figure.periodEnd,
    ...(figure.periodMonths === undefined ? {} : { periodMonths: figure.periodMonths }),
    inputs: [figureInput(figure)],
    sourceIds: [figure.sourceId],
  };
}

function priorYearEnd(periodEnd: string): string {
  return `${String(Number(periodEnd.slice(0, 4)) - 1)}${periodEnd.slice(4)}`;
}

type FigurePair = readonly [IssuerReportFigure, IssuerReportFigure];

function derivedMetric(
  id: string,
  label: string,
  basis: string,
  found: FigurePair | "unpaired",
  compute: (inputs: FigurePair) => number | string,
): MetricResult {
  if (found === "unpaired") {
    return {
      id,
      label,
      unit: "ratio-percent",
      basis,
      status: "missing",
      reason: "no checked figures share the period this row needs",
      inputs: [],
      sourceIds: [],
    };
  }
  const [first] = found;
  const currencies = new Set(found.map((input) => input.currency));
  const scopes = new Set(found.map((input) => input.scope));
  const common = {
    id,
    label: `${label}${scopeSuffix(found)}`,
    unit: "ratio-percent" as const,
    basis: found.some((input) => input.restated) ? `${basis}${RESTATED_NOTE}` : basis,
    periodEnd: first.periodEnd,
    ...(first.periodMonths === undefined ? {} : { periodMonths: first.periodMonths }),
    inputs: found.map((input) => figureInput(input)),
    sourceIds: [...new Set(found.map((input) => input.sourceId))],
  };
  if (scopes.size > 1) {
    return { ...common, status: "missing", reason: MIXED_SCOPE_REASON };
  }
  if (currencies.size > 1) {
    return { ...common, status: "missing", reason: "inputs are reported in different currencies" };
  }
  const value = compute(found);
  return typeof value === "string"
    ? { ...common, status: "not-meaningful", reason: value }
    : { ...common, status: "value", value };
}

const ofScope = (figure: IssuerReportFigure, scope?: FigureScope) =>
  scope === undefined || figure.scope === scope;

const newestFirst = (left: FigurePair, right: FigurePair) =>
  right[0].periodEnd.localeCompare(left[0].periodEnd) ||
  SCOPE_ORDER.indexOf(left[0].scope) - SCOPE_ORDER.indexOf(right[0].scope);

function priorRevenueCheck(figures: readonly IssuerReportFigure[], prior: IssuerReportFigure) {
  const revenue = figures.find(
    (figure) =>
      figure.concept === "revenue" &&
      figure.scope === prior.scope &&
      figure.basis === prior.basis &&
      figure.periodMonths === prior.periodMonths &&
      figure.periodEnd === prior.periodEnd &&
      figure.currency === prior.currency,
  );
  return revenueShareCheck(
    `prior-year ${CONCEPTS[prior.concept].label.toLowerCase()}`,
    prior.value,
    revenue?.value,
    ` ${prior.currency}`,
  );
}

function derivedMetrics(figures: readonly IssuerReportFigure[]): readonly MetricResult[] {
  // The newest same-scope pair; else a mixed pair, so the derived row is withheld; else "unpaired".
  const pair = (
    first: IssuerReportConcept,
    basis: PeriodBasis,
    second: IssuerReportConcept,
    periodEnd: (like: IssuerReportFigure) => string = (like) => like.periodEnd,
  ): FigurePair | "unpaired" | undefined => {
    const firsts = figures.filter((figure) => figure.concept === first && figure.basis === basis);
    const pairs = (scope?: FigureScope): readonly FigurePair[] =>
      firsts.flatMap((like) => {
        const partner = figures.find(
          (figure) =>
            figure.concept === second &&
            figure.basis === like.basis &&
            figure.periodMonths === like.periodMonths &&
            figure.periodEnd === periodEnd(like) &&
            ofScope(like, scope) &&
            ofScope(figure, scope),
        );
        return partner === undefined ? [] : [[like, partner] as const];
      });
    const [shared] = SCOPE_ORDER.flatMap((scope) => pairs(scope)).toSorted(newestFirst);
    const [mixed] = pairs().toSorted(newestFirst);
    const hasSecond = figures.some((figure) => figure.concept === second && figure.basis === basis);
    if (shared !== undefined || mixed !== undefined) {
      return shared ?? mixed;
    }
    return first !== second && firsts.length > 0 && hasSecond ? "unpaired" : undefined;
  };
  const metrics: MetricResult[] = [];
  for (const basis of ["quarter", "ytd", "annual"] as const) {
    for (const concept of ["revenue", "profit-attributable-to-owners"] as const) {
      const yoy = pair(concept, basis, concept, (like) => priorYearEnd(like.periodEnd));
      if (yoy !== undefined) {
        const check =
          yoy === "unpaired" || concept === "revenue" ? {} : priorRevenueCheck(figures, yoy[1]);
        const metric = derivedMetric(
          `issuer-report-${concept}-yoy-${basis}`,
          `${CONCEPTS[concept].label} change vs prior-year ${BASIS_LABELS[basis]}`,
          "(current − prior-year same period) / |prior-year same period|",
          yoy,
          ([current, prior]) =>
            deltaPercent(current.value, prior.value) === undefined
              ? notMeaningfulYoyReason(
                  CONCEPTS[concept].label.toLowerCase(),
                  prior.value,
                  current.value,
                  ` ${current.currency}`,
                )
              : (check.reason ?? (current.value - prior.value) / Math.abs(prior.value)),
        );
        metrics.push(
          metric.status === "value" && check.note !== undefined
            ? { ...metric, basis: `${metric.basis}; ${check.note}` }
            : metric,
        );
      }
    }
    const margin = pair("profit-for-period", basis, "revenue");
    const parentOnly =
      margin === undefined && pair("profit-attributable-to-owners", basis, "revenue") !== undefined;
    if (margin !== undefined || parentOnly) {
      const metric = derivedMetric(
        `issuer-report-net-margin-${basis}`,
        `Net margin, ${BASIS_LABELS[basis]}`,
        "profit for the period, including non-controlling interests / revenue, same period",
        margin ?? "unpaired",
        ([profit, revenue]) =>
          revenue.value <= 0 ? "revenue is zero or negative" : profit.value / revenue.value,
      );
      metrics.push(parentOnly ? { ...metric, reason: PARENT_PROFIT_ONLY_REASON } : metric);
    }
    const freeCashFlow = pair("operating-cash-flow", basis, "capital-expenditure");
    if (freeCashFlow !== undefined) {
      const metric = derivedMetric(
        `issuer-report-free-cash-flow-${basis}`,
        `Free cash flow, ${BASIS_LABELS[basis]}`,
        "net cash from operating activities − purchases of property, plant and equipment",
        freeCashFlow,
        ([cashFlow, capex]) => cashFlow.value - Math.abs(capex.value),
      );
      metrics.push({
        ...metric,
        unit: "currency",
        ...(freeCashFlow === "unpaired" ? {} : { currency: freeCashFlow[0].currency }),
      });
    }
  }
  const balance = pair("current-assets", "instant", "current-liabilities");
  if (balance !== undefined) {
    metrics.push({
      ...derivedMetric(
        "issuer-report-current-ratio",
        "Current ratio",
        "total current assets / total current liabilities, same balance-sheet date",
        balance,
        ([assets, liabilities]) =>
          liabilities.value <= 0
            ? "current liabilities are zero or negative"
            : assets.value / liabilities.value,
      ),
      unit: "ratio",
    });
  }
  return metrics;
}

// Flows show the newest period and its prior-year comparative, the pair the YoY rows use.
function shownFigures(figures: readonly IssuerReportFigure[]): readonly IssuerReportFigure[] {
  const newest = new Map<string, string>();
  for (const figure of figures) {
    const key = `${figure.concept}|${figure.basis}`;
    if (figure.periodEnd > (newest.get(key) ?? "")) {
      newest.set(key, figure.periodEnd);
    }
  }
  return figures.filter((figure) => {
    const end = newest.get(`${figure.concept}|${figure.basis}`) ?? "";
    return (
      figure.basis === "instant" ||
      figure.periodEnd === end ||
      figure.periodEnd === priorYearEnd(end)
    );
  });
}

function issuerReportSection(figures: readonly IssuerReportFigure[]): MetricSection {
  return {
    id: ISSUER_REPORT_SECTION_ID,
    title: "Issuer report figures",
    metrics: [
      ...shownFigures(figures)
        .toSorted(
          (left, right) =>
            ISSUER_REPORT_CONCEPTS.indexOf(left.concept) -
              ISSUER_REPORT_CONCEPTS.indexOf(right.concept) ||
            right.periodEnd.localeCompare(left.periodEnd) ||
            left.basis.localeCompare(right.basis) ||
            SCOPE_ORDER.indexOf(left.scope) - SCOPE_ORDER.indexOf(right.scope),
        )
        .map((figure) => figureMetric(figure)),
      ...derivedMetrics(figures),
    ],
  };
}

function issuerReportGap(
  symbol: string,
  message: string,
  cause: "provider-data-missing" | "validation-failed",
): SourceGap {
  return sourceGap({
    source: GAP_SOURCE,
    message,
    symbol,
    provider: "web-gather",
    capability: "extended-evidence",
    cause,
    evidenceQualityImpact: "no-cap",
  });
}

const isFullYear = (figure: IssuerReportFigure) =>
  figure.basis === "annual" || figure.periodMonths === 12;

interface ProviderEpsCheck {
  readonly gaps: readonly SourceGap[];
  readonly withhold: boolean;
}

function providerEpsCheck(
  symbol: string,
  collectedSources: CollectedSources,
  figures: readonly IssuerReportFigure[],
): ProviderEpsCheck {
  const snapshot = collectedSources.marketSnapshots.find(
    (row) => row.symbol.toUpperCase() === symbol.toUpperCase(),
  );
  const providerEps = snapshot?.fundamentals?.epsTrailingTwelveMonths;
  const currency = snapshot?.identity?.quoteCurrency;
  if (providerEps === undefined || currency === undefined) {
    return { gaps: [], withhold: false };
  }
  const flows = figures.filter(
    (figure) =>
      figure.concept === "basic-eps" &&
      figure.scope === "total" &&
      figure.basis !== "instant" &&
      figure.currency === currency,
  );
  const newestEnd = flows
    .map(({ periodEnd }) => periodEnd)
    .toSorted()
    .at(-1);
  const [issuer] = flows
    .filter(({ periodEnd }) => periodEnd === newestEnd)
    .toSorted((left, right) => right.value - left.value);
  const yahoo = `Yahoo trailing EPS ${String(providerEps)} ${currency} (no as-of date; period, share count and basic or diluted basis undisclosed)`;
  if (issuer === undefined || issuer.value <= 0) {
    return {
      gaps: [
        issuerReportGap(
          symbol,
          `${yahoo} is published unreconciled: no positive total-operations basic EPS in ${currency} passed the issuer report table check to compare it with; the trailing PE and payout ratio derived from it are unreconciled too`,
          "provider-data-missing",
        ),
      ],
      withhold: false,
    };
  }
  if (providerEps < issuer.value) {
    return {
      gaps: [
        issuerReportGap(
          symbol,
          `${yahoo} is below the issuer-reported ${epsPeriodLabel(issuer)} basic EPS of ${String(issuer.value)} ${currency} to ${issuer.periodEnd}, ${unreconciledClause(issuer)}; it is withheld with the trailing PE and payout ratio derived from it`,
          "validation-failed",
        ),
      ],
      withhold: true,
    };
  }
  const newestReported = figures
    .map(({ periodEnd }) => periodEnd)
    .toSorted()
    .at(-1);
  // Two decimals is the precision Yahoo publishes, as in the SEC earnings-basis comparison.
  const matchesYear = isFullYear(issuer) && providerEps.toFixed(2) === issuer.value.toFixed(2);
  if (matchesYear && issuer.periodEnd === newestReported) {
    return { gaps: [], withhold: false };
  }
  let missing =
    "a trailing twelve months to that date also needs the prior-financial-year basic EPS (financial year − prior year-to-date + year-to-date), which this run does not compute";
  if (matchesYear) {
    missing = `it matches that financial year at two decimals while the newest issuer-reported period ends ${String(newestReported)}, so it may be a stale value`;
  } else if (isFullYear(issuer)) {
    missing =
      "it is above the financial-year figure a trailing twelve months to that date equals, so a later period, a stale value or another share basis would each fit";
  }
  return {
    gaps: [
      issuerReportGap(
        symbol,
        `${yahoo} is published unreconciled: it is not below the issuer-reported ${epsPeriodLabel(issuer)} basic EPS of ${String(issuer.value)} ${currency} to ${issuer.periodEnd}, but ${missing}; the trailing PE and payout ratio derived from it are unreconciled too`,
        "provider-data-missing",
      ),
    ],
    withhold: false,
  };
}

function unreconciledClause(figure: IssuerReportFigure): string {
  return isFullYear(figure)
    ? "which a trailing twelve months to that date equals; this run reads no weighted share counts, so the two cannot be shown to reconcile (a stale value or another share basis would each fit)"
    : "which a trailing twelve months to that date contains; this run reads no prior-fiscal-year EPS or weighted share counts, so the two cannot be shown to reconcile (a stale value, another share basis or a loss quarter outside the issuer period would each fit)";
}

function epsPeriodLabel(figure: IssuerReportFigure): string {
  if (figure.basis === "quarter") {
    return "quarterly";
  }
  if (isFullYear(figure)) {
    return "financial-year";
  }
  return figure.periodMonths === undefined
    ? "year-to-date"
    : `${String(figure.periodMonths)}-month year-to-date`;
}

export interface IssuerReportPhaseInput {
  readonly symbol: string;
  readonly collectedSources: CollectedSources;
  readonly generateMapping: (
    packet: IssuerReportPacket,
  ) => Promise<StageOutput & { readonly stage: "issuer-report-mapping" }>;
}

export interface IssuerReportPhaseResult {
  readonly collectedSources: CollectedSources;
  readonly stageOutputs: readonly StageOutput[];
}

function withIssuerReport(
  collectedSources: CollectedSources,
  gaps: readonly SourceGap[],
  section?: MetricSection,
): CollectedSources {
  return {
    ...collectedSources,
    ...(section === undefined
      ? {}
      : { metricSections: [...(collectedSources.metricSections ?? []), section] }),
    sourceGaps: [...collectedSources.sourceGaps, ...gaps],
  };
}

// Non-SEC equity only: the model maps concepts to table cells, code reads and checks every value.
export async function runIssuerReportPhase(
  input: IssuerReportPhaseInput,
): Promise<IssuerReportPhaseResult> {
  const { symbol, collectedSources } = input;
  const profile = exchangeProfileFor(symbol);
  if (profile === undefined) {
    return { collectedSources, stageOutputs: [] };
  }
  const packet = issuerReportPacket(
    symbol,
    collectedSources.extendedSources,
    collectedSources.rawSnapshots,
  );
  const hosts = [...profile.reportHosts.primary, ...profile.reportHosts.mirror].join(", ");
  if (packet.documents.length === 0) {
    return {
      collectedSources: withIssuerReport(collectedSources, [
        issuerReportGap(
          symbol,
          `No quarterly or annual report table text reached for ${symbol} from ${profile.exchange} or its allowlisted mirrors (${hosts}); issuer financial figures are unavailable`,
          "provider-data-missing",
        ),
      ]),
      stageOutputs: [],
    };
  }
  const output = await input.generateMapping(packet);
  const reading = readIssuerReportMapping(output.content, packet);
  if (reading === undefined) {
    return {
      collectedSources: withIssuerReport(collectedSources, [
        issuerReportGap(
          symbol,
          `Issuer report mapping for ${symbol} was not valid JSON with a figures array; no issuer report figure was published`,
          "validation-failed",
        ),
      ]),
      stageOutputs: [output],
    };
  }
  const failureGaps =
    reading.failures.length === 0
      ? []
      : [
          issuerReportGap(
            symbol,
            `${String(reading.failures.length)} issuer report figure(s) for ${symbol} failed the table check and were withheld: ${reading.failures
              .slice(0, 6)
              .map(
                (failure) =>
                  `${failure.concept || "unnamed"} at ${failure.cell || "no cell"} (${failure.reason})`,
              )
              .join("; ")}`,
            "validation-failed",
          ),
        ];
  const emptyGap =
    reading.figures.length === 0
      ? [
          issuerReportGap(
            symbol,
            `No issuer report figure for ${symbol} passed the table check; issuer financial figures are unavailable`,
            "validation-failed",
          ),
        ]
      : [];
  const published = new Set(reading.figures.map((figure) => figure.concept));
  const unpublished = ISSUER_REPORT_CONCEPTS.filter((concept) => !published.has(concept));
  const unpublishedGap =
    reading.figures.length === 0 || unpublished.length === 0
      ? []
      : [
          issuerReportGap(
            symbol,
            `Issuer report text for ${symbol} published no checked figure for: ${unpublished
              .map((concept) => CONCEPTS[concept].label)
              .join(
                ", ",
              )}; the report pages reached do not show them, or no cell for them passed the table check`,
            "provider-data-missing",
          ),
        ];
  const eps = providerEpsCheck(symbol, collectedSources, reading.figures);
  const section = reading.figures.length === 0 ? undefined : issuerReportSection(reading.figures);
  const withheld = section?.metrics.filter((metric) => metric.status === "missing") ?? [];
  const withheldGap =
    withheld.length === 0
      ? []
      : [
          issuerReportGap(
            symbol,
            `${String(withheld.length)} issuer report derived metric(s) for ${symbol} withheld: ${withheld
              .map((metric) => `${metric.label} (${metric.reason ?? "no reason"})`)
              .join("; ")}`,
            "validation-failed",
          ),
        ];
  const framed =
    section === undefined
      ? collectedSources
      : withIssuerReportFramework(collectedSources, symbol, section);
  return {
    collectedSources: withIssuerReport(
      eps.withhold ? withholdProviderEps(framed, symbol, PROVIDER_EPS_WITHHELD) : framed,
      [...failureGaps, ...emptyGap, ...unpublishedGap, ...withheldGap, ...eps.gaps],
      section,
    ),
    stageOutputs: [output],
  };
}

export async function runIssuerReportMappingStage(
  packet: IssuerReportPacket,
  symbol: string,
  job: {
    readonly command: ResearchCommand;
    readonly config: Pick<AppConfig, "promptDir">;
    readonly provider: ModelProvider;
  },
  runParams: ResolvedRunParams,
): Promise<StageOutput & { readonly stage: "issuer-report-mapping" }> {
  const loaded = await loadStagePrompt("issuer-report-mapping", job.command, job.config.promptDir);
  const prompt = JSON.stringify({
    stage: "issuer-report-mapping",
    instruction: loaded.instruction,
    goal: loaded.goal,
    subject: symbol,
    ...issuerReportMappingInput(packet),
  });
  const startedAt = performance.now();
  const response = await job.provider.generate({
    step: symbol,
    model: runParams.quickModel,
    ...(runParams.quickModelParams !== undefined ? { params: runParams.quickModelParams } : {}),
    responseFormat: "json",
    messages: [
      { role: "system", content: withUntrustedModelInputRule(loaded.system) },
      { role: "user", content: prompt },
    ],
  });
  const endedAt = performance.now();
  return {
    stage: "issuer-report-mapping",
    content: response.content,
    tokenEstimate: response.tokenEstimate,
    usage: response.usage ?? "unknown",
    durationMs: Math.max(endedAt - startedAt, Number.EPSILON),
    ...(response.costEstimateUsd !== undefined
      ? { costEstimateUsd: response.costEstimateUsd }
      : {}),
    ...(response.costPricing !== undefined ? { costPricing: response.costPricing } : {}),
  };
}
