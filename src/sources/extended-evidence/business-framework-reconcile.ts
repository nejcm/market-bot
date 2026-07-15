import type { SourceGap } from "../../domain/types";
import {
  frameworkGap,
  type BusinessFrameworkArtifact,
  type BusinessFrameworkGapCode,
  type BusinessFrameworkGapValue,
  type BusinessFrameworkReconciliation,
  type BusinessFrameworkSection,
} from "./business-framework";
import type {
  WebSubjectProfileArtifact,
  WebSubjectProfileCompanyQuestionKey,
} from "../../web-evidence/contract";

const PROFILE_GAP_QUESTIONS: readonly {
  readonly code: BusinessFrameworkGapCode;
  readonly question: WebSubjectProfileCompanyQuestionKey;
}[] = [
  { code: "business-description", question: "whatItDoes" },
  { code: "geographic-mix", question: "geography" },
  { code: "segment-mix", question: "howItMakesMoney" },
  { code: "customer-concentration", question: "customers" },
  { code: "purchase-recurrence", question: "purchaseRecurrence" },
  { code: "management-track-record", question: "managementTrackRecord" },
  { code: "capital-allocation", question: "capitalAllocation" },
  { code: "company-kpis", question: "companyKpis" },
  { code: "risk-factors", question: "riskFactors" },
  { code: "pricing-power", question: "pricingPower" },
  { code: "cyclicality", question: "recessionCyclicality" },
];

export interface ReconciliationResult {
  readonly artifact: BusinessFrameworkArtifact;
  readonly sourceGap: SourceGap | undefined;
}

function gapCode(gap: BusinessFrameworkGapValue): BusinessFrameworkGapCode | undefined {
  return typeof gap === "string" ? undefined : gap.code;
}

// Non-answer phrasing the model uses when a disclosure is absent. A cited
// "Not disclosed" carries sourceIds but is not substantive evidence, so it must
// Not clear its mapped Business Framework gap.
const NON_ANSWER_RE =
  /(^|\b)(not\s+(disclosed|quantified|available|provided|broken\s+out)|undisclosed|no\s+(disclosure|quantified\s+disclosure)|does\s+not\s+disclose|is\s+not\s+broken\s+out|are\s+not\s+broken\s+out)\b/iu;

function isNonAnswer(text: string): boolean {
  return NON_ANSWER_RE.test(text.trim());
}

function citedAnswer(
  profile: WebSubjectProfileArtifact,
  question: WebSubjectProfileCompanyQuestionKey,
): readonly string[] {
  if (profile.subjectKind !== "company") {
    return [];
  }
  const answer = profile.questions[question];
  if (answer === undefined || answer.answer === "" || isNonAnswer(answer.answer)) {
    return [];
  }
  return answer.sourceIds;
}

export function reconcileBusinessFramework(
  framework: BusinessFrameworkArtifact,
  profile: WebSubjectProfileArtifact,
): ReconciliationResult {
  if (framework.version !== 2 || profile.subjectKind !== "company" || profile.version !== 3) {
    return unchanged(framework);
  }

  const presentCodes = new Set(
    framework.gaps
      .map((gap) => gapCode(gap))
      .filter((code): code is BusinessFrameworkGapCode => code !== undefined),
  );
  const resolved = PROFILE_GAP_QUESTIONS.flatMap(({ code, question }) => {
    const sourceIds = citedAnswer(profile, question);
    return presentCodes.has(code) && sourceIds.length > 0 ? [{ code, sourceIds }] : [];
  });
  if (resolved.length === 0) {
    return unchanged(framework);
  }

  const resolvedCodes = new Set(resolved.map((entry) => entry.code));
  const keepGap = (gap: BusinessFrameworkGapValue): boolean => {
    const code = gapCode(gap);
    return code === undefined || !resolvedCodes.has(code);
  };
  const sections: readonly BusinessFrameworkSection[] = framework.sections.map((section) => ({
    ...section,
    gaps: section.gaps.filter(keepGap),
  }));
  const gaps = framework.gaps.filter(keepGap);
  const reconciliation: BusinessFrameworkReconciliation = {
    resolvedGaps: [...resolvedCodes].toSorted(),
    profileSourceIds: [...new Set(resolved.flatMap((entry) => entry.sourceIds))].toSorted(),
  };
  const artifact: BusinessFrameworkArtifact = {
    ...framework,
    sections,
    gaps,
    reconciliation,
  };
  return {
    artifact,
    sourceGap: gaps.length === 0 ? undefined : frameworkGap(framework.symbol, gaps),
  };
}

function unchanged(framework: BusinessFrameworkArtifact): ReconciliationResult {
  return {
    artifact: framework,
    sourceGap:
      framework.gaps.length === 0 ? undefined : frameworkGap(framework.symbol, framework.gaps),
  };
}
