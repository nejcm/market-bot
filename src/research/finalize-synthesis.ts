import type { SynthesizeReportUntilValidResult } from "./final-synthesis";
import type { CollectedSources } from "../sources/types";
import type { EvidenceQualityAssessment } from "../domain/evidence";
import { auditPostSynthesisReport } from "./post-synthesis-audit";
import { computeWebSourceUsage } from "../web-evidence";
import { auditReportIntegrity } from "./report-integrity-audit";
import { rederivePredictionShortfallReportAfterPruning } from "../report/prediction-shortfall";
import { reconcileEarningsForecastTelemetry } from "../forecast/earnings-eligibility";
import { validateResearchReport } from "../report/schema";

export function finalizeSynthesis(
  synthesis: SynthesizeReportUntilValidResult,
  collected: CollectedSources,
  assessment: EvidenceQualityAssessment,
): {
  readonly report: SynthesizeReportUntilValidResult["report"];
  readonly postSynthesisWarnings: ReturnType<typeof auditPostSynthesisReport>;
  readonly integrityAudit: ReturnType<typeof auditReportIntegrity>;
} {
  const postSynthesisWarnings = auditPostSynthesisReport(
    synthesis.report,
    computeWebSourceUsage(synthesis.report, collected),
    collected.valuationComps === undefined
      ? undefined
      : new Set(
          collected.valuationComps.peers
            .filter((peer) => peer.usable)
            .flatMap((peer) => peer.sourceIds),
        ),
  );
  const audit = auditReportIntegrity(synthesis.report, assessment);
  const integrityAudit = {
    ...audit,
    report: rederivePredictionShortfallReportAfterPruning(audit.report),
  };
  return {
    report: validateResearchReport(reconcileEarningsForecastTelemetry(integrityAudit.report)),
    postSynthesisWarnings,
    integrityAudit,
  };
}
