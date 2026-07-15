import type { SubjectKind } from "../domain/types";

const LEGACY_COMPANY_QUESTION_KEYS = [
  "whatItDoes",
  "howItMakesMoney",
  "customers",
  "geography",
  "purchaseRecurrence",
  "pricingPower",
  "recessionCyclicality",
] as const;
const COMPANY_QUESTION_KEYS = [
  ...LEGACY_COMPANY_QUESTION_KEYS,
  "managementTrackRecord",
  "capitalAllocation",
  "companyKpis",
  "riskFactors",
] as const;
const CRYPTO_QUESTION_KEYS = [
  "whatItDoes",
  "valueAccrual",
  "supplyIssuance",
  "usageAdoption",
  "governanceBuilders",
  "competitionMoat",
  "keyRisks",
] as const;
const THEME_QUESTION_KEYS = [
  "whatItIs",
  "whyNow",
  "beneficiaries",
  "headwinds",
  "keyDebates",
  "howItPlaysOut",
] as const;

export const LEGACY_WEB_SUBJECT_PROFILE_QUESTION_KEYS = {
  company: LEGACY_COMPANY_QUESTION_KEYS,
  "crypto-asset": CRYPTO_QUESTION_KEYS,
  theme: THEME_QUESTION_KEYS,
} as const satisfies Readonly<Record<SubjectKind, readonly string[]>>;

export const WEB_SUBJECT_PROFILE_QUESTION_KEYS = {
  company: COMPANY_QUESTION_KEYS,
  "crypto-asset": CRYPTO_QUESTION_KEYS,
  theme: THEME_QUESTION_KEYS,
} as const satisfies Readonly<Record<SubjectKind, readonly string[]>>;

export type WebSubjectProfileLegacyCompanyQuestionKey =
  (typeof LEGACY_WEB_SUBJECT_PROFILE_QUESTION_KEYS.company)[number];
export type WebSubjectProfileCompanyQuestionKey =
  (typeof WEB_SUBJECT_PROFILE_QUESTION_KEYS.company)[number];
export type WebSubjectProfileCryptoQuestionKey =
  (typeof WEB_SUBJECT_PROFILE_QUESTION_KEYS)["crypto-asset"][number];
export type WebSubjectProfileThemeQuestionKey =
  (typeof WEB_SUBJECT_PROFILE_QUESTION_KEYS.theme)[number];
export type WebSubjectProfileQuestionKey =
  (typeof WEB_SUBJECT_PROFILE_QUESTION_KEYS)[SubjectKind][number];

export interface WebSubjectProfileAnswer {
  readonly answer: string;
  readonly sourceIds: readonly string[];
}

export interface WebSubjectProfileFact {
  readonly claim: string;
  readonly sourceIds: readonly string[];
}

interface WebSubjectProfileBase {
  readonly version: 2 | 3;
  readonly generatedAt: string;
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly subjectLabel?: string;
  readonly subjectSummary: WebSubjectProfileAnswer;
  readonly recentMaterialEvents: readonly WebSubjectProfileFact[];
  readonly factLedger: readonly WebSubjectProfileFact[];
  readonly openGaps: readonly string[];
  readonly sourceIds: readonly string[];
}

export type WebSubjectProfileArtifact =
  | (WebSubjectProfileBase & {
      readonly subjectKind: "company";
      readonly symbol: string;
      readonly companyName?: string;
      readonly questions: Readonly<
        Record<WebSubjectProfileLegacyCompanyQuestionKey, WebSubjectProfileAnswer> &
          Partial<Record<WebSubjectProfileCompanyQuestionKey, WebSubjectProfileAnswer>>
      >;
      readonly secFilingBasisDate?: string;
    })
  | (WebSubjectProfileBase & {
      readonly subjectKind: "crypto-asset";
      readonly symbol: string;
      readonly questions: Readonly<
        Record<WebSubjectProfileCryptoQuestionKey, WebSubjectProfileAnswer>
      >;
    })
  | (WebSubjectProfileBase & {
      readonly subjectKind: "theme";
      readonly questions: Readonly<
        Record<WebSubjectProfileThemeQuestionKey, WebSubjectProfileAnswer>
      >;
    });
