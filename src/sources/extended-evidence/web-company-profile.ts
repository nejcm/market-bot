import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../../cli/args";
import { sourceGap } from "../../domain/source-gaps";
import type { ExtendedEvidence, ExtendedEvidenceItem, Source, SourceGap } from "../../domain/types";
import { isRecord, nonEmptyStringArrayValue, readString, stringArrayValue } from "../guards";

export type WebCompanyProfileQuestionKey =
  | "whatItDoes"
  | "howItMakesMoney"
  | "customers"
  | "geography"
  | "purchaseRecurrence"
  | "pricingPower"
  | "recessionCyclicality";

export interface WebCompanyProfileAnswer {
  readonly answer: string;
  readonly sourceIds: readonly string[];
}

export interface WebCompanyProfileFact {
  readonly claim: string;
  readonly sourceIds: readonly string[];
}

export interface WebCompanyProfileArtifact {
  readonly version: 1;
  readonly generatedAt: string;
  readonly symbol: string;
  readonly companyName?: string;
  readonly questions: Readonly<Record<WebCompanyProfileQuestionKey, WebCompanyProfileAnswer>>;
  readonly recentMaterialEvents: readonly WebCompanyProfileFact[];
  readonly factLedger: readonly WebCompanyProfileFact[];
  readonly openGaps: readonly string[];
  readonly sourceIds: readonly string[];
  readonly secFilingBasisDate?: string;
}

export interface WebCompanyProfileResult {
  readonly extendedEvidence?: ExtendedEvidence;
  readonly artifact?: WebCompanyProfileArtifact;
  readonly sourceGaps: readonly SourceGap[];
}

const QUESTION_KEYS: readonly WebCompanyProfileQuestionKey[] = [
  "whatItDoes",
  "howItMakesMoney",
  "customers",
  "geography",
  "purchaseRecurrence",
  "pricingPower",
  "recessionCyclicality",
];

const EMPTY_QUESTIONS: Readonly<Record<WebCompanyProfileQuestionKey, WebCompanyProfileAnswer>> = {
  whatItDoes: { answer: "", sourceIds: [] },
  howItMakesMoney: { answer: "", sourceIds: [] },
  customers: { answer: "", sourceIds: [] },
  geography: { answer: "", sourceIds: [] },
  purchaseRecurrence: { answer: "", sourceIds: [] },
  pricingPower: { answer: "", sourceIds: [] },
  recessionCyclicality: { answer: "", sourceIds: [] },
};

export function webCompanyProfileRequiredShape(): Record<string, unknown> {
  return {
    companyName: "string",
    questions: {
      whatItDoes: { answer: "string", sourceIds: ["web-source-id"] },
      howItMakesMoney: { answer: "string", sourceIds: ["web-source-id"] },
      customers: { answer: "string", sourceIds: ["web-source-id"] },
      geography: { answer: "string", sourceIds: ["web-source-id"] },
      purchaseRecurrence: { answer: "string", sourceIds: ["web-source-id"] },
      pricingPower: { answer: "string", sourceIds: ["web-source-id"] },
      recessionCyclicality: { answer: "string", sourceIds: ["web-source-id"] },
    },
    recentMaterialEvents: [{ claim: "string", sourceIds: ["web-source-id"] }],
    factLedger: [{ claim: "string", sourceIds: ["web-source-id"] }],
    openGaps: ["string"],
  };
}

export function buildWebCompanyProfileEvidence(input: {
  readonly command: ResearchCommand;
  readonly generatedAt: string;
  readonly modelContent: string;
  readonly webSources: readonly Source[];
  readonly extendedEvidence: ExtendedEvidence | undefined;
  readonly secFilingBasisDate?: string;
}): WebCompanyProfileResult {
  if (!isInstrumentCommand(input.command) || input.command.assetClass !== "equity") {
    return {
      ...(input.extendedEvidence !== undefined ? { extendedEvidence: input.extendedEvidence } : {}),
      sourceGaps: [],
    };
  }

  const webSourceIds = new Set(input.webSources.map((source) => source.id));
  if (webSourceIds.size === 0) {
    const message = `Web Company Profile skipped for ${input.command.symbol}: no gathered web Sources`;
    const artifact = emptyArtifact(
      input.command,
      input.generatedAt,
      message,
      input.secFilingBasisDate,
    );
    const gap = profileGap(message, "provider-data-missing");
    return {
      extendedEvidence: mergeExtendedEvidence(
        input.command,
        input.extendedEvidence,
        artifact,
        [],
        [gap],
      ),
      artifact,
      sourceGaps: [gap],
    };
  }

  const parsed = parseProfile(input.modelContent, webSourceIds);
  if ("error" in parsed) {
    const message = `Web Company Profile invalid for ${input.command.symbol}: ${parsed.error}`;
    const artifact = emptyArtifact(
      input.command,
      input.generatedAt,
      message,
      input.secFilingBasisDate,
    );
    const gap = profileGap(message, "validation-failed");
    return {
      extendedEvidence: mergeExtendedEvidence(
        input.command,
        input.extendedEvidence,
        artifact,
        [],
        [gap],
      ),
      artifact,
      sourceGaps: [gap],
    };
  }

  const sourceIds = profileSourceIds(parsed.profile);
  const artifact: WebCompanyProfileArtifact = {
    version: 1,
    generatedAt: input.generatedAt,
    symbol: input.command.symbol,
    ...(parsed.profile.companyName !== undefined
      ? { companyName: parsed.profile.companyName }
      : {}),
    questions: parsed.profile.questions,
    recentMaterialEvents: parsed.profile.recentMaterialEvents,
    factLedger: parsed.profile.factLedger,
    openGaps: parsed.profile.openGaps,
    sourceIds,
    ...(input.secFilingBasisDate !== undefined
      ? { secFilingBasisDate: input.secFilingBasisDate }
      : {}),
  };

  return {
    extendedEvidence: mergeExtendedEvidence(
      input.command,
      input.extendedEvidence,
      artifact,
      sourceIds,
      [],
    ),
    artifact,
    sourceGaps: [],
  };
}

export function buildWebCompanyProfileFailureEvidence(input: {
  readonly command: InstrumentCommand;
  readonly generatedAt: string;
  readonly message: string;
  readonly cause: NonNullable<SourceGap["cause"]>;
  readonly extendedEvidence: ExtendedEvidence | undefined;
  readonly secFilingBasisDate?: string;
}): WebCompanyProfileResult {
  const artifact = emptyArtifact(
    input.command,
    input.generatedAt,
    input.message,
    input.secFilingBasisDate,
  );
  const gap = profileGap(input.message, input.cause);
  return {
    extendedEvidence: mergeExtendedEvidence(
      input.command,
      input.extendedEvidence,
      artifact,
      [],
      [gap],
    ),
    artifact,
    sourceGaps: [gap],
  };
}

function parseProfile(
  content: string,
  webSourceIds: ReadonlySet<string>,
):
  | {
      readonly profile: Omit<
        WebCompanyProfileArtifact,
        "version" | "generatedAt" | "symbol" | "sourceIds" | "secFilingBasisDate"
      >;
    }
  | { readonly error: string } {
  const parsed = parseJsonContent(content);
  if (parsed === undefined) {
    return { error: "model output was not valid JSON" };
  }
  if (!isRecord(parsed)) {
    return { error: "model output must be an object" };
  }
  const questions = readQuestions(parsed.questions, webSourceIds);
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
  const companyName = readString(parsed, "companyName");
  return {
    profile: {
      ...(companyName !== undefined ? { companyName } : {}),
      questions: questions.questions,
      recentMaterialEvents: recentMaterialEvents.facts,
      factLedger: factLedger.facts,
      openGaps: stringArrayValue(parsed.openGaps),
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
  webSourceIds: ReadonlySet<string>,
):
  | { readonly questions: Readonly<Record<WebCompanyProfileQuestionKey, WebCompanyProfileAnswer>> }
  | { readonly error: string } {
  if (!isRecord(value)) {
    return { error: "questions must be an object" };
  }
  const entries: [WebCompanyProfileQuestionKey, WebCompanyProfileAnswer][] = [];
  for (const key of QUESTION_KEYS) {
    const answer = readAnswer(value[key], webSourceIds);
    if ("error" in answer) {
      return { error: `${key}: ${answer.error}` };
    }
    entries.push([key, answer.answer]);
  }
  return {
    questions: Object.fromEntries(entries) as Readonly<
      Record<WebCompanyProfileQuestionKey, WebCompanyProfileAnswer>
    >,
  };
}

function readAnswer(
  value: unknown,
  webSourceIds: ReadonlySet<string>,
): { readonly answer: WebCompanyProfileAnswer } | { readonly error: string } {
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
    return { error: "answer sourceIds must resolve to gathered web Sources" };
  }
  return { answer: { answer, sourceIds } };
}

function readFacts(
  value: unknown,
  webSourceIds: ReadonlySet<string>,
): { readonly facts: readonly WebCompanyProfileFact[] } | { readonly error: string } {
  if (!Array.isArray(value)) {
    return { error: "facts must be an array" };
  }
  const facts: WebCompanyProfileFact[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      return { error: "fact must be an object" };
    }
    const claim = readString(item, "claim");
    const sourceIds = nonEmptyStringArrayValue(item.sourceIds);
    const invalid = sourceIds.find((sourceId) => !webSourceIds.has(sourceId));
    if (claim === undefined || sourceIds.length === 0 || invalid !== undefined) {
      return { error: "every fact must have claim and gathered-web sourceIds" };
    }
    facts.push({ claim, sourceIds });
  }
  return { facts };
}

function profileSourceIds(
  profile: Pick<WebCompanyProfileArtifact, "questions" | "recentMaterialEvents" | "factLedger">,
): readonly string[] {
  return [
    ...new Set([
      ...Object.values(profile.questions).flatMap((answer) => answer.sourceIds),
      ...profile.recentMaterialEvents.flatMap((fact) => fact.sourceIds),
      ...profile.factLedger.flatMap((fact) => fact.sourceIds),
    ]),
  ].toSorted();
}

function emptyArtifact(
  command: InstrumentCommand,
  generatedAt: string,
  gap: string,
  secFilingBasisDate?: string,
): WebCompanyProfileArtifact {
  return {
    version: 1,
    generatedAt,
    symbol: command.symbol,
    questions: EMPTY_QUESTIONS,
    recentMaterialEvents: [],
    factLedger: [],
    openGaps: [gap],
    sourceIds: [],
    ...(secFilingBasisDate !== undefined ? { secFilingBasisDate } : {}),
  };
}

function mergeExtendedEvidence(
  command: InstrumentCommand,
  existing: ExtendedEvidence | undefined,
  artifact: WebCompanyProfileArtifact,
  sourceIds: readonly string[],
  gaps: readonly SourceGap[],
): ExtendedEvidence {
  const item: ExtendedEvidenceItem = {
    category: "web-company-profile",
    title: "Web Company Profile",
    summary:
      sourceIds.length === 0
        ? `No cited web company profile facts were accepted for ${command.symbol}.`
        : `Cited web company profile captured for ${command.symbol}.`,
    sourceIds,
    observedAt: artifact.generatedAt,
  };
  return {
    instrument: existing?.instrument ?? { assetClass: command.assetClass, symbol: command.symbol },
    items: [...(existing?.items ?? []).filter((entry) => entry.category !== item.category), item],
    gaps: [...(existing?.gaps ?? []), ...gaps],
  };
}

function profileGap(message: string, cause: NonNullable<SourceGap["cause"]>): SourceGap {
  return sourceGap({
    source: "web-company-profile",
    message,
    provider: "market-bot",
    capability: "extended-evidence",
    cause,
    evidenceQualityImpact: "extended-evidence-cap",
  });
}
