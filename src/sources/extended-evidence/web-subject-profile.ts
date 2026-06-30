import { createHash } from "node:crypto";
import { isInstrumentCommand, type ResearchCommand } from "../../cli/args";
import { sourceGap } from "../../domain/source-gaps";
import type {
  ExtendedEvidence,
  ExtendedEvidenceItem,
  Source,
  SourceGap,
  SubjectKind,
} from "../../domain/types";
import { isRecord, nonEmptyStringArrayValue, readString, stringArrayValue } from "../guards";

export type WebSubjectProfileCompanyQuestionKey =
  | "whatItDoes"
  | "howItMakesMoney"
  | "customers"
  | "geography"
  | "purchaseRecurrence"
  | "pricingPower"
  | "recessionCyclicality"
  | "managementTrackRecord"
  | "capitalAllocation"
  | "companyKpis"
  | "riskFactors";

type WebSubjectProfileLegacyCompanyQuestionKey = Exclude<
  WebSubjectProfileCompanyQuestionKey,
  "managementTrackRecord" | "capitalAllocation" | "companyKpis" | "riskFactors"
>;

export type WebSubjectProfileCryptoQuestionKey =
  | "whatItDoes"
  | "valueAccrual"
  | "supplyIssuance"
  | "usageAdoption"
  | "governanceBuilders"
  | "competitionMoat"
  | "keyRisks";

export type WebSubjectProfileThemeQuestionKey =
  | "whatItIs"
  | "whyNow"
  | "beneficiaries"
  | "headwinds"
  | "keyDebates"
  | "howItPlaysOut";

export type WebSubjectProfileQuestionKey =
  | WebSubjectProfileCompanyQuestionKey
  | WebSubjectProfileCryptoQuestionKey
  | WebSubjectProfileThemeQuestionKey;

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

export interface WebSubjectProfileResult {
  readonly extendedEvidence?: ExtendedEvidence;
  readonly artifact?: WebSubjectProfileArtifact;
  readonly sourceGaps: readonly SourceGap[];
}

export interface WebSubjectProfileSubject {
  readonly subjectKind: SubjectKind;
  readonly subjectId: string;
  readonly subjectLabel?: string;
  readonly symbol?: string;
  readonly assetClass?: "equity" | "crypto";
}

const QUESTION_KEYS: Readonly<Record<SubjectKind, readonly WebSubjectProfileQuestionKey[]>> = {
  company: [
    "whatItDoes",
    "howItMakesMoney",
    "customers",
    "geography",
    "purchaseRecurrence",
    "pricingPower",
    "recessionCyclicality",
    "managementTrackRecord",
    "capitalAllocation",
    "companyKpis",
    "riskFactors",
  ],
  "crypto-asset": [
    "whatItDoes",
    "valueAccrual",
    "supplyIssuance",
    "usageAdoption",
    "governanceBuilders",
    "competitionMoat",
    "keyRisks",
  ],
  theme: ["whatItIs", "whyNow", "beneficiaries", "headwinds", "keyDebates", "howItPlaysOut"],
};

const EMPTY_ANSWER: WebSubjectProfileAnswer = { answer: "", sourceIds: [] };

export function normalizedSubjectId(subject: string): string {
  const normalized = subject
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .replaceAll(/-+/gu, "-");
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 8);
  return `${normalized === "" ? "subject" : normalized}-${digest}`;
}

// SEC filing Sources (10-K/10-Q text) are high-trust primary evidence that the
// Company Web Subject Profile may cite alongside gathered web Sources. They live
// In `extendedSources` with provider `sec-edgar`.
export function isCompanyProfileSecSource(source: Source): boolean {
  return (
    source.kind === "extended-evidence" &&
    source.provider === "sec-edgar" &&
    (source.id.endsWith("-10k") || source.id.endsWith("-10q"))
  );
}

export function subjectKindForCommand(command: ResearchCommand): SubjectKind | undefined {
  if (isInstrumentCommand(command)) {
    if (command.assetClass === "equity") {
      return "company";
    }
    if (command.assetClass === "crypto") {
      return "crypto-asset";
    }
  }
  return command.jobType === "research" ? "theme" : undefined;
}

export function webSubjectProfileSubjectForCommand(
  command: ResearchCommand,
  subjectLabel?: string,
): WebSubjectProfileSubject | undefined {
  const subjectKind = subjectKindForCommand(command);
  if (subjectKind === undefined) {
    return undefined;
  }
  if (isInstrumentCommand(command)) {
    return {
      subjectKind,
      subjectId: command.symbol,
      ...(subjectLabel !== undefined ? { subjectLabel } : {}),
      symbol: command.symbol,
      assetClass: command.assetClass,
    };
  }
  if (command.jobType !== "research") {
    return undefined;
  }
  return {
    subjectKind,
    subjectId: command.subjectKey ?? normalizedSubjectId(command.subject),
    subjectLabel: subjectLabel ?? command.subject,
  };
}

export function webSubjectProfileRequiredShape(subjectKind: SubjectKind): Record<string, unknown> {
  return {
    subjectLabel: "string",
    subjectSummary: { answer: "string", sourceIds: ["web-source-id"] },
    questions: Object.fromEntries(
      QUESTION_KEYS[subjectKind].map((key) => [
        key,
        { answer: "string", sourceIds: ["web-source-id"] },
      ]),
    ),
    recentMaterialEvents: [{ claim: "string", sourceIds: ["web-source-id"] }],
    factLedger: [{ claim: "string", sourceIds: ["web-source-id"] }],
    openGaps: ["string"],
  };
}

export function buildWebSubjectProfileEvidence(input: {
  readonly command: ResearchCommand;
  readonly subject: WebSubjectProfileSubject;
  readonly generatedAt: string;
  readonly modelContent: string;
  readonly webSources: readonly Source[];
  readonly extendedEvidence: ExtendedEvidence | undefined;
  readonly secFilingBasisDate?: string;
}): WebSubjectProfileResult {
  const webSourceIds = new Set(input.webSources.map((source) => source.id));
  if (webSourceIds.size === 0) {
    const message = `Web Subject Profile skipped for ${input.subject.subjectId}: no gathered web Sources`;
    const artifact = emptyArtifact(
      input.subject,
      input.generatedAt,
      message,
      input.secFilingBasisDate,
    );
    const gap = profileGap(message, "provider-data-missing");
    return profileResult(input.command, input.extendedEvidence, input.subject, artifact, [], [gap]);
  }

  const parsed = parseProfile(input.modelContent, input.subject.subjectKind, webSourceIds);
  if ("error" in parsed) {
    const message = `Web Subject Profile invalid for ${input.subject.subjectId}: ${parsed.error}`;
    const artifact = emptyArtifact(
      input.subject,
      input.generatedAt,
      message,
      input.secFilingBasisDate,
    );
    const gap = profileGap(message, "validation-failed");
    return profileResult(input.command, input.extendedEvidence, input.subject, artifact, [], [gap]);
  }

  const sourceIds = profileSourceIds(parsed.profile);
  const artifact = profileArtifact({
    subject: input.subject,
    generatedAt: input.generatedAt,
    profile: parsed.profile,
    sourceIds,
    ...(input.secFilingBasisDate !== undefined
      ? { secFilingBasisDate: input.secFilingBasisDate }
      : {}),
  });
  return profileResult(
    input.command,
    input.extendedEvidence,
    input.subject,
    artifact,
    sourceIds,
    [],
  );
}

export function buildWebSubjectProfileFailureEvidence(input: {
  readonly command: ResearchCommand;
  readonly subject: WebSubjectProfileSubject;
  readonly generatedAt: string;
  readonly message: string;
  readonly cause: NonNullable<SourceGap["cause"]>;
  readonly extendedEvidence: ExtendedEvidence | undefined;
  readonly secFilingBasisDate?: string;
}): WebSubjectProfileResult {
  const artifact = emptyArtifact(
    input.subject,
    input.generatedAt,
    input.message,
    input.secFilingBasisDate,
  );
  const gap = profileGap(input.message, input.cause);
  return profileResult(input.command, input.extendedEvidence, input.subject, artifact, [], [gap]);
}

export function buildWebSubjectProfileReuseEvidence(input: {
  readonly command: ResearchCommand;
  readonly subject: WebSubjectProfileSubject;
  readonly artifact: WebSubjectProfileArtifact;
  readonly extendedEvidence: ExtendedEvidence | undefined;
  readonly freshnessGap: SourceGap;
}): WebSubjectProfileResult {
  return profileResult(
    input.command,
    input.extendedEvidence,
    input.subject,
    input.artifact,
    input.artifact.sourceIds,
    [input.freshnessGap],
  );
}

interface ParsedProfile {
  readonly subjectLabel?: string;
  readonly companyName?: string;
  readonly subjectSummary: WebSubjectProfileAnswer;
  readonly questions: Readonly<Record<string, WebSubjectProfileAnswer>>;
  readonly recentMaterialEvents: readonly WebSubjectProfileFact[];
  readonly factLedger: readonly WebSubjectProfileFact[];
  readonly openGaps: readonly string[];
}

function parseProfile(
  content: string,
  subjectKind: SubjectKind,
  webSourceIds: ReadonlySet<string>,
): { readonly profile: ParsedProfile } | { readonly error: string } {
  const parsed = parseJsonContent(content);
  if (parsed === undefined) {
    return { error: "model output was not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { error: "model output must be an object" };
  }
  const subjectSummary = readAnswer(parsed.subjectSummary, webSourceIds);
  if ("error" in subjectSummary) {
    return { error: `subjectSummary: ${subjectSummary.error}` };
  }
  const questions = readQuestions(parsed.questions, subjectKind, webSourceIds);
  if ("error" in questions) {
    return questions;
  }
  const recentMaterialEvents = readFacts(parsed.recentMaterialEvents, webSourceIds);
  if ("error" in recentMaterialEvents) {
    return recentMaterialEvents;
  }
  const factLedger = readFacts(parsed.factLedger, webSourceIds);
  if ("error" in factLedger) {
    return factLedger;
  }
  if (factLedger.facts.length === 0) {
    return { error: "factLedger must contain at least one cited fact" };
  }
  const subjectLabel = readString(parsed, "subjectLabel");
  const companyName = readString(parsed, "companyName");
  return {
    profile: {
      subjectSummary: subjectSummary.answer,
      questions: questions.questions,
      recentMaterialEvents: recentMaterialEvents.facts,
      factLedger: factLedger.facts,
      openGaps: stringArrayValue(parsed.openGaps),
      ...(subjectLabel !== undefined ? { subjectLabel } : {}),
      ...(companyName !== undefined ? { companyName } : {}),
    },
  };
}

function parseJsonContent(content: string): unknown | undefined {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
}

function readQuestions(
  value: unknown,
  subjectKind: SubjectKind,
  webSourceIds: ReadonlySet<string>,
):
  | { readonly questions: Readonly<Record<string, WebSubjectProfileAnswer>> }
  | { readonly error: string } {
  if (!isRecord(value)) {
    return { error: "questions must be an object" };
  }
  const entries: [string, WebSubjectProfileAnswer][] = [];
  for (const key of QUESTION_KEYS[subjectKind]) {
    const answer = readAnswer(value[key], webSourceIds);
    if ("error" in answer) {
      return { error: `${key}: ${answer.error}` };
    }
    entries.push([key, answer.answer]);
  }
  return { questions: Object.fromEntries(entries) };
}

function readAnswer(
  value: unknown,
  webSourceIds: ReadonlySet<string>,
): { readonly answer: WebSubjectProfileAnswer } | { readonly error: string } {
  if (!isRecord(value)) {
    return { error: "answer must be an object" };
  }
  const answer = readString(value, "answer");
  if (answer === undefined) {
    return { error: "answer must be a non-empty string" };
  }
  const sourceIds = nonEmptyStringArrayValue(value.sourceIds);
  const invalid = sourceIds.find((sourceId) => !webSourceIds.has(sourceId));
  if (sourceIds.length === 0 || invalid !== undefined) {
    return { error: "answer sourceIds must resolve to allowed profile Sources" };
  }
  return { answer: { answer, sourceIds } };
}

function readFacts(
  value: unknown,
  webSourceIds: ReadonlySet<string>,
): { readonly facts: readonly WebSubjectProfileFact[] } | { readonly error: string } {
  if (!Array.isArray(value)) {
    return { error: "facts must be an array" };
  }
  const facts: WebSubjectProfileFact[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return { error: "fact must be an object" };
    }
    const claim = readString(item, "claim");
    const sourceIds = nonEmptyStringArrayValue(item.sourceIds);
    const invalid = sourceIds.find((sourceId) => !webSourceIds.has(sourceId));
    if (claim === undefined || sourceIds.length === 0 || invalid !== undefined) {
      return { error: "every fact must have claim and allowed profile sourceIds" };
    }
    facts.push({ claim, sourceIds });
  }
  return { facts };
}

function profileSourceIds(profile: ParsedProfile): readonly string[] {
  return [
    ...new Set([
      ...profile.subjectSummary.sourceIds,
      ...Object.values(profile.questions).flatMap((answer) => answer.sourceIds),
      ...profile.recentMaterialEvents.flatMap((fact) => fact.sourceIds),
      ...profile.factLedger.flatMap((fact) => fact.sourceIds),
    ]),
  ].toSorted();
}

function emptyQuestions(
  subjectKind: SubjectKind,
): Readonly<Record<string, WebSubjectProfileAnswer>> {
  return Object.fromEntries(QUESTION_KEYS[subjectKind].map((key) => [key, EMPTY_ANSWER]));
}

function emptyArtifact(
  subject: WebSubjectProfileSubject,
  generatedAt: string,
  gap: string,
  secFilingBasisDate?: string,
): WebSubjectProfileArtifact {
  const base = {
    version: 3 as const,
    generatedAt,
    subjectKind: subject.subjectKind,
    subjectId: subject.subjectId,
    ...(subject.subjectLabel !== undefined ? { subjectLabel: subject.subjectLabel } : {}),
    subjectSummary: EMPTY_ANSWER,
    recentMaterialEvents: [],
    factLedger: [],
    openGaps: [gap],
    sourceIds: [],
  };
  if (subject.subjectKind === "company") {
    return {
      ...base,
      subjectKind: "company",
      symbol: subject.symbol ?? subject.subjectId,
      questions: emptyQuestions("company") as Readonly<
        Record<WebSubjectProfileCompanyQuestionKey, WebSubjectProfileAnswer>
      >,
      ...(secFilingBasisDate !== undefined ? { secFilingBasisDate } : {}),
    };
  }
  if (subject.subjectKind === "crypto-asset") {
    return {
      ...base,
      subjectKind: "crypto-asset",
      symbol: subject.symbol ?? subject.subjectId,
      questions: emptyQuestions("crypto-asset") as Readonly<
        Record<WebSubjectProfileCryptoQuestionKey, WebSubjectProfileAnswer>
      >,
    };
  }
  return {
    ...base,
    subjectKind: "theme",
    questions: emptyQuestions("theme") as Readonly<
      Record<WebSubjectProfileThemeQuestionKey, WebSubjectProfileAnswer>
    >,
  };
}

function profileArtifact(input: {
  readonly subject: WebSubjectProfileSubject;
  readonly generatedAt: string;
  readonly profile: ParsedProfile;
  readonly sourceIds: readonly string[];
  readonly secFilingBasisDate?: string;
}): WebSubjectProfileArtifact {
  const subjectLabel = input.profile.subjectLabel ?? input.subject.subjectLabel;
  const base = {
    version: 3 as const,
    generatedAt: input.generatedAt,
    subjectKind: input.subject.subjectKind,
    subjectId: input.subject.subjectId,
    ...(subjectLabel !== undefined ? { subjectLabel } : {}),
    subjectSummary: input.profile.subjectSummary,
    recentMaterialEvents: input.profile.recentMaterialEvents,
    factLedger: input.profile.factLedger,
    openGaps: input.profile.openGaps,
    sourceIds: input.sourceIds,
  };
  if (input.subject.subjectKind === "company") {
    return {
      ...base,
      subjectKind: "company",
      symbol: input.subject.symbol ?? input.subject.subjectId,
      ...(input.profile.companyName !== undefined
        ? { companyName: input.profile.companyName }
        : {}),
      questions: input.profile.questions as Readonly<
        Record<WebSubjectProfileCompanyQuestionKey, WebSubjectProfileAnswer>
      >,
      ...(input.secFilingBasisDate !== undefined
        ? { secFilingBasisDate: input.secFilingBasisDate }
        : {}),
    };
  }
  if (input.subject.subjectKind === "crypto-asset") {
    return {
      ...base,
      subjectKind: "crypto-asset",
      symbol: input.subject.symbol ?? input.subject.subjectId,
      questions: input.profile.questions as Readonly<
        Record<WebSubjectProfileCryptoQuestionKey, WebSubjectProfileAnswer>
      >,
    };
  }
  return {
    ...base,
    subjectKind: "theme",
    questions: input.profile.questions as Readonly<
      Record<WebSubjectProfileThemeQuestionKey, WebSubjectProfileAnswer>
    >,
  };
}

function profileResult(
  command: ResearchCommand,
  existing: ExtendedEvidence | undefined,
  subject: WebSubjectProfileSubject,
  artifact: WebSubjectProfileArtifact,
  sourceIds: readonly string[],
  gaps: readonly SourceGap[],
): WebSubjectProfileResult {
  return {
    extendedEvidence: mergeExtendedEvidence(command, existing, subject, artifact, sourceIds, gaps),
    artifact,
    sourceGaps: gaps,
  };
}

function mergeExtendedEvidence(
  command: ResearchCommand,
  existing: ExtendedEvidence | undefined,
  subject: WebSubjectProfileSubject,
  artifact: WebSubjectProfileArtifact,
  sourceIds: readonly string[],
  gaps: readonly SourceGap[],
): ExtendedEvidence {
  const item: ExtendedEvidenceItem = {
    category: "web-subject-profile",
    title: "Web Subject Profile",
    summary:
      sourceIds.length === 0
        ? `No cited web subject profile facts were accepted for ${subject.subjectId}.`
        : `Cited web subject profile captured for ${subject.subjectId}.`,
    sourceIds,
    observedAt: artifact.generatedAt,
  };
  const scope =
    existing?.instrument !== undefined
      ? { instrument: existing.instrument }
      : evidenceScopeForSubject(command, subject);
  return {
    ...scope,
    items: [...(existing?.items ?? []).filter((entry) => entry.category !== item.category), item],
    gaps: [...(existing?.gaps ?? []), ...gaps],
  };
}

function evidenceScopeForSubject(
  command: ResearchCommand,
  subject: WebSubjectProfileSubject,
): Pick<ExtendedEvidence, "instrument" | "subject"> {
  if (isInstrumentCommand(command)) {
    return { instrument: { assetClass: command.assetClass, symbol: command.symbol } };
  }
  return {
    subject: {
      subjectKind: subject.subjectKind,
      subjectId: subject.subjectId,
      ...(subject.subjectLabel !== undefined ? { subjectLabel: subject.subjectLabel } : {}),
    },
  };
}

function profileGap(message: string, cause: NonNullable<SourceGap["cause"]>): SourceGap {
  return sourceGap({
    source: "web-subject-profile",
    message,
    provider: "market-bot",
    capability: "extended-evidence",
    cause,
    evidenceQualityImpact: "extended-evidence-cap",
  });
}
