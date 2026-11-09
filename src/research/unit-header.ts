const NUMBER_CELL = /^(\()?(-)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(\))?$/u;
export const UNIT_CELL =
  /^(?<currency>RM|MYR|USD|SGD|HKD|EUR|GBP|CNY|RMB)\s*(?:['’‘]\s*(?<scale>000|mil|million|m|bil|billion|b))?$/iu;
export const SCALE_CELL = /^['’‘]?\s*(?<scale>000|mil|million|m|bil|billion|b)$/iu;
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
export const SUBUNIT_LABEL = /\((?:subunit|sen|cents?)\)|\bsen\b/iu;
const UNIT_LIKE =
  /[$€£¥]|'\s*000\b|\b(?:RM|MYR|USD|SGD|HKD|EUR|GBP|CNY|RMB|thousands?|millions?|mil|billions?|bil|bn|mn|000)\b/iu;

export function cellNumber(text: string): number | undefined {
  const match = text.replaceAll(/\s+/gu, "").match(NUMBER_CELL);
  if (match === null || (match[1] === undefined) !== (match[5] === undefined)) {
    return undefined;
  }
  const value = Number(`${match[3] ?? ""}${match[4] ?? ""}`.replaceAll(",", ""));
  return match[1] !== undefined || match[2] !== undefined ? -value : value;
}

export function valueColumns(rows: readonly (readonly string[])[]): ReadonlySet<number> {
  return new Set(
    rows.flatMap((row) =>
      row.flatMap((cell, index) => (cellNumber(cell) === undefined ? [] : [index])),
    ),
  );
}

// Header rows above the data run that holds the row; a row of figures ends the block, so no unit crosses it.
export function columnHeaders(
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
    const isData = row.some((cell) => cellNumber(cell) !== undefined && !SCALE_CELL.test(cell));
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

export function rowLabel(row: readonly string[]): string {
  return row.find((cell) => cell !== "" && cellNumber(cell) === undefined) ?? "";
}

// A sub-item row ("- Basic", "- Owners of the Company") reads with the caption rows directly above it.
export function declaredLabel(rows: readonly (readonly string[])[], rowIndex: number): string {
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

interface ColumnUnit {
  readonly units: readonly string[];
  readonly scaleCells: readonly string[];
  readonly scales: ReadonlySet<number>;
  readonly currency: string | undefined;
  readonly unparsed: boolean;
}

export function columnUnit(headers: readonly string[]): ColumnUnit {
  const units = [...new Set(headers.filter((text) => UNIT_CELL.test(text)))];
  const groups = units[0]?.match(UNIT_CELL)?.groups;
  const scaleCells = headers.filter((text) => SCALE_CELL.test(text));
  const scales = new Set(
    [groups?.scale, ...scaleCells.map((text) => text.match(SCALE_CELL)?.groups?.scale)].flatMap(
      (token) => (token === undefined ? [] : [UNIT_SCALES[token.toLowerCase()] ?? 1]),
    ),
  );
  const currency =
    groups?.currency === undefined
      ? undefined
      : (CURRENCY_ALIASES[groups.currency.toUpperCase()] ?? groups.currency.toUpperCase());
  // A currency or scale cell the rule cannot read may contradict the one it can.
  const unparsed = headers.some(
    (text) => UNIT_LIKE.test(text) && !UNIT_CELL.test(text) && !SCALE_CELL.test(text),
  );
  return { units, scaleCells, scales, currency, unparsed };
}

const PROFIT = String.raw`(?:profit|loss|profit/\(loss\)|\(loss\)/profit|profit/loss)`;
const PERIOD = String.raw`for the (?:financial )?(?:period|year)`;
// Whole labels only: a row that adds any word (growth, margin, per share) never takes a column's unit.
const MONETARY_ROWS = [
  String.raw`(?:total )?(?:revenue|turnover)`,
  `${PROFIT} before tax(?:ation)?`,
  `${PROFIT} ${PERIOD}`,
  `${PROFIT} (?:${PERIOD} )?attributable to (?:the )?(?:owners|ordinary equity holders|equity holders|shareholders) of the (?:parent|company)`,
  String.raw`net cash (?:generated )?(?:from|used in|\(used in\)|from/\(used in\)) operating activities`,
  String.raw`(?:purchases?|acquisitions?|additions?) (?:of|to) property,? plant and equipment`,
  String.raw`cash and (?:cash equivalents|bank balances?)`,
  "total current (?:assets|liabilities)",
  "total equity",
].map((pattern) => new RegExp(`^${pattern}$`, "u"));
const PERIOD_WORD =
  /^(?:current|preceding|prior|previous|year|years|quarter|quarters|period|periods|corresponding|to|date|ytd|individual|cumulative|months?|ended|ending|as|at|end|of|the|financial|fy\d{0,4}|[qh][1-4]|half|first|second|third|fourth|three|six|nine|twelve|unaudited|audited|restated|\d{1,2}|\d{4}|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)$/iu;

function periodCell(text: string): boolean {
  return text.split(/[\s\-/.,()]+/u).every((word) => word === "" || PERIOD_WORD.test(word));
}

type Rows = readonly (readonly string[])[];

// The single label of a row whose whole label is a monetary line and whose value cells are bare numbers.
function monetaryLabelAt(row: readonly string[]): number | undefined {
  const labels = row.flatMap((cell, index) =>
    cell !== "" && cellNumber(cell) === undefined ? [index] : [],
  );
  const [at] = labels;
  const label = row[at ?? -1]?.toLowerCase().replaceAll(/\s+/gu, " ") ?? "";
  return labels.length === 1 && MONETARY_ROWS.some((pattern) => pattern.test(label))
    ? at
    : undefined;
}

// Every row crossed up to the table top is a monetary data row or a header row whose column and label cells are
// A unit, scale, period, date, or blank (blank only when every other cell is a period or date); anything else blocks.
function walkedUnit(rows: Rows, rowIndex: number, labelAt: number, column: number) {
  const cells: string[] = [];
  for (let index = rowIndex - 1; index >= 0; index -= 1) {
    const row = rows[index] ?? [];
    if (monetaryLabelAt(row) === labelAt) {
      continue;
    }
    const own = row[column];
    if (
      own === undefined ||
      (own === "" && !row.every(periodCell)) ||
      !(UNIT_CELL.test(own) || SCALE_CELL.test(own) || periodCell(own)) ||
      !periodCell(row[labelAt] ?? "")
    ) {
      return undefined;
    }
    if (own !== "") {
      cells.push(own);
    }
  }
  const { units, scaleCells, scales, currency } = columnUnit(cells);
  return cells.filter((cell) => UNIT_CELL.test(cell)).length !== 1 ||
    scales.size > 1 ||
    currency === undefined
    ? undefined
    : { headers: [...units, ...scaleCells], currency, scale: [...scales][0] ?? 1 };
}

// An amount cell in its column's unit, only on a monetary row whose every value cell is so proven.
export function headedAmountUnit(
  rows: Rows,
  rowIndex: number,
  column: number,
): ReturnType<typeof walkedUnit> {
  const row = rows[rowIndex] ?? [];
  const labelAt = monetaryLabelAt(row);
  if (labelAt === undefined || column <= labelAt) {
    return undefined;
  }
  const values = row.flatMap((cell, index) => (index > labelAt && cell !== "" ? [index] : []));
  return values.every((index) => walkedUnit(rows, rowIndex, labelAt, index) !== undefined)
    ? walkedUnit(rows, rowIndex, labelAt, column)
    : undefined;
}
