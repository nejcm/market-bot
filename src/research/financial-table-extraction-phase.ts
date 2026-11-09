import type { ResearchCommand } from "../cli/args";
import type { AppConfig } from "../config";
import type { ResolvedRunParams } from "../config/runs";
import type { SourceGap } from "../domain/sources";
import type { ModelProvider } from "../model/types";
import { withUntrustedModelInputRule } from "../model/trust-guard";
import { sourceGap } from "../domain/source-gaps";
import type { StageOutput } from "./final-synthesis";
import {
  collectUntaggedFinancialExhibit,
  type CollectUntaggedFinancialExhibitInput,
} from "../sources/extended-evidence/untagged-financial-exhibit";
import {
  UNTAGGED_FINANCIAL_EXTRACTOR_EVALUATION,
  UNTAGGED_FINANCIAL_PRODUCTION_EXECUTION_POLICY,
} from "../sources/extended-evidence/untagged-financial-extraction-policy";
import {
  FINANCIAL_TABLE_SEMANTIC_FIELDS,
  parseFinancialTableMappingOutput,
  validateFinancialTableMapping,
} from "../sources/extended-evidence/untagged-financial-table-validation";
import type {
  FinancialTableMappingOutput,
  FinancialTablePacket,
  FinancialTableValidationIssue,
  FinancialTableValidationResult,
  UntaggedFinancialExtractionExecutionPolicy,
  UntaggedFinancialStatementsArtifact,
} from "../sources/extended-evidence/untagged-financial-tables-contract";
import type { CollectedSources } from "../sources/types";
import { loadStagePrompt } from "./prompt-loader";

export interface FinancialTableExtractionPhaseInput {
  readonly symbol: string;
  readonly generatedAt: string;
  readonly collectedSources: CollectedSources;
  readonly executionPolicy?: UntaggedFinancialExtractionExecutionPolicy;
  readonly collect: Omit<
    CollectUntaggedFinancialExhibitInput,
    "symbol" | "fetchedAt" | "rawSnapshots" | "financialStatements" | "resultsCoverAccessions"
  >;
  readonly generateMapping: (
    packet: FinancialTablePacket,
    filingReportDate: string,
  ) => Promise<StageOutput & { readonly stage: "financial-table-mapping" }>;
}

export interface FinancialTableExtractionPhaseResult {
  readonly collectedSources: CollectedSources;
  readonly stageOutputs: readonly StageOutput[];
}

function validationFromIssue(issue: FinancialTableValidationIssue): FinancialTableValidationResult {
  return { status: "rejected", values: [], issues: [issue], acceptedStatements: [] };
}

function validationGap(symbol: string, validation: FinancialTableValidationResult): SourceGap {
  const detail = validation.issues
    .slice(0, 4)
    .map((issue) => `${issue.code}: ${issue.message}`)
    .join("; ");
  return sourceGap({
    source: "sec-untagged-financials",
    message: `Untagged 6-K table validation ${validation.status} for ${symbol}: ${detail || "no full statements validated"}`,
    symbol,
    provider: "sec-edgar",
    capability: "extended-evidence",
    cause: "validation-failed",
    evidenceQualityImpact: "no-cap",
  });
}

export function gatedGap(symbol: string): SourceGap {
  return sourceGap({
    source: "sec-untagged-financials",
    message: `Untagged 6-K facts were not validated for ${symbol} because the capability is gated; they remain outside canonical financial-core completeness`,
    symbol,
    provider: "sec-edgar",
    capability: "extended-evidence",
    cause: "suppressed-by-design",
    evidenceQualityImpact: "no-cap",
    triage: "material",
  });
}

function artifact(
  input: FinancialTableExtractionPhaseInput,
  packet: FinancialTablePacket,
  mapping: FinancialTableMappingOutput | null,
  validation: FinancialTableValidationResult,
): UntaggedFinancialStatementsArtifact {
  return {
    version: 1,
    generatedAt: input.generatedAt,
    symbol: input.symbol.toUpperCase(),
    filing: packet.source,
    packet,
    mapping,
    validation,
    evaluation: UNTAGGED_FINANCIAL_EXTRACTOR_EVALUATION,
  };
}

export async function runFinancialTableExtractionPhase(
  input: FinancialTableExtractionPhaseInput,
): Promise<FinancialTableExtractionPhaseResult> {
  const { collectedSources } = input;
  const { financialStatements } = collectedSources;
  if (
    financialStatements === undefined ||
    !financialStatements.structuredFinancialGaps.some((gap) => gap.code === "untagged-6-k")
  ) {
    return { collectedSources, stageOutputs: [] };
  }
  const executionPolicy = input.executionPolicy ?? UNTAGGED_FINANCIAL_PRODUCTION_EXECUTION_POLICY;
  if (!executionPolicy.enabled) {
    return {
      collectedSources: {
        ...collectedSources,
        sourceGaps: [...collectedSources.sourceGaps, gatedGap(input.symbol)],
      },
      stageOutputs: [],
    };
  }

  const discovery = await collectUntaggedFinancialExhibit({
    symbol: input.symbol,
    fetchedAt: input.generatedAt,
    rawSnapshots: collectedSources.rawSnapshots,
    financialStatements,
    ...(collectedSources.resultsCoverAccessions !== undefined
      ? { resultsCoverAccessions: collectedSources.resultsCoverAccessions }
      : {}),
    ...input.collect,
  });
  if (discovery.exhibit === undefined) {
    return {
      collectedSources: {
        ...collectedSources,
        rawSnapshots: [...collectedSources.rawSnapshots, ...discovery.rawSnapshots],
        sourceGaps: [...collectedSources.sourceGaps, ...discovery.gaps],
      },
      stageOutputs: [],
    };
  }

  const { packet } = discovery.exhibit;
  if (packet.unsupportedReason !== undefined) {
    const validation = validationFromIssue({
      code: "unsupported-source-layout",
      message: packet.unsupportedReason,
    });
    return {
      collectedSources: {
        ...collectedSources,
        rawSnapshots: [...collectedSources.rawSnapshots, ...discovery.rawSnapshots],
        extendedSources: [...collectedSources.extendedSources, discovery.exhibit.source],
        sourceGaps: [
          ...collectedSources.sourceGaps,
          ...discovery.gaps,
          validationGap(input.symbol, validation),
        ],
        untaggedFinancialStatements: artifact(input, packet, null, validation),
      },
      stageOutputs: [],
    };
  }

  const output = await input.generateMapping(packet, discovery.exhibit.filing.reportDate);
  const parsed = parseFinancialTableMappingOutput(output.content);
  const extracted =
    "mapping" in parsed
      ? {
          mapping: parsed.mapping,
          validation: validateFinancialTableMapping({
            packet,
            mapping: parsed.mapping,
            filingReportDate: discovery.exhibit.filing.reportDate,
            ...(financialStatements.reportingCurrency !== undefined
              ? { expectedCurrency: financialStatements.reportingCurrency }
              : {}),
          }),
        }
      : { mapping: null, validation: validationFromIssue(parsed.issue) };
  const { mapping, validation } = extracted;
  const gaps = [
    ...discovery.gaps,
    ...(validation.status === "accepted" ? [] : [validationGap(input.symbol, validation)]),
  ];
  return {
    collectedSources: {
      ...collectedSources,
      rawSnapshots: [...collectedSources.rawSnapshots, ...discovery.rawSnapshots],
      extendedSources: [...collectedSources.extendedSources, discovery.exhibit.source],
      sourceGaps: [...collectedSources.sourceGaps, ...gaps],
      untaggedFinancialStatements: artifact(input, packet, mapping, validation),
    },
    stageOutputs: [output],
  };
}

export async function runFinancialTableMappingStage(
  packet: FinancialTablePacket,
  filingReportDate: string,
  job: {
    readonly command: ResearchCommand;
    readonly config: Pick<AppConfig, "promptDir">;
    readonly provider: ModelProvider;
  },
  runParams: ResolvedRunParams,
): Promise<StageOutput & { readonly stage: "financial-table-mapping" }> {
  const loaded = await loadStagePrompt(
    "financial-table-mapping",
    job.command,
    job.config.promptDir,
  );
  const prompt = JSON.stringify({
    stage: "financial-table-mapping",
    instruction: loaded.instruction,
    goal: loaded.goal,
    filing: packet.source,
    filingReportDate,
    allowedFields: FINANCIAL_TABLE_SEMANTIC_FIELDS,
    tables: packet.tables.map((table) => ({
      id: table.id,
      sourceTableIndex: table.sourceTableIndex,
      context: table.context,
      ...(table.title !== undefined ? { title: table.title } : {}),
      ...(table.unitText !== undefined ? { unitText: table.unitText } : {}),
      ...(table.unitCellRef !== undefined ? { unitCellRef: table.unitCellRef } : {}),
      ...(table.inheritedHeaderRefs !== undefined
        ? { inheritedHeaderRefs: table.inheritedHeaderRefs }
        : {}),
      rows: table.rows.map((row) => ({
        rowIndex: row.rowIndex,
        cells: row.cells.map((cell) => ({
          ref: cell.ref,
          text: cell.text,
          headerRefs: cell.headerRefs,
        })),
      })),
    })),
  });
  const startedAt = performance.now();
  const response = await job.provider.generate({
    step: packet.source.accessionNumber,
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
    stage: "financial-table-mapping",
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
