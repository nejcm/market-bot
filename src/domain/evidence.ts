import type { Instrument, InstrumentIdentity } from "./instrument";
import type { SourceGap } from "./sources";

export type SubjectKind = "company" | "crypto-asset" | "theme";

export type EvidenceQuality = "high" | "medium" | "low";

export interface EvidenceQualityCheck {
  readonly capability: string;
  readonly evidenceClass: "core" | "material" | "supplemental";
  readonly coverage: "pass" | "fail";
  readonly freshness: "pass" | "fail" | "not-applicable";
  readonly corroboration: "pass" | "fail" | "not-applicable";
  readonly passed: boolean;
  readonly reasons: readonly string[];
}

export interface EvidenceQualityAssessment {
  readonly version: 1;
  // Rubric v2 (2026-07-19): a present-but-unsupportable material target
  // Valuation lane fails its check, capping Evidence Quality at medium.
  // Rubric v3 (2026-08-26): failed supplemental checks become advisory reasons.
  // They do not change the label. Rubrics v1 and v2 stay assignable.
  // Persisted assessments graded under the old rubrics continue to parse.
  readonly rubricVersion: 1 | 2 | 3;
  readonly label: EvidenceQuality;
  readonly checks: readonly EvidenceQualityCheck[];
  readonly limitingReasons: readonly string[];
  readonly advisoryReasons: readonly string[];
}

export type ExtendedEvidenceCategory =
  | "sec-edgar"
  | "valuation"
  | "financial-lens"
  | "subsequent-events"
  | "business-framework"
  | "web-subject-profile"
  | "yahoo-fundamentals"
  | "analyst-estimates"
  | "analyst-estimate-context"
  | "institutional-ownership"
  | "equity-events"
  | "fred-macro"
  | "options-iv"
  | "on-chain";

export interface ExtendedEvidenceItem {
  readonly category: ExtendedEvidenceCategory;
  readonly title: string;
  readonly summary: string;
  readonly sourceIds: readonly string[];
  readonly observedAt: string;
  readonly metrics?: Record<string, number | string>;
  readonly identity?: InstrumentIdentity;
}

export interface ExtendedEvidence {
  readonly instrument?: Instrument;
  readonly subject?: {
    readonly subjectKind: SubjectKind;
    readonly subjectId: string;
    readonly subjectLabel?: string;
  };
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
}
