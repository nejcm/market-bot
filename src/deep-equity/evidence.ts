import type { CollectedSources } from "../sources/types";
import type {
  DeepEquityEvidenceBundleV1,
  DeepEquityModelEvidenceItem,
  DeepEquityModelPacket,
  DeepEquityModelSource,
} from "./types";
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

export function buildDeepEquityModelPacket(
  bundle: DeepEquityEvidenceBundleV1,
): DeepEquityModelPacket {
  const sources = uniqueSources([
    ...bundle.evidence.newsSources.map(modelSourceWithText),
    ...bundle.evidence.extendedSources.map(modelSourceMetadata),
  ]);
  return {
    schemaVersion: 1,
    run: bundle.run,
    canonicalFacts: {
      marketSnapshots: bundle.evidence.marketSnapshots,
      supplementalMarketSnapshots: bundle.evidence.supplementalMarketSnapshots,
      ...(bundle.evidence.verifiedMarketSnapshot !== undefined
        ? { verifiedMarketSnapshot: bundle.evidence.verifiedMarketSnapshot }
        : {}),
      ...(bundle.derived.financialStatements !== undefined
        ? { financialStatements: bundle.derived.financialStatements }
        : {}),
      ...(bundle.derived.fundamentalHistory !== undefined
        ? { fundamentalHistory: bundle.derived.fundamentalHistory }
        : {}),
    },
    evidenceItems: (bundle.evidence.extendedEvidence?.items ?? []).map(
      (item): DeepEquityModelEvidenceItem => {
        const { summary, ...facts } = item;
        return { ...facts, text: summary };
      },
    ),
    derivedViews: bundle.derived,
    sources,
    gaps: bundle.governance.sourceGaps,
    governance: {
      sourcePlan: bundle.governance.sourcePlan,
      evidenceLanes: bundle.governance.evidenceLanes,
      sourceLedger: bundle.governance.sourceLedger,
    },
    historicalContext: bundle.context.historicalContext,
  };
}

function modelSourceMetadata(
  source: DeepEquityEvidenceBundleV1["evidence"]["extendedSources"][number],
): DeepEquityModelSource {
  return {
    id: source.id,
    title: source.title,
    ...(source.url !== undefined ? { url: source.url } : {}),
    fetchedAt: source.fetchedAt,
    kind: source.kind,
    ...(source.provider !== undefined ? { provider: source.provider } : {}),
    ...(source.publisher !== undefined ? { publisher: source.publisher } : {}),
    ...(source.symbol !== undefined ? { symbol: source.symbol } : {}),
  };
}

function modelSourceWithText(
  source: DeepEquityEvidenceBundleV1["evidence"]["newsSources"][number],
): DeepEquityModelSource {
  const text = source.summary ?? source.snippet;
  return {
    ...modelSourceMetadata(source),
    ...(text !== undefined ? { text } : {}),
  };
}

function uniqueSources(
  sources: readonly DeepEquityModelSource[],
): readonly DeepEquityModelSource[] {
  const byId = new Map<string, DeepEquityModelSource>();
  for (const source of sources) {
    if (!byId.has(source.id)) {
      byId.set(source.id, source);
    }
  }
  return [...byId.values()];
}
