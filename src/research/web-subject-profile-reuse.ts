import { type ResearchCommand } from "../cli/args";
import { DAY_MS } from "../config/shared";
import { sourceGap } from "../domain/source-gaps";
import type { ExtendedEvidence, Source, SourceGap, SubjectKind } from "../domain/types";
import { scanWebSubjectProfileRunArtifacts } from "../run-artifacts";
import {
  buildWebSubjectProfileReuseEvidence,
  type WebSubjectProfileArtifact,
  webSubjectProfileSubjectForCommand,
} from "../sources/extended-evidence/web-subject-profile";
import type { CollectedSources } from "../sources/types";
import { roundWebSubjectProfileAgeDays } from "./web-subject-profile-age";

export interface WebSubjectProfileReuse {
  readonly profile: WebSubjectProfileArtifact;
  readonly sources: readonly Source[];
  readonly gap: SourceGap;
  readonly runDirName: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;

export function latestSecFilingDate(evidence: ExtendedEvidence | undefined): string | undefined {
  const filingDates = (evidence?.items ?? [])
    .filter((item) => item.category === "sec-edgar")
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
    };
  }
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
