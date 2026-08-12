import type { CollectedSources } from "../sources/types";
import type { DeepEquityEvidenceBundleV1 } from "./types";
import type { HistoricalResearchContext } from "../research/historical-context";
import type {
  EvidenceLanesArtifact,
  SourceLedgerArtifact,
  SourcePlanArtifact,
} from "../research/source-plan";

export function buildDeepEquityEvidenceBundle(input: {
  readonly symbol: string;
  readonly analysisAsOf: string;
  readonly collectedSources: CollectedSources;
  readonly historicalContext: HistoricalResearchContext;
  readonly sourcePlan: SourcePlanArtifact;
  readonly evidenceLanes: EvidenceLanesArtifact;
  readonly sourceLedger: SourceLedgerArtifact;
}): DeepEquityEvidenceBundleV1 {
  const { collectedSources } = input;
  return {
    schemaVersion: 1,
    run: {
      symbol: input.symbol.toUpperCase(),
      analysisAsOf: input.analysisAsOf,
      ...(collectedSources.resolvedInstrumentIdentity !== undefined
        ? { identity: collectedSources.resolvedInstrumentIdentity }
        : {}),
    },
    evidence: {
      marketSnapshots: collectedSources.marketSnapshots,
      supplementalMarketSnapshots: collectedSources.supplementalMarketSnapshots,
      ...(collectedSources.verifiedMarketSnapshot !== undefined
        ? { verifiedMarketSnapshot: collectedSources.verifiedMarketSnapshot }
        : {}),
      newsSources: collectedSources.newsSources,
      extendedSources: collectedSources.extendedSources,
      ...(collectedSources.extendedEvidence !== undefined
        ? { extendedEvidence: collectedSources.extendedEvidence }
        : {}),
      ...(collectedSources.webSubjectProfile !== undefined
        ? { webSubjectProfile: collectedSources.webSubjectProfile }
        : {}),
    },
    derived: {
      ...(collectedSources.financialStatements !== undefined
        ? { financialStatements: collectedSources.financialStatements }
        : {}),
      ...(collectedSources.fundamentalHistory !== undefined
        ? { fundamentalHistory: collectedSources.fundamentalHistory }
        : {}),
      ...(collectedSources.financialLenses !== undefined
        ? { financialLenses: collectedSources.financialLenses }
        : {}),
      ...(collectedSources.capitalOwnership !== undefined
        ? { capitalOwnership: collectedSources.capitalOwnership }
        : {}),
      ...(collectedSources.subsequentFinancing !== undefined
        ? { subsequentFinancing: collectedSources.subsequentFinancing }
        : {}),
      ...(collectedSources.analystExpectations !== undefined
        ? { analystExpectations: collectedSources.analystExpectations }
        : {}),
      ...(collectedSources.institutionalOwnership !== undefined
        ? { institutionalOwnership: collectedSources.institutionalOwnership }
        : {}),
      ...(collectedSources.valuationComps !== undefined
        ? { valuationComps: collectedSources.valuationComps }
        : {}),
      ...(collectedSources.valuationWorkbench !== undefined
        ? { valuationWorkbench: collectedSources.valuationWorkbench }
        : {}),
      ...(collectedSources.reverseDcf !== undefined
        ? { reverseDcf: collectedSources.reverseDcf }
        : {}),
      ...(collectedSources.earningsSetup !== undefined
        ? { earningsSetup: collectedSources.earningsSetup }
        : {}),
      ...(collectedSources.businessFramework !== undefined
        ? { businessFramework: collectedSources.businessFramework }
        : {}),
    },
    governance: {
      sourceGaps: collectedSources.sourceGaps,
      sourcePlan: input.sourcePlan,
      evidenceLanes: input.evidenceLanes,
      sourceLedger: input.sourceLedger,
      ...(collectedSources.modelInputSanitization !== undefined
        ? { modelInputSanitization: collectedSources.modelInputSanitization }
        : {}),
      ...(collectedSources.newsAnalytics !== undefined
        ? { newsAnalytics: collectedSources.newsAnalytics }
        : {}),
    },
    context: { historicalContext: input.historicalContext },
  };
}
