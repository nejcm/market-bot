import { type ResearchCommand } from "../cli/args";
import { DAY_MS } from "../config/shared";
import { sourceGap } from "../domain/source-gaps";
import type {
  ExtendedEvidence,
  Source,
  SourceGap,
  SubjectKind,
  WebEvidenceUtilizationLevel,
  WebGatherAcceptancePolicy,
} from "../domain/types";
import { isRecord } from "../guards";
import { scanWebSubjectProfileRunArtifacts } from "../run-artifacts";
import {
  buildWebSubjectProfileReuseEvidence,
  type WebSubjectProfileArtifact,
  webSubjectProfileSubjectForCommand,
} from "./web-subject-profile";
import type { CollectedSources } from "../sources/types";
import { roundWebSubjectProfileAgeDays } from "./web-subject-profile-age";
import { classifyWebEvidenceUtilization } from "./web-source-usage";

export interface WebSubjectProfileReuse {
  readonly profile: WebSubjectProfileArtifact;
  readonly sources: readonly Source[];
  readonly gap: SourceGap;
  readonly runDirName: string;
  readonly priorUtilizationLevel?: WebEvidenceUtilizationLevel;
  readonly priorUtilizationRatio?: number;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

interface PriorWebEvidenceUtilization {
  readonly level: WebEvidenceUtilizationLevel;
  readonly ratio: number;
}

export function latestSecFilingDate(evidence: ExtendedEvidence | undefined): string | undefined {
  const filingDates = (evidence?.items ?? [])
    .filter(
      (item) =>
        item.category === "sec-edgar" &&
        (item.metrics?.form === "10-K" || item.metrics?.form === "10-Q"),
    )
    .map((item) =>
      typeof item.metrics?.filingDate === "string" ? item.metrics.filingDate : undefined,
    )
    .filter((date): date is string => date !== undefined && ISO_DATE_RE.test(date))
    .toSorted((left, right) => right.localeCompare(left));
  return filingDates[0];
}

export async function findReusableWebSubjectProfile(input: {
  readonly dataDir: string;
  readonly command: ResearchCommand;
  readonly now: Date;
  readonly reuseDaysBySubjectKind: Readonly<Record<SubjectKind, number>>;
  readonly currentSecFilingDate?: string;
}): Promise<WebSubjectProfileReuse | undefined> {
  const subject = webSubjectProfileSubjectForCommand(input.command);
  if (
    subject === undefined ||
    (subject.subjectKind !== "theme" && input.command.depth !== "deep")
  ) {
    return;
  }
  if (subject.subjectKind === "company" && input.currentSecFilingDate === undefined) {
    return;
  }
  const reusableArtifacts = await scanWebSubjectProfileRunArtifacts(input.dataDir, {
    subjectKind: subject.subjectKind,
    subjectId: subject.subjectId,
    depth: input.command.depth,
  });
  const candidates = reusableArtifacts.toSorted((left, right) =>
    right.report.generatedAt.localeCompare(left.report.generatedAt),
  );

  for (const artifact of candidates) {
    const profile = artifact.webSubjectProfile;
    if (
      !isReusableProfile(profile, {
        subjectId: subject.subjectId,
        now: input.now,
        reuseDays: input.reuseDaysBySubjectKind[subject.subjectKind],
        ...(input.currentSecFilingDate !== undefined
          ? { currentSecFilingDate: input.currentSecFilingDate }
          : {}),
      })
    ) {
      continue;
    }
    const sources = resolvedProfileSources(profile, artifact.report.sources);
    if (sources === undefined) {
      continue;
    }
    const ageDays = roundWebSubjectProfileAgeDays(
      (input.now.getTime() - new Date(profile.generatedAt).getTime()) / DAY_MS,
    );
    const filingSuffix =
      profile.subjectKind === "company" && input.currentSecFilingDate !== undefined
        ? `; latest SEC filing basis ${input.currentSecFilingDate}`
        : "";
    const priorUtilization = readPriorWebEvidenceUtilization(
      artifact.analytics,
      artifact.report.runId,
    );
    return {
      profile,
      sources,
      gap: sourceGap({
        source: "web-subject-profile",
        message: `Reused web subject profile from ${profile.generatedAt} (${ageDays.toFixed(1)} days old)${filingSuffix}.`,
        provider: "market-bot",
        capability: "extended-evidence",
        cause: "stale-fallback",
        evidenceQualityImpact: "extended-evidence-cap",
      }),
      runDirName: artifact.runDirName,
      ...(priorUtilization !== undefined
        ? {
            priorUtilizationLevel: priorUtilization.level,
            priorUtilizationRatio: priorUtilization.ratio,
          }
        : {}),
    };
  }
}

export function webGatherAcceptancePolicyForReuse(
  reuse: WebSubjectProfileReuse,
): WebGatherAcceptancePolicy {
  const afterLowUtilization = reuse.priorUtilizationLevel === "low";
  return {
    version: 1,
    mode: afterLowUtilization ? "reused-profile-after-low-utilization" : "reused-profile-default",
    sourceRunDirName: reuse.runDirName,
    ...(reuse.priorUtilizationLevel !== undefined
      ? { priorUtilizationLevel: reuse.priorUtilizationLevel }
      : {}),
    ...(reuse.priorUtilizationRatio !== undefined
      ? { priorUtilizationRatio: reuse.priorUtilizationRatio }
      : {}),
    implicitPerQueryAcceptanceCap: afterLowUtilization ? 2 : 3,
  };
}

export function attachReusableWebSubjectProfile(input: {
  readonly command: ResearchCommand;
  readonly collectedSources: CollectedSources;
  readonly reuse: WebSubjectProfileReuse;
}): CollectedSources {
  const subject = webSubjectProfileSubjectForCommand(input.command);
  if (subject === undefined) {
    return input.collectedSources;
  }
  const result = buildWebSubjectProfileReuseEvidence({
    command: input.command,
    subject,
    artifact: input.reuse.profile,
    extendedEvidence: input.collectedSources.extendedEvidence,
    freshnessGap: input.reuse.gap,
  });
  return {
    ...input.collectedSources,
    extendedSources: mergeSources(input.collectedSources.extendedSources, input.reuse.sources),
    ...(result.extendedEvidence !== undefined ? { extendedEvidence: result.extendedEvidence } : {}),
    webSubjectProfile: input.reuse.profile,
    webSubjectProfileReuse: {
      runDirName: input.reuse.runDirName,
      generatedAt: input.reuse.profile.generatedAt,
    },
    sourceGaps: [...input.collectedSources.sourceGaps, ...result.sourceGaps],
  };
}

function isReusableProfile(
  profile: WebSubjectProfileArtifact,
  input: {
    readonly subjectId: string;
    readonly now: Date;
    readonly reuseDays: number;
    readonly currentSecFilingDate?: string;
  },
): boolean {
  if (
    profile.sourceIds.length === 0 ||
    profile.subjectId.toUpperCase() !== input.subjectId.toUpperCase()
  ) {
    return false;
  }
  if (
    profile.subjectKind === "company" &&
    (profile.version !== 3 ||
      input.currentSecFilingDate === undefined ||
      profile.secFilingBasisDate === undefined ||
      !ISO_DATE_RE.test(profile.secFilingBasisDate) ||
      profile.secFilingBasisDate < input.currentSecFilingDate)
  ) {
    return false;
  }
  const generatedAtMs = new Date(profile.generatedAt).getTime();
  const nowMs = input.now.getTime();
  if (!Number.isFinite(generatedAtMs) || generatedAtMs > nowMs) {
    return false;
  }
  return nowMs - generatedAtMs <= input.reuseDays * DAY_MS;
}

function resolvedProfileSources(
  profile: WebSubjectProfileArtifact,
  sources: readonly Source[],
): readonly Source[] | undefined {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const resolved = profile.sourceIds.map((sourceId) => byId.get(sourceId));
  return resolved.every((source): source is Source => source !== undefined) ? resolved : undefined;
}

function mergeSources(existing: readonly Source[], reused: readonly Source[]): readonly Source[] {
  const byId = new Map<string, Source>();
  for (const source of [...existing, ...reused]) {
    byId.set(source.id, source);
  }
  return [...byId.values()];
}

function readPriorWebEvidenceUtilization(
  analytics: unknown,
  expectedRunId: string,
): PriorWebEvidenceUtilization | undefined {
  if (!isRecord(analytics) || analytics.runId !== expectedRunId) {
    return undefined;
  }
  if (analytics.version !== undefined && analytics.version !== 1 && analytics.version !== 2) {
    return undefined;
  }
  if ("webEvidenceUtilization" in analytics) {
    return readVersionedWebEvidenceUtilization(analytics.webEvidenceUtilization);
  }
  return readLegacyWebEvidenceUtilization(analytics.webSources);
}

function readVersionedWebEvidenceUtilization(
  value: unknown,
): PriorWebEvidenceUtilization | undefined {
  if (!isRecord(value) || value.version !== 1) {
    return undefined;
  }
  const countKeys = [
    "acceptedCurrentRun",
    "usedCurrentRun",
    "profileUsed",
    "primaryReportCited",
    "structuredExtraCited",
    "unusedCurrentRun",
  ] as const;
  if (
    countKeys.some((key) => !Number.isSafeInteger(value[key]) || (value[key] as number) < 0) ||
    typeof value.ratio !== "number" ||
    !Number.isFinite(value.ratio) ||
    value.ratio < 0 ||
    value.ratio > 1
  ) {
    return undefined;
  }
  const accepted = value.acceptedCurrentRun as number;
  const used = value.usedCurrentRun as number;
  const profileUsed = value.profileUsed as number;
  const primaryReportCited = value.primaryReportCited as number;
  const structuredExtraCited = value.structuredExtraCited as number;
  const unusedCurrentRun = value.unusedCurrentRun as number;
  const expectedRatio = accepted === 0 ? 0 : used / accepted;
  const expectedLevel = classifyWebEvidenceUtilization(accepted, expectedRatio);
  if (
    used > accepted ||
    profileUsed > used ||
    primaryReportCited > used ||
    structuredExtraCited > used ||
    unusedCurrentRun !== accepted - used ||
    value.ratio !== expectedRatio ||
    value.level !== expectedLevel
  ) {
    return undefined;
  }
  return { level: expectedLevel, ratio: expectedRatio };
}

function readLegacyWebEvidenceUtilization(value: unknown): PriorWebEvidenceUtilization | undefined {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.accepted) ||
    (value.accepted as number) < 0 ||
    typeof value.usageRatio !== "number" ||
    !Number.isFinite(value.usageRatio) ||
    value.usageRatio < 0 ||
    value.usageRatio > 1
  ) {
    return undefined;
  }
  return {
    level: classifyWebEvidenceUtilization(value.accepted as number, value.usageRatio),
    ratio: value.usageRatio,
  };
}
