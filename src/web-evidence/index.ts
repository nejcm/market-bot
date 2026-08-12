// Public orchestration consumers import from this package root.
// Dependency-layer consumers that cannot load the phase use the public ./contract leaf.
// Everything else is internal. Additions to either surface are explicit.
export { runWebEvidencePhase } from "./web-evidence-phase";
export {
  buildWebEvidenceUtilization,
  classifyWebEvidenceUtilization,
  computeWebSourceUsage,
  type WebSourceUsage,
} from "./web-source-usage";
// The Web Subject Profile contract exposes artifact types and question-key constants.
// Prompt builders and other profile consumers use the behavior exports below.
export {
  LEGACY_WEB_SUBJECT_PROFILE_QUESTION_KEYS,
  WEB_SUBJECT_PROFILE_QUESTION_KEYS,
  type WebSubjectProfileAnswer,
  type WebSubjectProfileArtifact,
  type WebSubjectProfileCompanyQuestionKey,
  type WebSubjectProfileFact,
  type WebSubjectProfileQuestionKey,
} from "./contract";
export {
  isCompanyProfileSecSource,
  subjectKindForCommand,
  webSubjectProfileRequiredShape,
} from "./web-subject-profile";
export { roundWebSubjectProfileAgeDays } from "./web-subject-profile-age";
