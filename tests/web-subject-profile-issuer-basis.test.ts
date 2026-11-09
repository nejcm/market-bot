import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InstrumentCommand } from "../src/cli/args";
import type { Source } from "../src/domain/sources";
import type { StageOutput } from "../src/research/final-synthesis";
import { readWebSubjectProfileArtifact } from "../src/run-artifact-evidence-reader";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";
import { runWebEvidencePhase } from "../src/web-evidence/web-evidence-phase";
import type { WebSubjectProfileArtifact } from "../src/web-evidence/web-subject-profile";
import {
  confirmIssuerReportReuse,
  findReusableWebSubjectProfile,
  latestIssuerReportDate,
  type WebSubjectProfileReuse,
} from "../src/web-evidence/web-subject-profile-reuse";
import { collectedSources, deepEquityEvidenceBundle } from "./support/fixtures";
import { config } from "./support/orchestrator-helpers";
import { researchContext } from "./support/research-context-helpers";

const command: InstrumentCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "0097.KL",
  depth: "deep",
};
const reuseDaysBySubjectKind = { company: 30, "crypto-asset": 7, theme: 7 } as const;

const profileSource: Source = {
  id: "web-0097.kl-profile",
  title: "ViTrox business profile",
  url: "https://example.com/vitrox",
  fetchedAt: "2026-10-20T00:00:00.000Z",
  kind: "web",
  provider: "exa",
};

function issuerReport(announced: string | undefined): Source {
  return {
    id: "web-0097.kl-klse",
    title: "VITROX - Quarterly rpt on consolidated results",
    url: "https://www.klsescreener.com/v2/announcements/view/11698017",
    fetchedAt: "2026-11-06T01:00:00.000Z",
    kind: "web",
    snippet: [
      "| | | CURRENT YEAR QUARTER | PRECEDING YEAR CORRESPONDING QUARTER |",
      "| --- | --- | --- | --- |",
      "| 1 | Revenue | 485,101 | 228,567 |",
      "",
      ...(announced === undefined ? [] : [`| Date Announced | ${announced} |`, "| --- | --- |"]),
    ].join("\n"),
  };
}

function nonSecProfile(
  input: { readonly issuerReportBasisDate?: string; readonly secFilingBasisDate?: string } = {},
): Extract<WebSubjectProfileArtifact, { readonly subjectKind: "company" }> {
  const answer = { answer: "ViTrox builds machine vision systems.", sourceIds: [profileSource.id] };
  return {
    version: 3,
    generatedAt: "2026-10-20T00:00:00.000Z",
    originRunDirName: "prior-vitrox",
    subjectKind: "company",
    subjectId: "0097.KL",
    symbol: "0097.KL",
    subjectSummary: answer,
    questions: {
      whatItDoes: answer,
      howItMakesMoney: answer,
      customers: answer,
      geography: answer,
      purchaseRecurrence: answer,
      pricingPower: answer,
      recessionCyclicality: answer,
      managementTrackRecord: answer,
      capitalAllocation: answer,
      companyKpis: answer,
      riskFactors: answer,
    },
    recentMaterialEvents: [],
    factLedger: [{ claim: answer.answer, sourceIds: answer.sourceIds }],
    openGaps: [],
    sourceIds: [profileSource.id],
    ...input,
  };
}

const tmpDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function write(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

async function priorRunDir(artifact: WebSubjectProfileArtifact): Promise<string> {
  const root = join(tmpdir(), `market-bot-issuer-basis-${Math.random().toString(16).slice(2)}`);
  tmpDirs.push(root);
  const dataDir = join(root, "runs");
  const runDir = join(dataDir, "prior-vitrox");
  await write(join(runDir, "report.json"), {
    runId: "prior-vitrox",
    jobType: "equity",
    assetClass: "equity",
    symbol: "0097.KL",
    generatedAt: artifact.generatedAt,
    summary: "Prior profile run.",
    keyFindings: [],
    bullCase: [],
    bearCase: [],
    risks: [],
    catalysts: [],
    scenarios: [],
    confidence: "medium",
    dataGaps: [],
    predictions: [],
    sources: [profileSource],
    notFinancialAdvice: true,
    extras: { depth: "deep" },
  });
  const base = deepEquityEvidenceBundle();
  await write(
    join(runDir, RUN_ARTIFACT_FILES.evidenceBundle),
    deepEquityEvidenceBundle({
      run: { symbol: "0097.KL", analysisAsOf: artifact.generatedAt },
      evidence: {
        ...base.evidence,
        extendedSources: [profileSource],
        webSubjectProfile: artifact,
      },
      governance: {
        ...base.governance,
        sourcePlan: {
          ...base.governance.sourcePlan,
          generatedAt: artifact.generatedAt,
          run: { jobType: "equity", assetClass: "equity", symbol: "0097.KL", depth: "deep" },
        },
        evidenceLanes: { ...base.governance.evidenceLanes, generatedAt: artifact.generatedAt },
        sourceLedger: {
          version: 2,
          generatedAt: artifact.generatedAt,
          sources: [
            {
              id: profileSource.id,
              kind: profileSource.kind,
              lane: "subject-profile",
              posture: "covered",
              relatedGapIds: [],
              fetchedAt: profileSource.fetchedAt,
            },
          ],
        },
      },
      context: {
        historicalContext: { ...base.context.historicalContext, generatedAt: artifact.generatedAt },
      },
    }),
  );
  return dataDir;
}

function withSource(source: Source) {
  return collectedSources({ extendedSources: [source] });
}

function reuseOf(artifact: WebSubjectProfileArtifact): WebSubjectProfileReuse {
  return {
    profile: artifact,
    withheldGaps: [],
    sources: [profileSource],
    gap: {
      source: "web-subject-profile",
      message: "Reused web subject profile from 2026-10-20T00:00:00.000Z (17.0 days old).",
    },
    runDirName: "prior-vitrox",
    ageDays: 17,
  };
}

describe("issuer report basis date", () => {
  test("reads only a stated announcement date from issuer report pages", () => {
    expect(latestIssuerReportDate(command, withSource(issuerReport("05 Nov 2026")))).toBe(
      "2026-11-05",
    );
    expect(latestIssuerReportDate(command, withSource(issuerReport(undefined)))).toBeUndefined();
    expect(
      latestIssuerReportDate(
        { ...command, symbol: "AAPL" },
        withSource(issuerReport("05 Nov 2026")),
      ),
    ).toBeUndefined();
  });

  test("reads announcement dates beyond the four newest-fetched report pages", () => {
    const pages = ["01 Oct 2026", "02 Oct 2026", "03 Oct 2026", "04 Oct 2026"].map(
      (announced, index) => ({
        ...issuerReport(announced),
        id: `web-0097.kl-klse-${String(index)}`,
        url: `https://www.klsescreener.com/v2/announcements/view/${String(index)}`,
        fetchedAt: `2026-11-06T0${String(index + 1)}:00:00.000Z`,
      }),
    );
    const oldestFetchedNewest = {
      ...issuerReport("05 Nov 2026"),
      fetchedAt: "2026-11-01T00:00:00.000Z",
    };
    expect(
      latestIssuerReportDate(
        command,
        collectedSources({ extendedSources: [...pages, oldestFetchedNewest] }),
      ),
    ).toBe("2026-11-05");
  });

  test("sidecar reader keeps the issuer report basis date", () => {
    const artifact = nonSecProfile({ issuerReportBasisDate: "2026-10-15" });
    expect(readWebSubjectProfileArtifact(structuredClone(artifact))).toMatchObject({
      issuerReportBasisDate: "2026-10-15",
    });
  });

  test("offers a non-SEC profile provisionally only for a non-SEC listing", async () => {
    const dataDir = await priorRunDir(nonSecProfile({ issuerReportBasisDate: "2026-10-15" }));
    const find = (nonSecListing: boolean) =>
      findReusableWebSubjectProfile({
        dataDir,
        command,
        now: new Date("2026-11-06T00:00:00.000Z"),
        reuseDaysBySubjectKind,
        ...(nonSecListing ? { nonSecListing } : {}),
      });

    const reuse = await find(true);
    expect(reuse?.runDirName).toBe("prior-vitrox");
    expect(reuse?.gap.message).toBe(
      "Reused web subject profile from 2026-10-20T00:00:00.000Z (17.0 days old).",
    );
    expect(await find(false)).toBeUndefined();
  });

  test("never reuses an SEC-basis profile age-only when this run has no SEC filing", async () => {
    const dataDir = await priorRunDir(nonSecProfile({ secFilingBasisDate: "2026-10-01" }));
    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-11-06T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      nonSecListing: true,
    });
    expect(reuse).toBeUndefined();
  });

  test("keeps the reuse when no issuer report is newer than the profile basis", () => {
    const check = confirmIssuerReportReuse(
      reuseOf(nonSecProfile({ issuerReportBasisDate: "2026-11-05" })),
      [],
      "2026-11-05",
    );
    expect("reuse" in check && check.reuse.gap.message).toBe(
      "Reused web subject profile from 2026-10-20T00:00:00.000Z (17.0 days old); latest issuer report 2026-11-05 is not newer than the profile basis 2026-11-05.",
    );
  });

  test("discards the reuse when a newer issuer report was found", () => {
    expect(
      confirmIssuerReportReuse(
        reuseOf(nonSecProfile({ issuerReportBasisDate: "2026-08-20" })),
        [],
        "2026-11-05",
      ),
    ).toEqual({
      discardReason:
        "Provisional reuse of prior-vitrox discarded: issuer report announced 2026-11-05 is newer than the profile basis 2026-08-20.",
    });
  });

  test("regenerates a profile with no basis date once a dated issuer report is found", () => {
    // Announced before the profile was generated, but nothing proves the profile read it.
    expect(confirmIssuerReportReuse(reuseOf(nonSecProfile()), [], "2026-10-19")).toEqual({
      discardReason:
        "Provisional reuse of prior-vitrox discarded: issuer report announced 2026-10-19 found, but the profile records no issuer report basis.",
    });
  });

  test("falls back to age-only reuse and says so when no dated issuer report is found", () => {
    const check = confirmIssuerReportReuse(reuseOf(nonSecProfile()), [], undefined);
    expect("reuse" in check && check.reuse.gap.message).toBe(
      "Reused web subject profile from 2026-10-20T00:00:00.000Z (17.0 days old); no dated issuer report found, so reuse rests on profile age only.",
    );
  });

  test("discards the reuse when the gather re-collected a cited Source with new text", () => {
    const cited = { ...profileSource, snippet: "Old text." };
    const reuse = { ...reuseOf(nonSecProfile()), sources: [cited] };
    expect(
      confirmIssuerReportReuse(reuse, [{ ...cited, snippet: "New text." }], undefined),
    ).toMatchObject({ discardReason: expect.stringContaining("changed text") });
    expect("reuse" in confirmIssuerReportReuse(reuse, [cited], undefined)).toBe(true);
  });
});

describe("Web Evidence phase for a non-SEC listing", () => {
  async function runPhase(dataDir: string, sources: readonly Source[]) {
    const stages: string[] = [];
    const result = await runWebEvidencePhase({
      command,
      config: {
        ...config,
        dataDir,
        sourceOptions: { ...config.sourceOptions, exaApiKey: "exa-key" },
        webGatherOptions: { maxRounds: 1, maxToolCalls: 2, sourceBudget: 4 },
      },
      collectedSources: collectedSources({ extendedSources: sources }),
      context: researchContext(command),
      generatedAt: "2026-11-06T00:00:00.000Z",
      runId: "current-run",
      now: new Date("2026-11-06T00:00:00.000Z"),
      fetchImpl: async () => new Response("not found", { status: 404 }),
      retryDelaysMs: [],
      generateStage: async (stage, _sources, stageContext): Promise<StageOutput> => {
        stages.push(stage);
        if (stage === "web-gather") {
          // A provisional reuse must not narrow the gather the profile stage may still need.
          expect(stageContext.webGather?.reusedProfileCoverage).toBeUndefined();
        }
        return { stage, content: JSON.stringify({ requests: [] }), tokenEstimate: 1 };
      },
    });
    return { stages, result };
  }

  test("reuses after the gather when no newer issuer report was found", async () => {
    const dataDir = await priorRunDir(nonSecProfile({ issuerReportBasisDate: "2026-11-05" }));
    const { stages, result } = await runPhase(dataDir, [issuerReport("05 Nov 2026")]);

    expect(stages).toEqual(["web-gather"]);
    expect(result.collectedSources.webSubjectProfileReuse?.runDirName).toBe("prior-vitrox");
    expect(result.collectedSources.extendedSources.map((source) => source.id)).toContain(
      profileSource.id,
    );
    expect(result.profileReuse).toEqual({
      decision: "reused",
      reason:
        "Reused web subject profile from 2026-10-20T00:00:00.000Z (17.0 days old); latest issuer report 2026-11-05 is not newer than the profile basis 2026-11-05.",
    });
  });

  test("runs the profile stage with the new basis when a newer issuer report was found", async () => {
    const dataDir = await priorRunDir(nonSecProfile({ issuerReportBasisDate: "2026-08-20" }));
    const { stages, result } = await runPhase(dataDir, [issuerReport("05 Nov 2026")]);

    expect(stages).toEqual(["web-gather", "web-subject-profile"]);
    expect(result.webGatherLoop.audit).toBeDefined();
    expect(result.webGatherLoop.audit?.acceptancePolicy).toBeUndefined();
    expect(result.collectedSources.webSubjectProfileReuse).toBeUndefined();
    expect(result.collectedSources.webSubjectProfile).toMatchObject({
      issuerReportBasisDate: "2026-11-05",
    });
    expect(result.profileReuse).toEqual({
      decision: "regenerated",
      reason:
        "Provisional reuse of prior-vitrox discarded: issuer report announced 2026-11-05 is newer than the profile basis 2026-08-20.",
    });
  });

  test("records why no profile was reused when no candidate exists", async () => {
    const dataDir = await priorRunDir({ ...nonSecProfile(), subjectId: "OTHER", symbol: "OTHER" });
    const { stages, result } = await runPhase(dataDir, [issuerReport(undefined)]);

    expect(stages).toEqual(["web-gather", "web-subject-profile"]);
    expect(result.collectedSources.webSubjectProfile).not.toHaveProperty("issuerReportBasisDate");
    expect(result.profileReuse).toEqual({
      decision: "regenerated",
      reason: "No reusable Web Subject Profile for this subject, depth and reuse window.",
    });
  });
});
