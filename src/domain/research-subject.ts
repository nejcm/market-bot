import type {
  ResearchSubjectInstrument,
  ResearchSubjectSource,
  ResearchSubjectSummary,
} from "./subject-registry";

export interface ResearchSubjectIdentity {
  readonly subjectKey?: string;
  readonly predictionProxySymbol?: string;
}

export interface ResolvedResearchSubject {
  readonly input: string;
  readonly normalizedInput: string;
  readonly status: "resolved" | "unresolved";
  readonly canEmitPredictions: boolean;
  readonly reason: string;
  readonly subjectKey?: string;
  readonly displayName?: string;
  readonly aliases?: readonly string[];
  readonly representativeInstruments?: readonly ResearchSubjectInstrument[];
  readonly predictionProxySymbol?: string;
  readonly sources?: readonly ResearchSubjectSource[];
  readonly supportedSubjects?: readonly ResearchSubjectSummary[];
  readonly closestMatch?: ResearchSubjectSummary;
}

export function cleanResearchProxySymbol(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized === "" ? undefined : normalized;
}
