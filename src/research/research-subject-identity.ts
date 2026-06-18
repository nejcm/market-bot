import type { ResearchCommand } from "../cli/args";
import type { ResearchReport } from "../domain/types";
import { isRecord, readString } from "../sources/guards";

export interface ResearchSubjectIdentity {
  readonly subjectKey?: string;
  readonly predictionProxySymbol?: string;
}

export function cleanResearchSubjectKey(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "" ? undefined : normalized;
}

export function cleanResearchProxySymbol(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized === "" ? undefined : normalized;
}

export function commandResearchSubjectIdentity(command: ResearchCommand): ResearchSubjectIdentity {
  if (command.jobType !== "research") {
    return {};
  }
  const subjectKey = cleanResearchSubjectKey(command.subjectKey);
  const predictionProxySymbol = cleanResearchProxySymbol(command.predictionProxySymbol);
  return {
    ...(subjectKey !== undefined ? { subjectKey } : {}),
    ...(predictionProxySymbol !== undefined ? { predictionProxySymbol } : {}),
  };
}

export function researchIdentityExtras(command: ResearchCommand): Record<string, unknown> {
  if (command.jobType !== "research") {
    return {};
  }
  const identity = commandResearchSubjectIdentity(command);
  return {
    researchSubject: {
      input: command.subject,
      ...(identity.subjectKey !== undefined ? { subjectKey: identity.subjectKey } : {}),
    },
    ...(identity.predictionProxySymbol !== undefined
      ? { proxyResolution: { predictionProxySymbol: identity.predictionProxySymbol } }
      : {}),
  };
}

export function reportResearchSubjectIdentity(report: ResearchReport): ResearchSubjectIdentity {
  if (report.jobType !== "research" || !isRecord(report.extras)) {
    return {};
  }
  const { researchSubject, proxyResolution } = report.extras;
  const subjectKey = isRecord(researchSubject)
    ? cleanResearchSubjectKey(readString(researchSubject, "subjectKey"))
    : undefined;
  const predictionProxySymbol = isRecord(proxyResolution)
    ? cleanResearchProxySymbol(readString(proxyResolution, "predictionProxySymbol"))
    : undefined;
  return {
    ...(subjectKey !== undefined ? { subjectKey } : {}),
    ...(predictionProxySymbol !== undefined ? { predictionProxySymbol } : {}),
  };
}

// Two identities match when either the subject key or the prediction proxy
// Symbol agrees. This relies on prediction proxies being unique per subject in
// The registry (see DEFAULT_RESEARCH_SUBJECT_REGISTRY): two distinct subjects
// Must not share a proxy, or this would conflate their cross-run history.
export function isSameResearchSubjectIdentity(
  current: ResearchSubjectIdentity,
  prior: ResearchSubjectIdentity,
): boolean {
  return (
    (current.subjectKey !== undefined && current.subjectKey === prior.subjectKey) ||
    (current.predictionProxySymbol !== undefined &&
      current.predictionProxySymbol === prior.predictionProxySymbol)
  );
}
