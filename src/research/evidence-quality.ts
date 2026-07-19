import type {
  EvidenceQuality,
  EvidenceQualityAssessment,
  EvidenceQualityCheck,
} from "../domain/types";
import type { BuildSourcePlanResult, EvidenceLane, EvidenceLaneCoverageV2 } from "./source-plan";

const FRESHNESS_DAYS: Readonly<Partial<Record<EvidenceLane, number>>> = {
  "market-data": 3,
  "supplemental-market": 3,
  news: 14,
  "market-context": 45,
  "verified-price-history": 3,
  "regulatory-filings": 550,
  "corporate-events": 90,
  "macro-indicators": 45,
  "derivatives-volatility": 3,
  "on-chain": 3,
  "target-valuation": 550,
  "peer-valuation": 550,
  "subject-profile": 30,
};

function ageDays(generatedAt: string, value: string): number | undefined {
  const generated = Date.parse(generatedAt);
  const observed = Date.parse(value);
  if (!Number.isFinite(generated) || !Number.isFinite(observed)) {
    return;
  }
  return (generated - observed) / 86_400_000;
}

function freshness(
  lane: EvidenceLaneCoverageV2,
  sourcePlanning: BuildSourcePlanResult,
  generatedAt: string,
): EvidenceQualityCheck["freshness"] {
  const limit = FRESHNESS_DAYS[lane.lane];
  if (limit === undefined || lane.status !== "covered") {
    return "not-applicable";
  }
  const timestamps = sourcePlanning.sourceLedger.sources
    .filter((source) => source.lane === lane.lane)
    .map((source) => source.observedAt ?? source.fetchedAt)
    .filter((value): value is string => value !== undefined);
  if (timestamps.length === 0) {
    return "fail";
  }
  return timestamps.some((value) => {
    const age = ageDays(generatedAt, value);
    return age !== undefined && age >= 0 && age <= limit;
  })
    ? "pass"
    : "fail";
}

function corroboration(lane: EvidenceLaneCoverageV2): EvidenceQualityCheck["corroboration"] {
  if (lane.status !== "covered" || lane.lane !== "news") {
    return "not-applicable";
  }
  return lane.coveredSourceIds.length >= 2 ? "pass" : "fail";
}

function checkFor(
  lane: EvidenceLaneCoverageV2,
  sourcePlanning: BuildSourcePlanResult,
  generatedAt: string,
): EvidenceQualityCheck {
  const { evidenceClass } = lane;
  const coverage = lane.status === "covered" ? "pass" : "fail";
  const freshnessResult = freshness(lane, sourcePlanning, generatedAt);
  const corroborationResult = corroboration(lane);
  // The target-valuation lane can acquire sources yet still be unusable: a
  // Present-but-not-supportable target valuation is a failed material check, so
  // The run does not read as a clean pass. Coverage stays acquisition-only.
  const supportabilityFailed =
    lane.lane === "target-valuation" && coverage === "pass" && lane.supportable === false;
  const reasons = [
    ...(coverage === "fail" ? [`${lane.lane}: evidence missing or unusable`] : []),
    ...(supportabilityFailed ? ["target-valuation: evidence present but not supportable"] : []),
    ...(freshnessResult === "fail" ? [`${lane.lane}: freshness check failed`] : []),
    ...(corroborationResult === "fail" ? [`${lane.lane}: corroboration check failed`] : []),
  ];
  return {
    capability: lane.lane,
    evidenceClass,
    coverage,
    freshness: freshnessResult,
    corroboration: corroborationResult,
    passed: reasons.length === 0,
    reasons,
  };
}

export function assessEvidenceQuality(
  sourcePlanning: BuildSourcePlanResult,
  generatedAt: string,
): EvidenceQualityAssessment {
  const checks = sourcePlanning.evidenceLanes.lanes.map((lane) =>
    checkFor(lane, sourcePlanning, generatedAt),
  );
  const failedCore = checks.filter((check) => check.evidenceClass === "core" && !check.passed);
  const failedMaterial = checks.filter(
    (check) => check.evidenceClass === "material" && !check.passed,
  );
  let label: EvidenceQuality = "high";
  if (failedCore.length > 0) {
    label = "low";
  } else if (failedMaterial.length > 0) {
    label = "medium";
  }
  return {
    version: 1,
    rubricVersion: 1,
    label,
    checks,
    limitingReasons: [...failedCore, ...failedMaterial].flatMap((check) => check.reasons),
  };
}
