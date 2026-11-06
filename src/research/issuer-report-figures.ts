import {
  exchangeProfileFor,
  issuerReportHostKind,
  type ExchangeProfile,
  type IssuerReportHostKind,
} from "../domain/exchange-profile";
import { sourceGap } from "../domain/source-gaps";
import type { Source, SourceGap } from "../domain/sources";
import { isRecord } from "../guards";
import type {
  MetricInput,
  MetricResult,
  MetricSection,
} from "../sources/extended-evidence/metric-engine";
import { canonicalizeUrl } from "../sources/news-utils";
import type { CollectedSources, RawSourceSnapshot } from "../sources/types";
import type { StageOutput } from "./final-synthesis";
import { rawTextsByUrl } from "./web-figure-verification";

type ConceptKind = "flow" | "stock" | "per-share";

const CONCEPTS = {
  revenue: { label: "Revenue", kind: "flow", row: /^(?!.*\bcost\b).*\b(?:revenue|turnover)\b/iu },
  "profit-before-tax": { label: "Profit before tax", kind: "flow", row: /\bbefore tax/iu },
  "profit-for-period": {
    label: "Profit for the period",
    kind: "flow",
    row: /^(?!.*(?:attributable|before tax)).*\bprofit\b.*\b(?:period|year)\b/iu,
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
  "total-equity": { label: "Total equity", kind: "stock", row: /\btotal equity\b(?! and)/iu },
} as const satisfies Record<
  string,
  { readonly label: string; readonly kind: ConceptKind; readonly row: RegExp }
>;

type IssuerReportConcept = keyof typeof CONCEPTS;
type PeriodBasis = "quarter" | "ytd" | "annual" | "instant";

const ISSUER_REPORT_CONCEPTS = Object.keys(CONCEPTS) as readonly IssuerReportConcept[];
const ISSUER_REPORT_SECTION_ID = "issuer-report";

const MAX_DOCUMENTS = 4;
const GAP_SOURCE = "issuer-report";
const CELL_REF = /^t(\d+):r(\d+):c(\d+)$/u;
const NUMBER_CELL = /^(\()?(-)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\))?$/u;
const DATE_PATTERN = /\b(\d{1,2})[\s\-/.]+([A-Za-z]{3,9}|\d{1,2})[\s\-/.,]+(\d{4}|\d{2})\b/gu;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const UNIT_CELL =
  /^(?<currency>RM|MYR|USD|SGD|HKD|EUR|GBP|CNY|RMB)\s*(?:['’‘]\s*(?<scale>000|mil|million|m|bil|billion|b))?$/iu;
const UNIT_SCALES: Readonly<Record<string, number>> = {
  "000": 1e3,
  mil: 1e6,
  million: 1e6,
  m: 1e6,
  bil: 1e9,
  billion: 1e9,
  b: 1e9,
};
const CURRENCY_ALIASES: Readonly<Record<string, string>> = { RM: "MYR", RMB: "CNY" };
const SUB_ITEM_LABEL = /^(?:[-–•]|(?:basic|diluted)\b)/iu;
const SUBUNIT_LABEL = /\((?:subunit|sen|cents?)\)|\bsen\b/iu;
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

function cellNumber(text: string): number | undefined {
  const match = text.replaceAll(/\s+/gu, "").match(NUMBER_CELL);
  if (match === null || (match[1] === undefined) !== (match[5] === undefined)) {
    return undefined;
  }
  const value = Number(`${match[3] ?? ""}${match[4] ?? ""}`.replaceAll(",", ""));
  return match[1] !== undefined || match[2] !== undefined ? -value : value;
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
    tables: tables.map((rows, index) => ({ id: `t${String(tableOffset + index + 1)}`, rows })),
  };
}

// Reads the stored page text of web sources on the Exchange Profile's report hosts (ADR 0006).
export function issuerReportPacket(
  symbol: string,
  sources: readonly Source[],
  rawSnapshots: readonly RawSourceSnapshot[],
): IssuerReportPacket {
  const profile = exchangeProfileFor(symbol);
  if (profile === undefined) {
    return { documents: [] };
  }
  const rawTexts = rawTextsByUrl(rawSnapshots);
  const candidates = sources
    .filter((source) => source.kind === "web" && issuerReportHostKind(profile, source.url))
    .toSorted((left, right) => right.fetchedAt.localeCompare(left.fetchedAt))
    .slice(0, MAX_DOCUMENTS);
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

function valueColumns(rows: readonly (readonly string[])[]): ReadonlySet<number> {
  return new Set(
    rows.flatMap((row) =>
      row.flatMap((cell, index) => (cellNumber(cell) === undefined ? [] : [index])),
    ),
  );
}

// Header rows above the data run that holds the row; a row of figures ends the block, so no unit crosses it.
function columnHeaders(
  rows: readonly (readonly string[])[],
  rowIndex: number,
  column: number,
): { readonly raw: readonly string[]; readonly filled: readonly string[] } {
  const columns = valueColumns(rows);
  const raw: string[] = [];
  const filled: string[] = [];
  let collecting = false;
  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    const row = rows[index] ?? [];
    const isData = row.some((cell) => cellNumber(cell) !== undefined);
    const isHeader =
      !isData && row.some((cell, cellIndex) => columns.has(cellIndex) && cell !== "");
    if (isData && collecting) {
      break;
    }
    if (!isHeader) {
      continue;
    }
    collecting = true;
    const own = row[column] ?? "";
    let merged = own;
    for (let left = column - 1; merged === "" && left >= 0 && columns.has(left); left -= 1) {
      merged = row[left] ?? "";
    }
    raw.unshift(own);
    filled.unshift(merged);
  }
  return { raw, filled };
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

function rowLabel(row: readonly string[]): string {
  return row.find((cell) => cell !== "" && cellNumber(cell) === undefined) ?? "";
}

// A sub-item row ("- Basic", "- Owners of the Company") reads with the caption rows directly above it.
function declaredLabel(rows: readonly (readonly string[])[], rowIndex: number): string {
  const own = rowLabel(rows[rowIndex] ?? []);
  if (!SUB_ITEM_LABEL.test(own)) {
    return own;
  }
  const columns = valueColumns(rows);
  const captions: string[] = [];
  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    const row = rows[index] ?? [];
    if (row.some((cell, cellIndex) => columns.has(cellIndex) && cell !== "")) {
      break;
    }
    captions.unshift(rowLabel(row));
  }
  return [...captions, own].join(" ");
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
  const units = [...new Set(headers.raw.flatMap((text) => (UNIT_CELL.test(text) ? [text] : [])))];
  const label = rowLabel(row);
  const declared = declaredLabel(rows, rowIndex);
  if (!CONCEPTS[known].row.test(declared)) {
    return "label-mismatch";
  }
  const perShare = SUBUNIT_LABEL.test(declared);
  const [unitText] = units;
  if (units.length > 1) {
    return "unit-ambiguous";
  }
  if ((kind === "per-share") !== perShare) {
    return kind === "per-share" || unitText !== undefined ? "unit-mismatch" : "unit-not-declared";
  }
  if (unitText === undefined && !perShare) {
    return "unit-not-declared";
  }
  const groups = unitText?.match(UNIT_CELL)?.groups;
  const columnCurrency =
    groups?.currency === undefined
      ? undefined
      : (CURRENCY_ALIASES[groups.currency.toUpperCase()] ?? groups.currency.toUpperCase());
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
  const scale = perShare ? 0.01 : (UNIT_SCALES[groups?.scale?.toLowerCase() ?? ""] ?? 1);
  return {
    concept: known,
    sourceId: document.sourceId,
    rowLabel: label,
    cellText,
    unitText: perShare ? declared : (unitText ?? ""),
    value: Number((number * scale).toPrecision(12)),
    currency,
    periodEnd,
    basis: period.basis,
    ...(period.months === undefined ? {} : { periodMonths: period.months }),
    restated: RESTATED_HEADER.test(headers.filled.join(" ")),
    document,
  };
}

function figureKey(figure: IssuerReportFigure): string {
  return `${figure.concept}|${figure.basis}|${figure.periodEnd}|${String(figure.periodMonths)}`;
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

function figureMetric(figure: IssuerReportFigure): MetricResult {
  const { label, kind } = CONCEPTS[figure.concept];
  return {
    id: `issuer-report-${figure.concept}-${figure.basis}-${figure.periodEnd}`,
    label: `${label}, ${BASIS_LABELS[figure.basis]}`,
    unit: kind === "per-share" ? "currency-per-share" : "currency",
    basis: `Declared unit "${figure.unitText}"; ${documentBasis(figure.document)}${figure.restated ? RESTATED_NOTE : ""}`,
    status: "value",
    value:
      kind === "per-share"
        ? `${figure.currency} ${String(figure.value)} (${figure.cellText} ${subunitWord(figure)})`
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

function derivedMetric(
  id: string,
  label: string,
  basis: string,
  inputs: readonly IssuerReportFigure[],
  compute: () => number | string,
): MetricResult {
  const [first] = inputs;
  const currencies = new Set(inputs.map((input) => input.currency));
  const common = {
    id,
    label,
    unit: "ratio-percent" as const,
    basis: inputs.some((input) => input.restated) ? `${basis}${RESTATED_NOTE}` : basis,
    ...(first === undefined ? {} : { periodEnd: first.periodEnd }),
    ...(first?.periodMonths === undefined ? {} : { periodMonths: first.periodMonths }),
    inputs: inputs.map((input) => figureInput(input)),
    sourceIds: [...new Set(inputs.map((input) => input.sourceId))],
  };
  if (currencies.size > 1) {
    return { ...common, status: "missing", reason: "inputs are reported in different currencies" };
  }
  const value = compute();
  return typeof value === "string"
    ? { ...common, status: "not-meaningful", reason: value }
    : { ...common, status: "value", value };
}

function derivedMetrics(figures: readonly IssuerReportFigure[]): readonly MetricResult[] {
  const find = (
    concept: IssuerReportConcept,
    like: IssuerReportFigure,
    periodEnd = like.periodEnd,
  ): IssuerReportFigure | undefined =>
    figures.find(
      (figure) =>
        figure.concept === concept &&
        figure.basis === like.basis &&
        figure.periodMonths === like.periodMonths &&
        figure.periodEnd === periodEnd,
    );
  const latest = (concept: IssuerReportConcept, basis: PeriodBasis) =>
    figures
      .filter((figure) => figure.concept === concept && figure.basis === basis)
      .toSorted((left, right) => right.periodEnd.localeCompare(left.periodEnd))[0];
  const metrics: MetricResult[] = [];
  for (const basis of ["quarter", "ytd", "annual"] as const) {
    for (const concept of ["revenue", "profit-attributable-to-owners"] as const) {
      const current = latest(concept, basis);
      const prior =
        current === undefined ? undefined : find(concept, current, priorYearEnd(current.periodEnd));
      if (current !== undefined && prior !== undefined) {
        metrics.push(
          derivedMetric(
            `issuer-report-${concept}-yoy-${basis}`,
            `${CONCEPTS[concept].label} change vs prior-year ${BASIS_LABELS[basis]}`,
            "(current − prior-year same period) / |prior-year same period|",
            [current, prior],
            () =>
              prior.value <= 0
                ? "prior-year figure is zero or negative"
                : (current.value - prior.value) / Math.abs(prior.value),
          ),
        );
      }
    }
    const revenue = latest("revenue", basis);
    const profit =
      revenue === undefined ? undefined : find("profit-attributable-to-owners", revenue);
    if (revenue !== undefined && profit !== undefined) {
      metrics.push(
        derivedMetric(
          `issuer-report-net-margin-${basis}`,
          `Net margin, ${BASIS_LABELS[basis]}`,
          "profit attributable to owners of the parent / revenue, same period",
          [profit, revenue],
          () => (revenue.value <= 0 ? "revenue is zero or negative" : profit.value / revenue.value),
        ),
      );
    }
    const cashFlow = latest("operating-cash-flow", basis);
    const capex = cashFlow === undefined ? undefined : find("capital-expenditure", cashFlow);
    if (cashFlow !== undefined && capex !== undefined) {
      metrics.push({
        ...derivedMetric(
          `issuer-report-free-cash-flow-${basis}`,
          `Free cash flow, ${BASIS_LABELS[basis]}`,
          "net cash from operating activities − purchases of property, plant and equipment",
          [cashFlow, capex],
          () => cashFlow.value - Math.abs(capex.value),
        ),
        unit: "currency",
        currency: cashFlow.currency,
      });
    }
  }
  const assets = latest("current-assets", "instant");
  const liabilities = assets === undefined ? undefined : find("current-liabilities", assets);
  if (assets !== undefined && liabilities !== undefined) {
    metrics.push({
      ...derivedMetric(
        "issuer-report-current-ratio",
        "Current ratio",
        "total current assets / total current liabilities, same balance-sheet date",
        [assets, liabilities],
        () =>
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
            left.basis.localeCompare(right.basis),
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
  return {
    collectedSources: withIssuerReport(
      collectedSources,
      [...failureGaps, ...emptyGap],
      reading.figures.length === 0 ? undefined : issuerReportSection(reading.figures),
    ),
    stageOutputs: [output],
  };
}
