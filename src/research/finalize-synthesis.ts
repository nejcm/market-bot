import type { SynthesizeReportUntilValidResult } from "./final-synthesis";
import type { CollectedSources } from "../sources/types";
import type { EvidenceQualityAssessment } from "../domain/evidence";
import type { ResearchReport } from "../domain/report";
import type { PostSynthesisAuditWarning } from "../domain/run-trace";
import { freshWebUnusedWarnings, peerMedianClauses } from "./post-synthesis-audit";
import type { PeerMedianAudit, PeerMedianAuditClause } from "./peer-median-audit";
import type { StageOutput } from "./final-synthesis";
import { computeWebSourceUsage } from "../web-evidence";
import {
  auditReportIntegrity,
  claimsForReport,
  summarySentenceTexts,
  type ReportIntegrityAuditResult,
} from "./report-integrity-audit";
import { rederivePredictionShortfallReportAfterPruning } from "../report/prediction-shortfall";
import { reconcileEarningsForecastTelemetry } from "../forecast/earnings-eligibility";
import { validateResearchReport } from "../report/schema";
import { webSourceTexts } from "./web-figure-verification";

export async function finalizeSynthesis(
  synthesis: SynthesizeReportUntilValidResult,
  collected: CollectedSources,
  assessment: EvidenceQualityAssessment,
  peerMedianAudit: PeerMedianAudit,
): Promise<{
  readonly report: SynthesizeReportUntilValidResult["report"];
  readonly postSynthesisWarnings: readonly PostSynthesisAuditWarning[];
  readonly integrityAudit: ReportIntegrityAuditResult;
  readonly peerMedianAuditOutput?: StageOutput;
}> {
  const usablePeerSourceIds =
    collected.valuationComps === undefined
      ? undefined
      : new Set(
          collected.valuationComps.peers
            .filter((peer) => peer.usable)
            .flatMap((peer) => peer.sourceIds),
        );
  const clauses = usablePeerSourceIds === undefined ? [] : peerMedianAuditClauses(synthesis.report);
  const peerMedian = clauses.length === 0 ? undefined : await peerMedianAudit(clauses);
  const runCurrencies = [
    collected.resolvedInstrumentIdentity?.quoteCurrency,
    collected.financialStatements?.reportingCurrency,
  ].filter((currency) => currency !== undefined);
  const { warnings, ...audit } = auditReportIntegrity(
    synthesis.report,
    assessment,
    usablePeerSourceIds,
    peerMedian?.labels,
    webSourceTexts(
      [...collected.extendedSources, ...synthesis.report.sources],
      collected.rawSnapshots,
    ),
    runCurrencies,
  );
  const postSynthesisWarnings = [
    ...warnings,
    ...freshWebUnusedWarnings(computeWebSourceUsage(synthesis.report, collected)),
    ...(peerMedian?.warnings ?? []),
  ];
  const integrityAudit = {
    ...audit,
    report: rederivePredictionShortfallReportAfterPruning(audit.report),
  };
  return {
    report: validateResearchReport(reconcileEarningsForecastTelemetry(integrityAudit.report)),
    postSynthesisWarnings,
    integrityAudit,
    ...(peerMedian?.stageOutput === undefined
      ? {}
      : { peerMedianAuditOutput: peerMedian.stageOutput }),
  };
}

// Scenario name+description and summary sentences mirror the texts the integrity audit splits.
function peerMedianAuditClauses(report: ResearchReport): readonly PeerMedianAuditClause[] {
  const seen = new Set<string>();
  return [
    ...claimsForReport(report),
    ...report.scenarios.map((scenario, index) => ({
      location: `scenarios[${String(index)}]`,
      text: `${scenario.name}: ${scenario.description}`,
    })),
    ...summarySentenceTexts(report.summary).map((text) => ({ location: "summary", text })),
  ].flatMap(({ location, text }) =>
    peerMedianClauses(text).flatMap((clause) => {
      if (seen.has(clause)) {
        return [];
      }
      seen.add(clause);
      return [{ location, text: clause }];
    }),
  );
}

export class PostSynthesisError extends Error {
  // Set by the orchestrator after the Failed Run Artifact publishes; undefined skips app indexing.
  runDir?: string;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PostSynthesisError";
  }
}
