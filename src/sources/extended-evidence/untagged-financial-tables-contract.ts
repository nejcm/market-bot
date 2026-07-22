import type {
  FinancialStatementName,
  FinancialStatementSeriesKey,
  SupportedSecForm,
} from "./financial-statements-contract";

export type FinancialTableUnsupportedReason =
  | "document-too-large"
  | "image-only"
  | "html-of-image"
  | "inaccessible-pdf"
  | "irreducibly-ambiguous-layout";

export interface FinancialTableSourceLocator {
  readonly url: string;
  readonly accessionNumber: string;
  readonly documentName: string;
  readonly filedAt: string;
  readonly form: Extract<SupportedSecForm, "6-K" | "6-K/A">;
  readonly sha256: string;
}

export interface FinancialTableCell {
  readonly ref: string;
  readonly tableId: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly rowSpan: number;
  readonly columnSpan: number;
  readonly text: string;
  readonly headerRefs: readonly string[];
  readonly source: FinancialTableSourceLocator;
}

export interface FinancialTableRow {
  readonly rowIndex: number;
  readonly cells: readonly FinancialTableCell[];
}

export interface FinancialTable {
  readonly id: string;
  readonly sourceTableIndex: number;
  readonly context: string;
  readonly title?: string;
  readonly unitText?: string;
  readonly unitCellRef?: string;
  readonly inheritedHeaderRefs?: readonly string[];
  readonly rows: readonly FinancialTableRow[];
}

export interface FinancialTablePacketLimits {
  readonly maxDocumentBytes: number;
  readonly maxTables: number;
  readonly maxRowsPerTable: number;
  readonly maxColumnsPerTable: number;
  readonly maxCells: number;
  readonly maxCellCharacters: number;
}

export interface FinancialTablePacket {
  readonly version: 1;
  readonly source: FinancialTableSourceLocator;
  readonly limits: FinancialTablePacketLimits;
  readonly sourceTableCount: number;
  readonly omittedTableCount: number;
  readonly truncated: boolean;
  readonly tables: readonly FinancialTable[];
  readonly unsupportedReason?: FinancialTableUnsupportedReason;
}

export type FinancialTableValidationField =
  | "cashBeginning"
  | "cashEnding"
  | "netCashChange"
  | "investingCashFlow"
  | "financingCashFlow"
  | "foreignExchangeEffect";

export type FinancialTableSemanticField =
  | FinancialStatementSeriesKey
  | FinancialTableValidationField;

export interface FinancialTableCellMapping {
  readonly field: FinancialTableSemanticField;
  readonly labelCellRef: string;
  readonly valueCellRef: string;
  readonly signCellRef?: string;
  readonly periodHeaderCellRefs: readonly string[];
}

export interface FinancialTableMappingOutput {
  readonly version: 1;
  readonly mappings: readonly FinancialTableCellMapping[];
}

export type FinancialTableValidationCode =
  | "unsupported-source-layout"
  | "invalid-model-output"
  | "missing-cell-reference"
  | "cross-table-reference"
  | "label-mismatch"
  | "invalid-number"
  | "invalid-period-header"
  | "unexpected-period"
  | "unsupported-currency"
  | "mixed-currency"
  | "unsupported-unit-scale"
  | "ambiguous-sign"
  | "duplicate-field-period"
  | "duplicate-value-cell"
  | "incomplete-income-statement"
  | "incomplete-balance-sheet"
  | "incomplete-cash-flow-statement"
  | "balance-sheet-identity-failed"
  | "cash-flow-identity-failed";

export interface FinancialTableValidationIssue {
  readonly code: FinancialTableValidationCode;
  readonly message: string;
  readonly field?: FinancialTableSemanticField;
  readonly cellRef?: string;
  readonly periodEnd?: string;
}

export interface FinancialTableCellTrace {
  readonly sourceUrl: string;
  readonly accessionNumber: string;
  readonly documentName: string;
  readonly packetSha256: string;
  readonly tableId: string;
  readonly rowIndex: number;
  readonly columnIndex: number;
  readonly labelCellRef: string;
  readonly valueCellRef: string;
  readonly signCellRef?: string;
  readonly periodHeaderCellRefs: readonly string[];
  readonly unitText: string;
  readonly unitCellRef?: string;
}

export interface ValidatedFinancialTableValue {
  readonly field: FinancialTableSemanticField;
  readonly statement: FinancialStatementName | "cashFlowValidation";
  readonly value: number;
  readonly displayedValue: number;
  readonly periodStart?: string;
  readonly periodEnd: string;
  readonly fiscalPeriod: string;
  readonly currency: string | null;
  readonly unit: string;
  readonly unitScale: number;
  readonly extractionMethod: "model-validated-table";
  readonly trace: FinancialTableCellTrace;
}

export interface FinancialTableValidationResult {
  readonly status: "accepted" | "partial" | "rejected";
  readonly values: readonly ValidatedFinancialTableValue[];
  readonly issues: readonly FinancialTableValidationIssue[];
  readonly acceptedStatements: readonly FinancialStatementName[];
}

export interface UntaggedFinancialStatementsArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly symbol: string;
  readonly filing: FinancialTableSourceLocator;
  readonly packet: FinancialTablePacket;
  readonly mapping: FinancialTableMappingOutput | null;
  readonly validation: FinancialTableValidationResult;
  readonly completenessGate: {
    readonly passed: boolean;
    readonly corpusVersion: number;
    readonly evaluatedAt: string;
    readonly reason: string;
  };
}
