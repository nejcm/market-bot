// Public surface of the web-evidence package. External consumers import only from
// This root; everything else in the package is internal. Additions to this manifest
// Are explicit and recorded in the commit body — never deep-import into the package.
export { runWebEvidencePhase } from "./web-evidence-phase";
export { computeWebSourceUsage, type WebSourceUsage } from "./web-source-usage";
// The Web Subject Profile contract: artifact types, question-key constants, and the
// Helpers the prompts package, run-artifacts, and Evidence Reconciliation rely on.
export {
  LEGACY_WEB_SUBJECT_PROFILE_QUESTION_KEYS,
  WEB_SUBJECT_PROFILE_QUESTION_KEYS,
  isCompanyProfileSecSource,
  subjectKindForCommand,
  webSubjectProfileRequiredShape,
  type WebSubjectProfileAnswer,
  type WebSubjectProfileArtifact,
  type WebSubjectProfileCompanyQuestionKey,
  type WebSubjectProfileFact,
  type WebSubjectProfileQuestionKey,
} from "./web-subject-profile";
export { roundWebSubjectProfileAgeDays } from "./web-subject-profile-age";
