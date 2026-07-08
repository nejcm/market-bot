import { isInstrumentCommand, type ResearchCommand } from "../cli/args";
import type { AppConfig } from "../config";
import type { SourceGap } from "../domain/types";
import type { CollectedSources, FetchLike } from "../sources/types";
import {
  buildWebSubjectProfileEvidence,
  buildWebSubjectProfileFailureEvidence,
  isCompanyProfileSecSource,
  webSubjectProfileSubjectForCommand,
} from "../sources/extended-evidence/web-subject-profile";
import { reconcileBusinessFramework } from "../sources/extended-evidence/business-framework-reconcile";
import type { StageOutput } from "./final-synthesis";
import type { ResearchContext } from "./research-context";
import { commandWithResolvedResearchSubject } from "./research-subject-identity";
import { isWebGatherLoopEnabled, runWebGatherLoop } from "./web-gather-loop";
import {
  attachReusableWebSubjectProfile,
  findReusableWebSubjectProfile,
  latestSecFilingDate,
  type WebSubjectProfileReuse,
} from "./web-subject-profile-reuse";

function reusedProfileCoverage(
  reuse: WebSubjectProfileReuse,
): NonNullable<ResearchContext["webGather"]>["reusedProfileCoverage"] {
  return {
    present: true,
    topics: Object.entries(reuse.profile.questions)
      .filter(([, answer]) => answer.sourceIds.length > 0)
      .map(([topic]) => topic)
      .toSorted(),
  };
}

interface WebEvidencePhaseInput {
  readonly command: ResearchCommand;
  readonly config: AppConfig;
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly generatedAt: string;
  readonly now: Date;
  readonly fetchImpl?: FetchLike;
  readonly retryDelaysMs?: readonly number[];
  readonly generateStage: (
    stage: "web-gather" | "web-subject-profile",
    collectedSources: CollectedSources,
    context: ResearchContext,
    priorStages?: readonly StageOutput[],
  ) => Promise<StageOutput>;
}

async function runWebSubjectProfileExtraction(input: {
  readonly phaseInput: WebEvidencePhaseInput;
  readonly collectedSources: CollectedSources;
  readonly secFilingBasisDate?: string;
}): Promise<{
  readonly collectedSources: CollectedSources;
  readonly output?: StageOutput;
}> {
  const profileCommand = commandWithResolvedResearchSubject(
    input.phaseInput.command,
    input.collectedSources.resolvedSubject,
  );
  const webSources = input.collectedSources.extendedSources.filter(
    (source) => source.kind === "web",
  );
  const subject = webSubjectProfileSubjectForCommand(profileCommand);
  if (subject === undefined) {
    return { collectedSources: input.collectedSources };
  }
  const secSources =
    subject.subjectKind === "company"
      ? input.collectedSources.extendedSources.filter(isCompanyProfileSecSource)
      : [];
  const allowedSources = [...webSources, ...secSources];
  if (allowedSources.length === 0) {
    return { collectedSources: input.collectedSources };
  }
  try {
    const output = await input.phaseInput.generateStage(
      "web-subject-profile",
      input.collectedSources,
      input.phaseInput.context,
    );
    const result = buildWebSubjectProfileEvidence({
      command: profileCommand,
      subject,
      generatedAt: input.phaseInput.generatedAt,
      modelContent: output.content,
      webSources: allowedSources,
      extendedEvidence: input.collectedSources.extendedEvidence,
      ...(subject.subjectKind === "company" && input.secFilingBasisDate !== undefined
        ? { secFilingBasisDate: input.secFilingBasisDate }
        : {}),
    });
    return {
      collectedSources: {
        ...input.collectedSources,
        ...(result.extendedEvidence !== undefined
          ? { extendedEvidence: result.extendedEvidence }
          : {}),
        ...(result.artifact !== undefined ? { webSubjectProfile: result.artifact } : {}),
        sourceGaps: [...input.collectedSources.sourceGaps, ...result.sourceGaps],
      },
      output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = buildWebSubjectProfileFailureEvidence({
      command: profileCommand,
      subject,
      generatedAt: input.phaseInput.generatedAt,
      message: `Web Subject Profile stage failed (${message})`,
      cause: "malformed-response",
      extendedEvidence: input.collectedSources.extendedEvidence,
      ...(subject.subjectKind === "company" && input.secFilingBasisDate !== undefined
        ? { secFilingBasisDate: input.secFilingBasisDate }
        : {}),
    });
    return {
      collectedSources: {
        ...input.collectedSources,
        ...(result.extendedEvidence !== undefined
          ? { extendedEvidence: result.extendedEvidence }
          : {}),
        ...(result.artifact !== undefined ? { webSubjectProfile: result.artifact } : {}),
        sourceGaps: [...input.collectedSources.sourceGaps, ...result.sourceGaps],
      },
    };
  }
}

export function reconcileBusinessFrameworkEvidence(
  collectedSources: CollectedSources,
): CollectedSources {
  const framework = collectedSources.businessFramework;
  const profile = collectedSources.webSubjectProfile;
  if (framework === undefined || profile === undefined || profile.sourceIds.length === 0) {
    return collectedSources;
  }
  const result = reconcileBusinessFramework(framework, profile);
  if (result.artifact === framework) {
    return collectedSources;
  }
  const replaceGap = (gaps: readonly SourceGap[]): readonly SourceGap[] => {
    const kept = gaps.filter((gap) => gap.source !== "business-framework");
    return result.sourceGap !== undefined ? [...kept, result.sourceGap] : kept;
  };
  const extendedEvidence =
    collectedSources.extendedEvidence === undefined
      ? undefined
      : {
          ...collectedSources.extendedEvidence,
          gaps: replaceGap(collectedSources.extendedEvidence.gaps),
        };
  return {
    ...collectedSources,
    businessFramework: result.artifact,
    sourceGaps: replaceGap(collectedSources.sourceGaps),
    ...(extendedEvidence !== undefined ? { extendedEvidence } : {}),
  };
}

export async function runWebEvidencePhase(input: WebEvidencePhaseInput): Promise<{
  readonly collectedSources: CollectedSources;
  readonly webGatherLoop: Awaited<ReturnType<typeof runWebGatherLoop>>;
  readonly webSubjectProfile?: Awaited<ReturnType<typeof runWebSubjectProfileExtraction>>;
}> {
  let { collectedSources } = input;
  const currentSecFilingDate = latestSecFilingDate(collectedSources.extendedEvidence);
  let webGatherLoop: Awaited<ReturnType<typeof runWebGatherLoop>> = {
    collectedSources,
    stageOutputs: [],
  };
  let webSubjectProfile: Awaited<ReturnType<typeof runWebSubjectProfileExtraction>> | undefined =
    undefined;
  const webGatherEnabled = isWebGatherLoopEnabled(input.command, input.config);
  const secOnlyCompanyProfile =
    !webGatherEnabled &&
    isInstrumentCommand(input.command) &&
    input.command.assetClass === "equity" &&
    input.command.depth === "deep" &&
    collectedSources.extendedSources.some(isCompanyProfileSecSource);

  if (webGatherEnabled) {
    const profileCommand = commandWithResolvedResearchSubject(
      input.command,
      collectedSources.resolvedSubject,
    );
    const reusableWebSubjectProfile = await findReusableWebSubjectProfile({
      dataDir: input.config.dataDir,
      command: profileCommand,
      now: input.now,
      reuseDaysBySubjectKind: input.config.webProfileReuseDaysBySubjectKind,
      ...(currentSecFilingDate !== undefined ? { currentSecFilingDate } : {}),
    });
    if (reusableWebSubjectProfile !== undefined) {
      collectedSources = attachReusableWebSubjectProfile({
        command: profileCommand,
        collectedSources,
        reuse: reusableWebSubjectProfile,
      });
      webGatherLoop = await runWebGatherLoop({
        command: profileCommand,
        config: input.config,
        collectedSources,
        context: input.context,
        now: input.now,
        reusedProfileCoverage: reusedProfileCoverage(reusableWebSubjectProfile),
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
        ...(input.retryDelaysMs !== undefined ? { retryDelaysMs: input.retryDelaysMs } : {}),
        generateRound: (currentSources, roundContext, priorStages) =>
          input.generateStage("web-gather", currentSources, roundContext, priorStages) as Promise<
            StageOutput & { readonly stage: "web-gather" }
          >,
      });
      ({ collectedSources } = webGatherLoop);
    } else {
      webGatherLoop = await runWebGatherLoop({
        command: profileCommand,
        config: input.config,
        collectedSources,
        context: input.context,
        now: input.now,
        ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
        ...(input.retryDelaysMs !== undefined ? { retryDelaysMs: input.retryDelaysMs } : {}),
        generateRound: (currentSources, roundContext, priorStages) =>
          input.generateStage("web-gather", currentSources, roundContext, priorStages) as Promise<
            StageOutput & { readonly stage: "web-gather" }
          >,
      });
      ({ collectedSources } = webGatherLoop);
      webSubjectProfile = await runWebSubjectProfileExtraction({
        phaseInput: input,
        collectedSources,
        ...(currentSecFilingDate !== undefined ? { secFilingBasisDate: currentSecFilingDate } : {}),
      });
      ({ collectedSources } = webSubjectProfile);
    }
    collectedSources = reconcileBusinessFrameworkEvidence(collectedSources);
  } else {
    webGatherLoop = await runWebGatherLoop({
      command: input.command,
      config: input.config,
      collectedSources,
      context: input.context,
      now: input.now,
      ...(input.fetchImpl !== undefined ? { fetchImpl: input.fetchImpl } : {}),
      ...(input.retryDelaysMs !== undefined ? { retryDelaysMs: input.retryDelaysMs } : {}),
      generateRound: (currentSources, roundContext, priorStages) =>
        input.generateStage("web-gather", currentSources, roundContext, priorStages) as Promise<
          StageOutput & { readonly stage: "web-gather" }
        >,
    });
    ({ collectedSources } = webGatherLoop);
  }

  if (!webGatherEnabled && secOnlyCompanyProfile) {
    webSubjectProfile = await runWebSubjectProfileExtraction({
      phaseInput: input,
      collectedSources,
      ...(currentSecFilingDate !== undefined ? { secFilingBasisDate: currentSecFilingDate } : {}),
    });
    ({ collectedSources } = webSubjectProfile);
    collectedSources = reconcileBusinessFrameworkEvidence(collectedSources);
  }

  return {
    collectedSources,
    webGatherLoop,
    ...(webSubjectProfile !== undefined ? { webSubjectProfile } : {}),
  };
}
