import type { SourceGap } from "../domain/types";
import { sourceGap } from "../domain/source-gaps";
import type { StageOutput } from "./final-synthesis";
import {
  collectUntaggedFinancialExhibit,
  type CollectUntaggedFinancialExhibitInput,
} from "../sources/extended-evidence/untagged-financial-exhibit";
import { UNTAGGED_FINANCIAL_COMPLETENESS_GATE } from "../sources/extended-evidence/untagged-financial-evaluation-gate";
import {
  parseFinancialTableMappingOutput,
  validateFinancialTableMapping,
} from "../sources/extended-evidence/untagged-financial-table-validation";
import type {
  FinancialTableMappingOutput,
  FinancialTablePacket,
  FinancialTableValidationIssue,
  FinancialTableValidationResult,
  UntaggedFinancialStatementsArtifact,
} from "../sources/extended-evidence/untagged-financial-tables-contract";
import type { CollectedSources } from "../sources/types";

export interface FinancialTableExtractionPhaseInput {
  readonly symbol: string;
  readonly generatedAt: string;
  readonly collectedSources: CollectedSources;
  readonly collect: Omit<
    CollectUntaggedFinancialExhibitInput,
    "symbol" | "fetchedAt" | "rawSnapshots" | "financialStatements"
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

function gateGap(symbol: string): SourceGap {
  return sourceGap({
    source: "sec-untagged-financials",
    message: `Validated untagged 6-K facts remain gated from financial-core completeness for ${symbol}: ${UNTAGGED_FINANCIAL_COMPLETENESS_GATE.reason}`,
    symbol,
    provider: "sec-edgar",
    capability: "extended-evidence",
    cause: "validation-failed",
    evidenceQualityImpact: "no-cap",
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
    completenessGate: UNTAGGED_FINANCIAL_COMPLETENESS_GATE,
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
  const discovery = await collectUntaggedFinancialExhibit({
    symbol: input.symbol,
    fetchedAt: input.generatedAt,
    rawSnapshots: collectedSources.rawSnapshots,
    financialStatements,
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
    ...(validation.status === "accepted" && !UNTAGGED_FINANCIAL_COMPLETENESS_GATE.passed
      ? [gateGap(input.symbol)]
      : []),
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
