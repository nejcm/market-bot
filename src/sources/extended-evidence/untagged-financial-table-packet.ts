import type {
  FinancialTable,
  FinancialTableCell,
  FinancialTablePacket,
  FinancialTablePacketLimits,
  FinancialTableRow,
  FinancialTableSourceLocator,
} from "./untagged-financial-tables-contract";

export const FINANCIAL_TABLE_PACKET_LIMITS: FinancialTablePacketLimits = {
  maxDocumentBytes: 5 * 1024 * 1024,
  maxTables: 12,
  maxRowsPerTable: 180,
  maxColumnsPerTable: 24,
  maxCells: 4000,
  maxCellCharacters: 240,
};

const CONTEXT_CHARACTERS = 1200;
const CONTEXT_LINES = 8;
const FINANCIAL_ANCHORS = [
  /\bbalance sheets?\b/iu,
  /\bstatements? of financial position\b/iu,
  /\bstatements? of operations\b/iu,
  /\bincome statements?\b/iu,
  /\bstatements? of income\b/iu,
  /\bstatements? of profit or loss\b/iu,
  /\bstatements? of cash flows?\b/iu,
  /\bcash flow statements?\b/iu,
] as const;
const FINANCIAL_LINE_ITEMS = [
  "revenue",
  "net income",
  "net loss",
  "total assets",
  "total liabilities",
  "total equity",
  "cash and cash equivalents",
  "operating activities",
] as const;

interface ParsedCell {
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  readonly text: string;
  readonly header: boolean;
}

interface ParsedTable {
  readonly sourceTableIndex: number;
  readonly context: string;
  readonly cells: readonly ParsedCell[];
  readonly rowCount: number;
  readonly score: number;
  readonly truncated: boolean;
}

function decodeHtml(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    laquo: "«",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    mdash: "—",
    nbsp: " ",
    ndash: "–",
    quot: '"',
    raquo: "»",
    rdquo: "”",
    rsquo: "’",
  };
  return value.replaceAll(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, token: string) => {
    if (token.startsWith("#x") || token.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(token.slice(2), 16));
    }
    if (token.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(token.slice(1), 10));
    }
    return named[token.toLowerCase()] ?? entity;
  });
}

function normalizedText(value: string): string {
  return decodeHtml(value)
    .replaceAll(/<\/?(?:br|div|p|li|h[1-6])\b[^>]*>/giu, "\n")
    .replaceAll(/<[^>]*>/gu, " ")
    .replaceAll(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    .replaceAll("\u00A0", " ")
    .replaceAll(/[ \t\f\v]+/gu, " ")
    .replaceAll(/ *\n */gu, "\n")
    .replaceAll(/\n{2,}/gu, "\n")
    .trim();
}

function boundedCellText(value: string): string {
  return normalizedText(value).slice(0, FINANCIAL_TABLE_PACKET_LIMITS.maxCellCharacters);
}

function positiveSpan(attributes: string, name: "colspan" | "rowspan"): number {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']?(\\d+)`, "iu"));
  if (match?.[1] === undefined) {
    return 1;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function isNumericCell(text: string): boolean {
  const cleaned = text
    .replaceAll(/[,$€£¥₩₹₽]/gu, "")
    .replaceAll(/\s+/gu, "")
    .replace(/^\((.*)\)$/u, "$1");
  return /^[-+]?\d+(?:\.\d+)?%?$/u.test(cleaned);
}

function tableScore(context: string, cells: readonly ParsedCell[]): number {
  const leadingText = cells
    .slice(0, 180)
    .map((cell) => cell.text)
    .join(" ")
    .toLowerCase();
  const haystack = `${context} ${leadingText}`.toLowerCase();
  const statementAnchors = FINANCIAL_ANCHORS.filter((anchor) => anchor.test(haystack)).length;
  const lineItems = FINANCIAL_LINE_ITEMS.filter((anchor) => haystack.includes(anchor)).length;
  const numericRows = new Set(
    cells.filter((cell) => isNumericCell(cell.text)).map((cell) => cell.rowIndex),
  ).size;
  return statementAnchors * 20 + lineItems * 3 + Math.min(numericRows, 20);
}

function contextBefore(html: string, tableStart: number): string {
  const start = Math.max(0, tableStart - 8000);
  const lines = normalizedText(html.slice(start, tableStart))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-CONTEXT_LINES);
  return lines.join(" | ").slice(-CONTEXT_CHARACTERS);
}

function parseTable(html: string, sourceTableIndex: number, context: string): ParsedTable {
  const cells: ParsedCell[] = [];
  const rowMatches = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)];
  let truncated = rowMatches.length > FINANCIAL_TABLE_PACKET_LIMITS.maxRowsPerTable;
  for (const [rowIndex, rowMatch] of rowMatches
    .slice(0, FINANCIAL_TABLE_PACKET_LIMITS.maxRowsPerTable)
    .entries()) {
    const rowHtml = rowMatch[1] ?? "";
    let columnIndex = 0;
    for (const cellMatch of rowHtml.matchAll(/<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/giu)) {
      const attributes = cellMatch[2] ?? "";
      const columnSpan = positiveSpan(attributes, "colspan");
      const rowSpan = positiveSpan(attributes, "rowspan");
      if (columnIndex < FINANCIAL_TABLE_PACKET_LIMITS.maxColumnsPerTable) {
        const text = boundedCellText(cellMatch[3] ?? "");
        if (text !== "") {
          cells.push({
            rowIndex,
            columnIndex,
            rowSpan,
            columnSpan,
            text,
            header: cellMatch[1]?.toLowerCase() === "th",
          });
        }
      } else {
        truncated = true;
      }
      columnIndex += columnSpan;
    }
  }
  return {
    sourceTableIndex,
    context,
    cells,
    rowCount: Math.min(rowMatches.length, FINANCIAL_TABLE_PACKET_LIMITS.maxRowsPerTable),
    score: tableScore(context, cells),
    truncated,
  };
}

function headerRowIndexes(table: ParsedTable): ReadonlySet<number> {
  const explicit = new Set(table.cells.filter((cell) => cell.header).map((cell) => cell.rowIndex));
  const firstDataRow = [...new Set(table.cells.map((cell) => cell.rowIndex))]
    .toSorted((left, right) => left - right)
    .find((rowIndex) => {
      const row = table.cells.filter((cell) => cell.rowIndex === rowIndex);
      return (
        row.some((cell) => isNumericCell(cell.text)) &&
        row.some((cell) => !isNumericCell(cell.text))
      );
    });
  if (firstDataRow !== undefined) {
    for (const rowIndex of table.cells.map((cell) => cell.rowIndex)) {
      if (rowIndex < firstDataRow) {
        explicit.add(rowIndex);
      }
    }
  }
  return explicit;
}

function cellRef(tableId: string, rowIndex: number, columnIndex: number): string {
  return `${tableId}:r${String(rowIndex + 1).padStart(3, "0")}:c${String(columnIndex + 1).padStart(3, "0")}`;
}

function tableTitle(context: string): string | undefined {
  return context
    .split(" | ")
    .toReversed()
    .find((line) => FINANCIAL_ANCHORS.some((anchor) => anchor.test(line)));
}

function tableUnitText(context: string): string | undefined {
  return context
    .split(" | ")
    .toReversed()
    .find((line) =>
      /\b(?:in\s+)?(?:thousands|millions|billions)\b|\b(?:usd|eur|rmb|cny|dkk|twd)\b|u\.s\. dollars/iu.test(
        line,
      ),
    );
}

function tableUnitCell(cells: readonly FinancialTableCell[]): FinancialTableCell | undefined {
  return cells.find(
    (cell) =>
      cell.rowIndex < 8 &&
      (/\b(?:in\s+)?(?:thousands|millions|billions)\b|\b(?:usd|eur|rmb|cny|dkk|twd)\b|u\.s\. dollars/iu.test(
        cell.text,
      ) ||
        /^[€£¥$]$/u.test(cell.text)),
  );
}

function materializeTable(
  parsed: ParsedTable,
  packetIndex: number,
  source: FinancialTableSourceLocator,
): FinancialTable {
  const id = `t${String(packetIndex + 1).padStart(3, "0")}`;
  const headerRows = headerRowIndexes(parsed);
  const headerCells = parsed.cells.filter((cell) => headerRows.has(cell.rowIndex));
  const materialized = parsed.cells.map((cell): FinancialTableCell => {
    const headers = headerCells
      .filter(
        (header) =>
          header.rowIndex < cell.rowIndex &&
          header.columnIndex <= cell.columnIndex &&
          header.columnIndex + header.columnSpan > cell.columnIndex,
      )
      .map((header) => cellRef(id, header.rowIndex, header.columnIndex));
    return {
      ref: cellRef(id, cell.rowIndex, cell.columnIndex),
      tableId: id,
      rowIndex: cell.rowIndex,
      columnIndex: cell.columnIndex,
      rowSpan: cell.rowSpan,
      columnSpan: cell.columnSpan,
      text: cell.text,
      headerRefs: headers,
      source,
    };
  });
  const rows: FinancialTableRow[] = [...new Set(materialized.map((cell) => cell.rowIndex))]
    .toSorted((left, right) => left - right)
    .map((rowIndex) => ({
      rowIndex,
      cells: materialized.filter((cell) => cell.rowIndex === rowIndex),
    }));
  const title = tableTitle(parsed.context);
  const unitCell = tableUnitCell(materialized);
  const contextUnitText = tableUnitText(parsed.context);
  const unitText =
    contextUnitText === undefined
      ? unitCell?.text
      : `${contextUnitText}${unitCell === undefined ? "" : ` | ${unitCell.text}`}`;
  return {
    id,
    sourceTableIndex: parsed.sourceTableIndex,
    context: parsed.context,
    ...(title !== undefined ? { title } : {}),
    ...(unitText !== undefined ? { unitText } : {}),
    ...(unitCell !== undefined ? { unitCellRef: unitCell.ref } : {}),
    rows,
  };
}

function inheritAdjacentTableUnits(tables: readonly FinancialTable[]): readonly FinancialTable[] {
  let previous: FinancialTable | undefined = undefined;
  return tables.map((table) => {
    const inherited =
      table.unitText === undefined &&
      previous?.unitText !== undefined &&
      table.sourceTableIndex === previous.sourceTableIndex + 1
        ? {
            ...table,
            unitText: previous.unitText,
            ...(table.title === undefined && previous.title !== undefined
              ? { title: previous.title }
              : {}),
            ...(previous.unitCellRef !== undefined ? { unitCellRef: previous.unitCellRef } : {}),
            inheritedHeaderRefs: [
              ...new Set(
                previous.rows.flatMap((row) => [
                  ...row.cells.flatMap((cell) => cell.headerRefs),
                  ...(row.rowIndex < 4 ? row.cells.map((cell) => cell.ref) : []),
                ]),
              ),
            ],
          }
        : table;
    previous = inherited;
    return inherited;
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unsupportedLayoutReason(
  candidateCount: number,
  imageCount: number,
  sourceTableCount: number,
): FinancialTablePacket["unsupportedReason"] {
  if (candidateCount > 0) {
    return undefined;
  }
  if (imageCount === 0) {
    return "irreducibly-ambiguous-layout";
  }
  return sourceTableCount === 0 ? "image-only" : "html-of-image";
}

export async function buildFinancialTablePacket(
  html: string,
  source: Omit<FinancialTableSourceLocator, "sha256">,
): Promise<FinancialTablePacket> {
  const sha256 = await sha256Hex(html);
  const locatedSource: FinancialTableSourceLocator = { ...source, sha256 };
  const documentBytes = new TextEncoder().encode(html).byteLength;
  if (documentBytes > FINANCIAL_TABLE_PACKET_LIMITS.maxDocumentBytes) {
    return {
      version: 1,
      source: locatedSource,
      limits: FINANCIAL_TABLE_PACKET_LIMITS,
      sourceTableCount: 0,
      omittedTableCount: 0,
      truncated: true,
      tables: [],
      unsupportedReason: "document-too-large",
    };
  }
  if (/^\s*%PDF-/u.test(html)) {
    return {
      version: 1,
      source: locatedSource,
      limits: FINANCIAL_TABLE_PACKET_LIMITS,
      sourceTableCount: 0,
      omittedTableCount: 0,
      truncated: false,
      tables: [],
      unsupportedReason: "inaccessible-pdf",
    };
  }

  const withoutScripts = html.replaceAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ");
  const matches = [...withoutScripts.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/giu)];
  const candidates = matches
    .map((match, sourceTableIndex) =>
      parseTable(match[1] ?? "", sourceTableIndex, contextBefore(withoutScripts, match.index ?? 0)),
    )
    .filter((table) => table.score >= 12 && table.cells.length >= 6)
    .toSorted(
      (left, right) => right.score - left.score || left.sourceTableIndex - right.sourceTableIndex,
    )
    .slice(0, FINANCIAL_TABLE_PACKET_LIMITS.maxTables)
    .toSorted((left, right) => left.sourceTableIndex - right.sourceTableIndex);
  const imageCount = [...withoutScripts.matchAll(/<img\b/giu)].length;
  const unsupportedReason = unsupportedLayoutReason(candidates.length, imageCount, matches.length);
  let cellCount = 0;
  const boundedCandidates = candidates.flatMap((table) => {
    if (cellCount >= FINANCIAL_TABLE_PACKET_LIMITS.maxCells) {
      return [];
    }
    const remaining = FINANCIAL_TABLE_PACKET_LIMITS.maxCells - cellCount;
    const bounded = { ...table, cells: table.cells.slice(0, remaining) };
    cellCount += bounded.cells.length;
    return [bounded];
  });
  return {
    version: 1,
    source: locatedSource,
    limits: FINANCIAL_TABLE_PACKET_LIMITS,
    sourceTableCount: matches.length,
    omittedTableCount: Math.max(0, matches.length - boundedCandidates.length),
    truncated:
      candidates.length > boundedCandidates.length ||
      boundedCandidates.some((table) => table.truncated) ||
      candidates.some((table) => table.cells.length > FINANCIAL_TABLE_PACKET_LIMITS.maxCells),
    tables: inheritAdjacentTableUnits(
      boundedCandidates.map((table, index) => materializeTable(table, index, locatedSource)),
    ),
    ...(unsupportedReason !== undefined ? { unsupportedReason } : {}),
  };
}

export function financialTablePacketCells(
  packet: FinancialTablePacket,
): readonly FinancialTableCell[] {
  return packet.tables.flatMap((table) => table.rows.flatMap((row) => row.cells));
}
