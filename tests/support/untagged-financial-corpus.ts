import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFinancialTablePacket } from "../../src/sources/extended-evidence/untagged-financial-table-packet";
import {
  parseFinancialTableMappingOutput,
  validateFinancialTableMapping,
} from "../../src/sources/extended-evidence/untagged-financial-table-validation";
import type {
  FinancialTableSemanticField,
  FinancialTableValidationIssue,
} from "../../src/sources/extended-evidence/untagged-financial-tables-contract";

export const UNTAGGED_FINANCIAL_CORPUS_DIR = join(
  import.meta.dir,
  "..",
  "fixtures",
  "untagged-financial-corpus",
);

interface CorpusCase {
  readonly id: string;
  readonly symbol: string;
  readonly accessionNumber: string;
  readonly documentName: string;
  readonly filedAt: string;
  readonly reportDate: string;
  readonly layoutFamily: string;
  readonly evaluationClass:
    | "insufficient-statement-coverage"
    | "supported-full-statement"
    | "unsupported-layout";
  readonly expectedSupport: "html-table" | "html-of-image";
  readonly url: string;
  readonly rawFile: string;
  readonly mappingFile: string;
  readonly sha256: string;
  readonly bytes: number;
}

interface CorpusManifest {
  readonly version: 1;
  readonly cases: readonly CorpusCase[];
}

interface OracleValue {
  readonly field: FinancialTableSemanticField;
  readonly displayedValue: number;
  readonly valueCellRef: string;
  readonly signCellRef?: string;
}

interface Oracle {
  readonly values: readonly OracleValue[];
}

export interface CorpusCaseEvaluation {
  readonly id: string;
  readonly symbol: string;
  readonly layoutFamily: string;
  readonly evaluationClass: CorpusCase["evaluationClass"];
  readonly outcome: "accepted" | "excluded" | "rejected" | "unsupported";
  readonly validationIssues: readonly FinancialTableValidationIssue[];
  readonly silentlyWrongValueCount: number;
  readonly sourceCellMismatchCount: number;
  readonly unsupportedReason?: string;
}

export interface UntaggedFinancialCorpusEvaluation {
  readonly version: 1;
  readonly evaluatedAt: string;
  readonly caseCount: number;
  readonly layoutFamilies: readonly string[];
  readonly supportedFullStatementCount: number;
  readonly acceptedFullStatementCount: number;
  readonly acceptanceRate: number;
  readonly insufficientCoverageCount: number;
  readonly unsupportedLayoutCount: number;
  readonly silentlyWrongValueCount: number;
  readonly sourceCellMismatchCount: number;
  readonly passed: boolean;
  readonly cases: readonly CorpusCaseEvaluation[];
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function rawSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function evaluateUntaggedFinancialCorpus(
  corpusDir = UNTAGGED_FINANCIAL_CORPUS_DIR,
): Promise<UntaggedFinancialCorpusEvaluation> {
  const manifest = await readJson<CorpusManifest>(join(corpusDir, "manifest.json"));
  const evaluations: CorpusCaseEvaluation[] = [];
  for (const item of manifest.cases) {
    // Corpus evaluation stays sequential so failures remain attributable to one exhibit.
    // eslint-disable-next-line no-await-in-loop
    const html = await readFile(join(corpusDir, item.rawFile), "utf8");
    if (Buffer.byteLength(html) !== item.bytes || rawSha256(html) !== item.sha256) {
      throw new Error(`Corpus integrity mismatch: ${item.id}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const packet = await buildFinancialTablePacket(html, {
      url: item.url,
      accessionNumber: item.accessionNumber,
      documentName: item.documentName,
      filedAt: item.filedAt,
      form: "6-K",
    });
    if (item.evaluationClass === "unsupported-layout") {
      evaluations.push({
        id: item.id,
        symbol: item.symbol,
        layoutFamily: item.layoutFamily,
        evaluationClass: item.evaluationClass,
        outcome: "unsupported",
        validationIssues: [],
        silentlyWrongValueCount: 0,
        sourceCellMismatchCount: 0,
        ...(packet.unsupportedReason !== undefined
          ? { unsupportedReason: packet.unsupportedReason }
          : {}),
      });
      continue;
    }
    if (item.evaluationClass === "insufficient-statement-coverage") {
      evaluations.push({
        id: item.id,
        symbol: item.symbol,
        layoutFamily: item.layoutFamily,
        evaluationClass: item.evaluationClass,
        outcome: "excluded",
        validationIssues: [],
        silentlyWrongValueCount: 0,
        sourceCellMismatchCount: 0,
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const mappingContent = await readFile(join(corpusDir, item.mappingFile), "utf8");
    const parsed = parseFinancialTableMappingOutput(mappingContent);
    if (!("mapping" in parsed)) {
      throw new Error(`Invalid corpus mapping cassette: ${item.id}`);
    }
    const validation = validateFinancialTableMapping({
      packet,
      mapping: parsed.mapping,
      filingReportDate: item.reportDate,
    });
    // eslint-disable-next-line no-await-in-loop
    const oracle = await readJson<Oracle>(join(corpusDir, "oracles", `${item.id}.json`));
    const oracleByField = new Map(oracle.values.map((value) => [value.field, value]));
    let silentlyWrongValueCount = 0;
    let sourceCellMismatchCount = 0;
    for (const value of validation.values) {
      const expected = oracleByField.get(value.field);
      if (expected === undefined || expected.displayedValue !== value.displayedValue) {
        silentlyWrongValueCount += 1;
      }
      if (
        expected === undefined ||
        expected.valueCellRef !== value.trace.valueCellRef ||
        expected.signCellRef !== value.trace.signCellRef ||
        value.trace.packetSha256 !== item.sha256 ||
        value.trace.sourceUrl !== item.url
      ) {
        sourceCellMismatchCount += 1;
      }
    }
    const accepted =
      validation.status === "accepted" &&
      validation.values.length === oracle.values.length &&
      silentlyWrongValueCount === 0 &&
      sourceCellMismatchCount === 0;
    evaluations.push({
      id: item.id,
      symbol: item.symbol,
      layoutFamily: item.layoutFamily,
      evaluationClass: item.evaluationClass,
      outcome: accepted ? "accepted" : "rejected",
      validationIssues: validation.issues,
      silentlyWrongValueCount,
      sourceCellMismatchCount,
    });
  }
  const supported = evaluations.filter(
    (item) => item.evaluationClass === "supported-full-statement",
  );
  const accepted = supported.filter((item) => item.outcome === "accepted");
  const silentlyWrongValueCount = evaluations.reduce(
    (sum, item) => sum + item.silentlyWrongValueCount,
    0,
  );
  const sourceCellMismatchCount = evaluations.reduce(
    (sum, item) => sum + item.sourceCellMismatchCount,
    0,
  );
  const layoutFamilies = [...new Set(evaluations.map((item) => item.layoutFamily))].toSorted();
  const acceptanceRate = supported.length === 0 ? 0 : accepted.length / supported.length;
  const passed =
    evaluations.length >= 10 &&
    layoutFamilies.length >= 3 &&
    acceptanceRate >= 0.7 &&
    silentlyWrongValueCount === 0 &&
    sourceCellMismatchCount === 0;
  return {
    version: 1,
    evaluatedAt: "2026-07-23T00:00:00.000Z",
    caseCount: evaluations.length,
    layoutFamilies,
    supportedFullStatementCount: supported.length,
    acceptedFullStatementCount: accepted.length,
    acceptanceRate,
    insufficientCoverageCount: evaluations.filter(
      (item) => item.evaluationClass === "insufficient-statement-coverage",
    ).length,
    unsupportedLayoutCount: evaluations.filter(
      (item) => item.evaluationClass === "unsupported-layout",
    ).length,
    silentlyWrongValueCount,
    sourceCellMismatchCount,
    passed,
    cases: evaluations,
  };
}
