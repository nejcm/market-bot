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
  readonly completenessGate?: UntaggedFinancialStatementsArtifact["completenessGate"];
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

function gatedGap(symbol: string): SourceGap {
  return sourceGap({
    source: "sec-untagged-financials",
    message: `Untagged 6-K facts were not validated for ${symbol} because the capability is gated; they remain outside canonical financial-core completeness`,
    symbol,
    provider: "sec-edgar",
    capability: "extended-evidence",
    evidenceQualityImpact: "no-cap",
    triage: "material",
  });
}

function artifact(
  input: FinancialTableExtractionPhaseInput,
  packet: FinancialTablePacket,
  mapping: FinancialTableMappingOutput | null,
  validation: FinancialTableValidationResult,
  completenessGate: UntaggedFinancialStatementsArtifact["completenessGate"],
): UntaggedFinancialStatementsArtifact {
  return {
    version: 1,
    generatedAt: input.generatedAt,
    symbol: input.symbol.toUpperCase(),
    filing: packet.source,
    packet,
    mapping,
    validation,
    completenessGate,
  };
}

function gatedArtifact(
  input: FinancialTableExtractionPhaseInput,
  packet: FinancialTablePacket,
  completenessGate: UntaggedFinancialStatementsArtifact["completenessGate"],
): UntaggedFinancialStatementsArtifact {
  return {
    version: 1,
    generatedAt: input.generatedAt,
    symbol: input.symbol.toUpperCase(),
    status: "gated",
    validationAttempted: false,
    filing: packet.source,
    completenessGate,
  };
}

export async function runFinancialTableExtractionPhase(
  input: FinancialTableExtractionPhaseInput,
): Promise<FinancialTableExtractionPhaseResult> {
  const { collectedSources } = input;
  const completenessGate = input.completenessGate ?? UNTAGGED_FINANCIAL_COMPLETENESS_GATE;
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
        untaggedFinancialStatements: artifact(input, packet, null, validation, completenessGate),
      },
      stageOutputs: [],
    };
  }

  if (!completenessGate.passed) {
    return {
      collectedSources: {
        ...collectedSources,
        rawSnapshots: [...collectedSources.rawSnapshots, ...discovery.rawSnapshots],
        extendedSources: [...collectedSources.extendedSources, discovery.exhibit.source],
        sourceGaps: [...collectedSources.sourceGaps, ...discovery.gaps, gatedGap(input.symbol)],
        untaggedFinancialStatements: gatedArtifact(input, packet, completenessGate),
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
      untaggedFinancialStatements: artifact(input, packet, mapping, validation, completenessGate),
    },
    stageOutputs: [output],
  };
}
