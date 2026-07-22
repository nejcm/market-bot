import { isRecord, readString } from "../../guards";
import type { FinancialStatementName } from "./financial-statements-contract";
import { financialTablePacketCells } from "./untagged-financial-table-packet";
import type {
  FinancialTable,
  FinancialTableCell,
  FinancialTableCellMapping,
  FinancialTableMappingOutput,
  FinancialTablePacket,
  FinancialTableSemanticField,
  FinancialTableValidationIssue,
  FinancialTableValidationResult,
  ValidatedFinancialTableValue,
} from "./untagged-financial-tables-contract";

const MAPPING_KEYS = ["field", "labelCellRef", "valueCellRef", "periodHeaderCellRefs"] as const;
const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};
const FIELD_ALIASES: Readonly<Record<FinancialTableSemanticField, readonly RegExp[]>> = {
  revenue: [/\brevenue(?:s)?\b/iu, /\bnet sales\b/iu, /\bturnover\b/iu],
  grossProfit: [/\bgross profit\b/iu],
  operatingIncome: [
    /\b(?:income|loss|profit) from operations\b/iu,
    /\boperating (?:income|loss|profit)\b/iu,
  ],
  netIncome: [/\bnet (?:income|loss|profit)\b/iu, /\bprofit for the period\b/iu],
  cash: [/\bcash and cash equivalents\b/iu, /\bcash equivalents and short[- ]term deposits\b/iu],
  currentAssets: [/\btotal current assets\b/iu],
  currentLiabilities: [/\btotal current liabilities\b/iu],
  totalAssets: [/\btotal assets\b/iu],
  totalLiabilities: [/\btotal liabilities\b(?!.*equity)/iu],
  stockholdersEquity: [
    /\btotal (?:shareholders[’']?|stockholders[’']?) equity\b/iu,
    /\btotal equity\b/iu,
  ],
  debt: [/\btotal debt\b/iu, /\bborrowings\b/iu],
  operatingCashFlow: [
    /\bnet cash (?:provided by|from|used in) operating activities\b/iu,
    /\bcash flows? from operating activities\b/iu,
  ],
  capitalExpenditure: [/\bcapital expenditures?\b/iu, /\bpurchases? of property.*equipment\b/iu],
  dividendsPaid: [/\bdividends? paid\b/iu],
  shareRepurchases: [/\brepurchase(?:s|d)? of .*shares\b/iu, /\bshare repurchases?\b/iu],
  dilutedEps: [/\bdiluted .* (?:earnings|loss|profit).*per share\b/iu, /\bdiluted eps\b/iu],
  dilutedShares: [/\bweighted average .* diluted .*shares\b/iu],
  cashBeginning: [/\bcash and cash equivalents.*beginning/iu, /\bcash.*at beginning/iu],
  cashEnding: [/\bcash and cash equivalents.*end/iu, /\bcash.*at end/iu],
  netCashChange: [
    /\bnet (?:increase|decrease|change) in cash(?: and cash equivalents)?\b/iu,
    /\bchange in cash and cash equivalents\b/iu,
  ],
  investingCashFlow: [
    /\bnet cash (?:provided by|from|used in) investing activities\b/iu,
    /\bcash flows? from investing activities\b/iu,
  ],
  financingCashFlow: [
    /\bnet cash (?:provided by|from|used in) financing activities\b/iu,
    /\bcash flows? from financing activities\b/iu,
  ],
  foreignExchangeEffect: [
    /\beffect of (?:exchange rate|foreign exchange).*cash/iu,
    /\bexchange rate changes.*cash/iu,
  ],
};
const SEMANTIC_FIELDS = new Set(Object.keys(FIELD_ALIASES));
const VALIDATION_FIELDS = new Set<FinancialTableSemanticField>([
  "cashBeginning",
  "cashEnding",
  "netCashChange",
  "investingCashFlow",
  "financingCashFlow",
  "foreignExchangeEffect",
]);

export interface ValidateFinancialTableMappingInput {
  readonly packet: FinancialTablePacket;
  readonly mapping: FinancialTableMappingOutput;
  readonly filingReportDate: string;
  readonly expectedCurrency?: string;
}

interface ParsedPeriod {
  readonly periodStart?: string;
  readonly periodEnd: string;
  readonly fiscalPeriod: string;
}

interface ParsedUnit {
  readonly currency: string | null;
  readonly unit: string;
  readonly unitScale: number;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).toSorted().join("|") === keys.toSorted().join("|");
}

function mappingEntry(value: unknown): FinancialTableCellMapping | undefined {
  if (!isRecord(value) || !exactKeys(value, MAPPING_KEYS)) {
    return undefined;
  }
  const field = readString(value, "field");
  const labelCellRef = readString(value, "labelCellRef");
  const valueCellRef = readString(value, "valueCellRef");
  const headers = value.periodHeaderCellRefs;
  if (
    field === undefined ||
    !SEMANTIC_FIELDS.has(field) ||
    labelCellRef === undefined ||
    valueCellRef === undefined ||
    !Array.isArray(headers) ||
    headers.length === 0 ||
    !headers.every((item) => typeof item === "string" && item !== "")
  ) {
    return undefined;
  }
  return {
    field: field as FinancialTableSemanticField,
    labelCellRef,
    valueCellRef,
    periodHeaderCellRefs: headers,
  };
}

export function parseFinancialTableMappingOutput(
  content: string,
):
  | { readonly mapping: FinancialTableMappingOutput }
  | { readonly issue: FinancialTableValidationIssue } {
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      issue: { code: "invalid-model-output", message: "mapping output is not valid JSON" },
    };
  }
  if (
    !isRecord(parsed) ||
    !exactKeys(parsed, ["version", "mappings"]) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.mappings)
  ) {
    return {
      issue: {
        code: "invalid-model-output",
        message: "mapping output must contain only version 1 and mappings",
      },
    };
  }
  const mappings = parsed.mappings.map(mappingEntry);
  if (mappings.some((entry) => entry === undefined)) {
    return {
      issue: {
        code: "invalid-model-output",
        message: "mapping entries must contain only field and existing-cell reference properties",
      },
    };
  }
  return { mapping: { version: 1, mappings: mappings as FinancialTableCellMapping[] } };
}

function tableForCell(packet: FinancialTablePacket, cell: FinancialTableCell): FinancialTable {
  return packet.tables.find((table) => table.id === cell.tableId)!;
}

function isoDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

function monthsInHeader(value: string): number | undefined {
  const match = value.match(/\b(three|six|nine|twelve|[369]|12)\s+months?\b/iu);
  if (match?.[1] === undefined) {
    return /\bquarter(?:ly)?\b/iu.test(value) ? 3 : undefined;
  }
  return (
    { three: 3, six: 6, nine: 9, twelve: 12 }[match[1].toLowerCase()] ??
    Number.parseInt(match[1], 10)
  );
}

function subtractMonths(periodEnd: string, months: number): string {
  const [year, month, day] = periodEnd.split("-").map(Number) as [number, number, number];
  const start = new Date(Date.UTC(year, month - 1 - months, day + 1));
  return start.toISOString().slice(0, 10);
}

function periodEndFor(
  year: number,
  month: number | undefined,
  day: number | undefined,
  explicitYear: number,
  filingReportDate: string,
): string | undefined {
  if (month !== undefined && day !== undefined) {
    return isoDate(explicitYear, month, day);
  }
  return filingReportDate.startsWith(`${String(year)}-`)
    ? filingReportDate
    : `${String(year)}-${filingReportDate.slice(5)}`;
}

function fiscalPeriodFor(durationMonths: number): string {
  if (durationMonths === 3) {
    return "Q";
  }
  if (durationMonths === 6) {
    return "H1";
  }
  return durationMonths === 9 ? "9M" : "FY";
}

function parsePeriod(
  headerText: string,
  tableContext: string,
  filingReportDate: string,
): ParsedPeriod | undefined {
  const combined = `${tableContext} | ${headerText}`;
  const years = [...headerText.matchAll(/\b(20\d{2})\b/gu)].map((match) => Number(match[1]));
  const year = years.length === 1 ? years[0] : undefined;
  if (year === undefined) {
    return undefined;
  }
  const monthDayMatch = combined.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(20\d{2}))?/iu,
  );
  const month =
    monthDayMatch?.[1] === undefined ? undefined : MONTHS[monthDayMatch[1].toLowerCase()];
  const day = monthDayMatch?.[2] === undefined ? undefined : Number.parseInt(monthDayMatch[2], 10);
  const explicitYear = monthDayMatch?.[3] === undefined ? year : Number(monthDayMatch[3]);
  const periodEnd = periodEndFor(year, month, day, explicitYear, filingReportDate);
  if (periodEnd === undefined) {
    return undefined;
  }
  const instant = /\bas of\b|balance sheets?|financial position/iu.test(combined);
  if (instant) {
    return { periodEnd, fiscalPeriod: "instant" };
  }
  const durationMonths = monthsInHeader(combined);
  if (durationMonths === undefined) {
    return undefined;
  }
  return {
    periodStart: subtractMonths(periodEnd, durationMonths),
    periodEnd,
    fiscalPeriod: fiscalPeriodFor(durationMonths),
  };
}

function parseNumber(
  text: string,
): { readonly value: number } | { readonly issue: "invalid-number" | "ambiguous-sign" } {
  const normalized = text.replaceAll(/\s+/gu, "").replaceAll(/[,$€£¥₩₹₽]/gu, "");
  const parentheses = /^\(.*\)$/u.test(normalized);
  const unwrapped = parentheses ? normalized.slice(1, -1) : normalized;
  if (unwrapped.endsWith("-") || (parentheses && unwrapped.startsWith("-"))) {
    return { issue: "ambiguous-sign" };
  }
  if (!/^[-+]?\d+(?:\.\d+)?$/u.test(unwrapped)) {
    return { issue: "invalid-number" };
  }
  const parsed = Number(unwrapped);
  if (!Number.isFinite(parsed)) {
    return { issue: "invalid-number" };
  }
  return { value: parentheses ? -parsed : parsed };
}

function currencyFromText(value: string): string | undefined {
  const patterns: readonly [string, RegExp][] = [
    ["USD", /\bUSD\b|U\.S\. dollars?|US dollars?|\$/iu],
    ["EUR", /\bEUR\b|euros?|€/iu],
    ["CNY", /\bCNY\b|\bRMB\b|renminbi|yuan|¥/iu],
    ["DKK", /\bDKK\b|Danish kroner?/iu],
    ["TWD", /\bTWD\b|NT\$/iu],
    ["GBP", /\bGBP\b|pounds? sterling|£/iu],
  ];
  return patterns.find(([, pattern]) => pattern.test(value))?.[0];
}

function unitFor(
  field: FinancialTableSemanticField,
  table: FinancialTable,
): ParsedUnit | undefined {
  const unitText = table.unitText ?? table.context;
  const currency = currencyFromText(unitText);
  const monetary = !["dilutedEps", "dilutedShares"].includes(field);
  if (monetary && currency === undefined) {
    return undefined;
  }
  let scale = 1;
  if (/\bbillions?\b/iu.test(unitText)) {
    scale = 1_000_000_000;
  } else if (/\bmillions?\b/iu.test(unitText)) {
    scale = 1_000_000;
  } else if (/\bthousands?\b/iu.test(unitText)) {
    scale = 1000;
  }
  if (field === "dilutedEps") {
    return { currency: currency ?? null, unit: `${currency ?? "currency"}/shares`, unitScale: 1 };
  }
  if (field === "dilutedShares") {
    const sharesUnscaled =
      /except (?:share|shares|share and per share|share and per-share) data/iu.test(unitText);
    return { currency: null, unit: "shares", unitScale: sharesUnscaled ? 1 : scale };
  }
  return { currency: currency!, unit: currency!, unitScale: scale };
}

function statementFor(
  field: FinancialTableSemanticField,
): FinancialStatementName | "cashFlowValidation" {
  if (VALIDATION_FIELDS.has(field)) {
    return "cashFlowValidation";
  }
  if (["revenue", "grossProfit", "operatingIncome", "netIncome"].includes(field)) {
    return "incomeStatement";
  }
  if (
    ["operatingCashFlow", "capitalExpenditure", "dividendsPaid", "shareRepurchases"].includes(field)
  ) {
    return "cashFlowStatement";
  }
  if (["dilutedEps", "dilutedShares"].includes(field)) {
    return "perShare";
  }
  return "balanceSheet";
}

function issue(
  code: FinancialTableValidationIssue["code"],
  message: string,
  mapping?: FinancialTableCellMapping,
  periodEnd?: string,
): FinancialTableValidationIssue {
  return {
    code,
    message,
    ...(mapping !== undefined ? { field: mapping.field, cellRef: mapping.valueCellRef } : {}),
    ...(periodEnd !== undefined ? { periodEnd } : {}),
  };
}

function identityTolerance(values: readonly ValidatedFinancialTableValue[]): number {
  const scale = Math.max(...values.map((value) => value.unitScale));
  const magnitude = Math.max(...values.map((value) => Math.abs(value.value)));
  return Math.max(scale, magnitude * 0.001);
}

function valueFor(
  values: readonly ValidatedFinancialTableValue[],
  field: FinancialTableSemanticField,
  periodEnd: string,
): ValidatedFinancialTableValue | undefined {
  return values.find((value) => value.field === field && value.periodEnd === periodEnd);
}

function validateIdentities(values: readonly ValidatedFinancialTableValue[]): {
  readonly values: readonly ValidatedFinancialTableValue[];
  readonly issues: readonly FinancialTableValidationIssue[];
} {
  const rejected = new Set<ValidatedFinancialTableValue>();
  const issues: FinancialTableValidationIssue[] = [];
  const periodEnds = [...new Set(values.map((value) => value.periodEnd))];
  for (const periodEnd of periodEnds) {
    const assets = valueFor(values, "totalAssets", periodEnd);
    const liabilities = valueFor(values, "totalLiabilities", periodEnd);
    const equity = valueFor(values, "stockholdersEquity", periodEnd);
    if (assets !== undefined && liabilities !== undefined && equity !== undefined) {
      const identityValues = [assets, liabilities, equity];
      if (
        Math.abs(assets.value - liabilities.value - equity.value) >
        identityTolerance(identityValues)
      ) {
        values
          .filter((value) => value.periodEnd === periodEnd && value.statement === "balanceSheet")
          .forEach((value) => rejected.add(value));
        issues.push(
          issue(
            "balance-sheet-identity-failed",
            `assets do not equal liabilities plus equity for ${periodEnd}`,
            undefined,
            periodEnd,
          ),
        );
      }
    }
    const beginning = valueFor(values, "cashBeginning", periodEnd);
    const ending = valueFor(values, "cashEnding", periodEnd);
    const change = valueFor(values, "netCashChange", periodEnd);
    if (beginning !== undefined && ending !== undefined && change !== undefined) {
      const identityValues = [beginning, ending, change];
      if (
        Math.abs(beginning.value + change.value - ending.value) > identityTolerance(identityValues)
      ) {
        values
          .filter(
            (value) =>
              value.periodEnd === periodEnd &&
              (value.statement === "cashFlowStatement" || value.statement === "cashFlowValidation"),
          )
          .forEach((value) => rejected.add(value));
        issues.push(
          issue(
            "cash-flow-identity-failed",
            `beginning cash plus net change does not equal ending cash for ${periodEnd}`,
            undefined,
            periodEnd,
          ),
        );
      }
    }
    const operating = valueFor(values, "operatingCashFlow", periodEnd);
    const investing = valueFor(values, "investingCashFlow", periodEnd);
    const financing = valueFor(values, "financingCashFlow", periodEnd);
    const fx = valueFor(values, "foreignExchangeEffect", periodEnd);
    if ([operating, investing, financing, fx, change].every((value) => value !== undefined)) {
      const identityValues = [operating!, investing!, financing!, fx!, change!];
      const components = operating!.value + investing!.value + financing!.value + fx!.value;
      if (Math.abs(components - change!.value) > identityTolerance(identityValues)) {
        identityValues.forEach((value) => rejected.add(value));
        issues.push(
          issue(
            "cash-flow-identity-failed",
            `operating, investing, financing, and exchange effects do not reconcile to net cash change for ${periodEnd}`,
            undefined,
            periodEnd,
          ),
        );
      }
    }
  }
  return { values: values.filter((value) => !rejected.has(value)), issues };
}

function fieldsAt(
  values: readonly ValidatedFinancialTableValue[],
  periodEnd: string,
): ReadonlySet<FinancialTableSemanticField> {
  return new Set(
    values.filter((value) => value.periodEnd === periodEnd).map((value) => value.field),
  );
}

function hasAll(
  fields: ReadonlySet<FinancialTableSemanticField>,
  required: readonly FinancialTableSemanticField[],
): boolean {
  return required.every((field) => fields.has(field));
}

function statementCompleteness(
  values: readonly ValidatedFinancialTableValue[],
  reportDate: string,
): {
  readonly accepted: readonly FinancialStatementName[];
  readonly issues: readonly FinancialTableValidationIssue[];
} {
  const current = fieldsAt(values, reportDate);
  const accepted: FinancialStatementName[] = [];
  const issues: FinancialTableValidationIssue[] = [];
  if (hasAll(current, ["revenue", "operatingIncome", "netIncome"])) {
    accepted.push("incomeStatement");
  } else {
    issues.push(
      issue(
        "incomplete-income-statement",
        `current income statement is incomplete for ${reportDate}`,
      ),
    );
  }
  if (hasAll(current, ["cash", "totalAssets", "totalLiabilities", "stockholdersEquity"])) {
    accepted.push("balanceSheet");
  } else {
    issues.push(
      issue("incomplete-balance-sheet", `current balance sheet is incomplete for ${reportDate}`),
    );
  }
  if (hasAll(current, ["operatingCashFlow", "cashBeginning", "cashEnding", "netCashChange"])) {
    accepted.push("cashFlowStatement");
  } else {
    issues.push(
      issue(
        "incomplete-cash-flow-statement",
        `current cash-flow statement is incomplete for ${reportDate}`,
      ),
    );
  }
  if (current.has("dilutedEps")) {
    accepted.push("perShare");
  }
  return { accepted, issues };
}

export function validateFinancialTableMapping(
  input: ValidateFinancialTableMappingInput,
): FinancialTableValidationResult {
  const cellByRef = new Map(
    financialTablePacketCells(input.packet).map((cell) => [cell.ref, cell]),
  );
  const issues: FinancialTableValidationIssue[] = [];
  const values: ValidatedFinancialTableValue[] = [];
  const fieldPeriods = new Set<string>();
  const usedValueCells = new Set<string>();
  const reportDate = new Date(`${input.filingReportDate}T00:00:00Z`);
  const earliestAllowed = new Date(reportDate);
  earliestAllowed.setUTCMonth(earliestAllowed.getUTCMonth() - 18);

  for (const mapping of input.mapping.mappings) {
    const labelCell = cellByRef.get(mapping.labelCellRef);
    const valueCell = cellByRef.get(mapping.valueCellRef);
    const headerCells = mapping.periodHeaderCellRefs.map((ref) => cellByRef.get(ref));
    if (
      labelCell === undefined ||
      valueCell === undefined ||
      headerCells.some((cell) => cell === undefined)
    ) {
      issues.push(
        issue("missing-cell-reference", "one or more mapped cell references do not exist", mapping),
      );
      continue;
    }
    const cells = [labelCell, valueCell, ...(headerCells as FinancialTableCell[])];
    if (cells.some((cell) => cell.tableId !== valueCell.tableId)) {
      issues.push(
        issue(
          "cross-table-reference",
          "mapped label, value, and headers must share one table",
          mapping,
        ),
      );
      continue;
    }
    if (!FIELD_ALIASES[mapping.field].some((pattern) => pattern.test(labelCell.text))) {
      issues.push(
        issue("label-mismatch", `label does not support semantic field ${mapping.field}`, mapping),
      );
      continue;
    }
    const number = parseNumber(valueCell.text);
    if ("issue" in number) {
      issues.push(
        issue(number.issue, `value cell is not an unambiguous numeric disclosure`, mapping),
      );
      continue;
    }
    const table = tableForCell(input.packet, valueCell);
    const period = parsePeriod(
      (headerCells as FinancialTableCell[]).map((cell) => cell.text).join(" | "),
      table.context,
      input.filingReportDate,
    );
    if (period === undefined) {
      issues.push(
        issue("invalid-period-header", "period headers do not resolve deterministically", mapping),
      );
      continue;
    }
    const periodDate = new Date(`${period.periodEnd}T00:00:00Z`);
    if (periodDate > reportDate || periodDate < earliestAllowed) {
      issues.push(
        issue(
          "unexpected-period",
          `period ${period.periodEnd} is outside the filing window`,
          mapping,
          period.periodEnd,
        ),
      );
      continue;
    }
    const unit = unitFor(mapping.field, table);
    if (unit === undefined) {
      issues.push(
        issue(
          "unsupported-currency",
          "table currency could not be resolved",
          mapping,
          period.periodEnd,
        ),
      );
      continue;
    }
    if (
      input.expectedCurrency !== undefined &&
      unit.currency !== null &&
      unit.currency !== input.expectedCurrency
    ) {
      issues.push(
        issue(
          "mixed-currency",
          `table currency ${unit.currency} differs from ${input.expectedCurrency}`,
          mapping,
          period.periodEnd,
        ),
      );
      continue;
    }
    const duplicateKey = `${mapping.field}|${period.periodEnd}`;
    if (fieldPeriods.has(duplicateKey)) {
      issues.push(
        issue(
          "duplicate-field-period",
          `duplicate mapping for ${duplicateKey}`,
          mapping,
          period.periodEnd,
        ),
      );
      continue;
    }
    if (usedValueCells.has(mapping.valueCellRef)) {
      issues.push(
        issue(
          "duplicate-value-cell",
          "one source value cell maps to multiple facts",
          mapping,
          period.periodEnd,
        ),
      );
      continue;
    }
    fieldPeriods.add(duplicateKey);
    usedValueCells.add(mapping.valueCellRef);
    values.push({
      field: mapping.field,
      statement: statementFor(mapping.field),
      value: number.value * unit.unitScale,
      displayedValue: number.value,
      ...(period.periodStart !== undefined ? { periodStart: period.periodStart } : {}),
      periodEnd: period.periodEnd,
      fiscalPeriod: period.fiscalPeriod,
      currency: unit.currency,
      unit: unit.unit,
      unitScale: unit.unitScale,
      extractionMethod: "model-validated-table",
      trace: {
        sourceUrl: input.packet.source.url,
        accessionNumber: input.packet.source.accessionNumber,
        documentName: input.packet.source.documentName,
        packetSha256: input.packet.source.sha256,
        tableId: valueCell.tableId,
        rowIndex: valueCell.rowIndex,
        columnIndex: valueCell.columnIndex,
        labelCellRef: mapping.labelCellRef,
        valueCellRef: mapping.valueCellRef,
        periodHeaderCellRefs: mapping.periodHeaderCellRefs,
        unitText: table.unitText ?? table.context,
      },
    });
  }

  const identities = validateIdentities(values);
  issues.push(...identities.issues);
  const completeness = statementCompleteness(identities.values, input.filingReportDate);
  issues.push(...completeness.issues);
  const coreStatements = completeness.accepted.filter((statement) => statement !== "perShare");
  let status: FinancialTableValidationResult["status"] = "rejected";
  if (coreStatements.length === 3 && issues.length === 0) {
    status = "accepted";
  } else if (identities.values.length > 0) {
    status = "partial";
  }
  return {
    status,
    values: identities.values,
    issues,
    acceptedStatements: completeness.accepted,
  };
}
