import type { ResearchCommand } from "../cli/args";
import type { ResearchReport } from "../domain/types";
import { isRecord, readString } from "../sources/guards";
import {
  resolveResearchSubjectProxy,
  type ResearchSubjectInstrument,
  type ResearchSubjectSource,
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

export function resolveResearchSubject(
  command: ResearchCommand,
): ResolvedResearchSubject | undefined {
  if (command.jobType !== "research") {
    return undefined;
  }
  const resolution = resolveResearchSubjectProxy(command.subject);
  return {
    input: resolution.input,
    normalizedInput: resolution.normalizedInput,
    status: resolution.status,
    canEmitPredictions: resolution.canEmitPredictions,
    reason: resolution.reason,
    ...(resolution.subject !== undefined
      ? {
          subjectKey: resolution.subject.subjectKey,
          displayName: resolution.subject.displayName,
          aliases: resolution.subject.aliases,
          representativeInstruments: resolution.subject.representativeInstruments,
          sources: resolution.subject.sources,
        }
      : {}),
    ...(resolution.predictionProxySymbol !== undefined
      ? { predictionProxySymbol: resolution.predictionProxySymbol }
      : {}),
  };
}

export function commandWithResolvedResearchSubject(
  command: ResearchCommand,
  resolvedSubject: ResolvedResearchSubject | undefined,
): ResearchCommand {
  if (command.jobType !== "research" || resolvedSubject?.status !== "resolved") {
    return command;
  }
  return {
    ...command,
    ...(resolvedSubject.subjectKey !== undefined ? { subjectKey: resolvedSubject.subjectKey } : {}),
    ...(resolvedSubject.predictionProxySymbol !== undefined
      ? { predictionProxySymbol: resolvedSubject.predictionProxySymbol }
      : {}),
  };
}

export function researchIdentityExtras(
  command: ResearchCommand,
  resolvedSubject?: ResolvedResearchSubject,
): Record<string, unknown> {
  if (command.jobType !== "research") {
    return {};
  }
  const identity = resolvedSubject ?? resolveResearchSubject(command);
  return {
    researchSubject: {
      input: command.subject,
      ...(identity?.normalizedInput !== undefined
        ? { normalizedInput: identity.normalizedInput }
        : {}),
      ...(identity?.status !== undefined ? { status: identity.status } : {}),
      ...(identity?.reason !== undefined ? { reason: identity.reason } : {}),
      ...(identity?.subjectKey !== undefined ? { subjectKey: identity.subjectKey } : {}),
      ...(identity?.displayName !== undefined ? { displayName: identity.displayName } : {}),
    },
    ...(identity?.predictionProxySymbol !== undefined
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
