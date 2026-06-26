import { isInstrumentCommand, type InstrumentCommand, type ResearchCommand } from "../cli/args";
import { sourceGap } from "../domain/source-gaps";
import type { ExtendedEvidence, Source, SourceGap } from "../domain/types";
import { scanWebCompanyProfileRunArtifacts } from "../run-artifacts";
import {
  buildWebCompanyProfileReuseEvidence,
  type WebCompanyProfileArtifact,
} from "../sources/extended-evidence/web-company-profile";
import type { CollectedSources } from "../sources/types";

export interface WebCompanyProfileReuse {
  readonly profile: WebCompanyProfileArtifact;
  readonly sources: readonly Source[];
  readonly gap: SourceGap;
  readonly runDirName: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
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

export async function findReusableWebCompanyProfile(input: {
  readonly dataDir: string;
  readonly command: ResearchCommand;
  readonly now: Date;
  readonly reuseDays: number;
  readonly currentSecFilingDate?: string;
}): Promise<WebCompanyProfileReuse | undefined> {
  const { command, currentSecFilingDate } = input;
  if (
    !isInstrumentCommand(command) ||
    command.assetClass !== "equity" ||
    command.depth !== "deep" ||
    currentSecFilingDate === undefined
  ) {
    return;
  }
  const reusableArtifacts = await scanWebCompanyProfileRunArtifacts(input.dataDir, {
    symbol: command.symbol,
    depth: "deep",
  });
  const candidates = reusableArtifacts.toSorted((left, right) =>
    right.report.generatedAt.localeCompare(left.report.generatedAt),
  );

  for (const artifact of candidates) {
    const profile = artifact.webCompanyProfile;
    if (
      profile === undefined ||
      !isReusableProfile(profile, {
        command,
        now: input.now,
        reuseDays: input.reuseDays,
        currentSecFilingDate,
      })
    ) {
      continue;
    }
    const sources = resolvedProfileSources(profile, artifact.report.sources);
    if (sources === undefined) {
      continue;
    }
    const ageDays = Math.floor(
      (input.now.getTime() - new Date(profile.generatedAt).getTime()) / MS_PER_DAY,
    );
    return {
      profile,
      sources,
      gap: sourceGap({
        source: "web-company-profile",
        message: `Reused web company profile from ${profile.generatedAt} (${String(ageDays)} days old); latest SEC filing basis ${currentSecFilingDate}.`,
        provider: "market-bot",
        capability: "extended-evidence",
        cause: "stale-fallback",
        evidenceQualityImpact: "extended-evidence-cap",
      }),
      runDirName: artifact.runDirName,
    };
  }
}

export function attachReusableWebCompanyProfile(input: {
  readonly command: InstrumentCommand;
  readonly collectedSources: CollectedSources;
  readonly reuse: WebCompanyProfileReuse;
}): CollectedSources {
  const result = buildWebCompanyProfileReuseEvidence({
    command: input.command,
    artifact: input.reuse.profile,
    extendedEvidence: input.collectedSources.extendedEvidence,
    freshnessGap: input.reuse.gap,
  });
  return {
    ...input.collectedSources,
    extendedSources: mergeSources(input.collectedSources.extendedSources, input.reuse.sources),
    ...(result.extendedEvidence !== undefined ? { extendedEvidence: result.extendedEvidence } : {}),
    webCompanyProfile: input.reuse.profile,
    sourceGaps: [...input.collectedSources.sourceGaps, ...result.sourceGaps],
  };
}

function isReusableProfile(
  profile: WebCompanyProfileArtifact,
  input: {
    readonly command: InstrumentCommand;
    readonly now: Date;
    readonly reuseDays: number;
    readonly currentSecFilingDate: string;
  },
): boolean {
  if (
    profile.sourceIds.length === 0 ||
    profile.symbol.toUpperCase() !== input.command.symbol.toUpperCase() ||
    profile.secFilingBasisDate === undefined ||
    !ISO_DATE_RE.test(profile.secFilingBasisDate) ||
    profile.secFilingBasisDate < input.currentSecFilingDate
  ) {
    return false;
  }
  const generatedAtMs = new Date(profile.generatedAt).getTime();
  const nowMs = input.now.getTime();
  if (!Number.isFinite(generatedAtMs) || generatedAtMs > nowMs) {
    return false;
  }
  return nowMs - generatedAtMs <= input.reuseDays * MS_PER_DAY;
}

function resolvedProfileSources(
  profile: WebCompanyProfileArtifact,
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
