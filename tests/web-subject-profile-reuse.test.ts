import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InstrumentCommand, ResearchCommand } from "../src/cli/args";
import {
  attachReusableWebSubjectProfile,
  findReusableWebSubjectProfile,
  latestSecFilingDate,
  webGatherAcceptancePolicyForReuse,
} from "../src/web-evidence/web-subject-profile-reuse";
import { readWebSubjectProfileArtifact } from "../src/run-artifact-evidence-reader";
import {
  buildWebSubjectProfileEvidence,
  normalizedSubjectId,
  type WebSubjectProfileArtifact,
} from "../src/web-evidence/web-subject-profile";
import { classifyGap } from "../src/report/gap-triage";
import type { ExtendedEvidence, Source } from "../src/domain/types";
import { collectedSources, deepEquityEvidenceBundle, researchReport } from "./support/fixtures";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";
import { executeEvidenceRequestTool } from "../src/sources/evidence-request-tools";
import { buildDeepEquityEvidenceBundle } from "../src/deep-equity/evidence";
import { prepareRunArtifacts } from "../src/artifacts";
import { persistRunArtifactWrites } from "../src/run-artifact-writer";

const tmpDirs: string[] = [];

const command: InstrumentCommand = {
  jobType: "equity",
  assetClass: "equity",
  symbol: "AAPL",
  depth: "deep",
};
const cryptoCommand: InstrumentCommand = {
  jobType: "crypto",
  assetClass: "crypto",
  symbol: "BTC",
  depth: "deep",
};
const researchCommand: ResearchCommand = {
  jobType: "research",
  assetClass: "equity",
  subject: "AI infrastructure",
  depth: "deep",
};

const webSource: Source = {
  id: "web-aapl-12345678",
  title: "Apple business profile",
  url: "https://example.com/apple-profile",
  fetchedAt: "2026-05-01T00:00:00.000Z",
  kind: "web",
  assetClass: "equity",
  symbol: "AAPL",
  provider: "exa",
};

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tempRunsDir(): string {
  const dir = join(
    tmpdir(),
    `market-bot-web-profile-reuse-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "runs",
  );
  tmpDirs.push(dirname(dir));
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function profile(
  input: {
    readonly symbol?: string;
    readonly subjectKind?: "company" | "crypto-asset" | "theme";
    readonly sourceIds?: readonly string[];
    readonly generatedAt?: string;
    readonly originRunDirName?: string;
    readonly version?: 2 | 3;
  } = {},
): WebSubjectProfileArtifact {
  const symbol = input.symbol ?? "AAPL";
  const subjectKind = input.subjectKind ?? "company";
  const sourceIds = input.sourceIds ?? [webSource.id];
  const answer = { answer: `${symbol} sells devices and services.`, sourceIds };
  const origin =
    input.originRunDirName !== undefined ? { originRunDirName: input.originRunDirName } : {};
  if (subjectKind === "crypto-asset") {
    return {
      version: 2,
      generatedAt: input.generatedAt ?? "2026-05-01T00:00:00.000Z",
      ...origin,
      subjectKind,
      subjectId: symbol,
      subjectLabel: symbol,
      symbol,
      subjectSummary: answer,
      questions: {
        whatItDoes: answer,
        valueAccrual: answer,
        supplyIssuance: answer,
        usageAdoption: answer,
        governanceBuilders: answer,
        competitionMoat: answer,
        keyRisks: answer,
      },
      recentMaterialEvents: [],
      factLedger: [{ claim: `${symbol} uses public network infrastructure.`, sourceIds }],
      openGaps: [],
      sourceIds,
    };
  }
  if (subjectKind === "theme") {
    return {
      version: 2,
      generatedAt: input.generatedAt ?? "2026-05-01T00:00:00.000Z",
      ...origin,
      subjectKind,
      subjectId: symbol,
      subjectLabel: "AI infrastructure",
      subjectSummary: answer,
      questions: {
        whatItIs: answer,
        whyNow: answer,
        beneficiaries: answer,
        headwinds: answer,
        keyDebates: answer,
        howItPlaysOut: answer,
      },
      recentMaterialEvents: [],
      factLedger: [{ claim: `${symbol} is a public-market research theme.`, sourceIds }],
      openGaps: [],
      sourceIds,
    };
  }
  return {
    version: input.version ?? 3,
    generatedAt: input.generatedAt ?? "2026-05-01T00:00:00.000Z",
    ...origin,
    subjectKind: "company",
    subjectId: symbol,
    subjectLabel: `${symbol} Inc.`,
    symbol,
    companyName: `${symbol} Inc.`,
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
    recentMaterialEvents: [{ claim: "Apple reports services revenue.", sourceIds }],
    factLedger: [{ claim: "Apple sells hardware and services.", sourceIds }],
    openGaps: [],
    sourceIds,
    secFilingBasisDate: "2026-04-25",
  };
}

async function writePriorRun(input: {
  readonly dataDir: string;
  readonly runId: string;
  readonly symbol: string;
  readonly subjectKind?: "company" | "crypto-asset" | "theme";
  readonly depth?: "brief" | "deep";
  readonly sourceIds?: readonly string[];
  readonly sources?: readonly Source[];
  readonly generatedAt?: string;
  readonly version?: 2 | 3;
  readonly analytics?: unknown;
  readonly artifact?: WebSubjectProfileArtifact;
}): Promise<void> {
  const runDir = join(input.dataDir, input.runId);
  const isCrypto = input.subjectKind === "crypto-asset";
  const isTheme = input.subjectKind === "theme";
  let jobType: "research" | "crypto" | "equity" = "equity";
  if (isCrypto) {
    jobType = "crypto";
  }
  if (isTheme) {
    jobType = "research";
  }
  await writeJson(join(runDir, "report.json"), {
    runId: input.runId,
    jobType,
    assetClass: isCrypto ? "crypto" : "equity",
    ...(!isTheme ? { symbol: input.symbol } : {}),
    generatedAt: input.generatedAt ?? "2026-05-01T00:00:00.000Z",
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
    sources: input.sources ?? [webSource],
    notFinancialAdvice: true,
    extras: { depth: input.depth ?? "deep" },
  });
  const artifact =
    input.artifact ??
    profile({
      ...(input.sourceIds !== undefined ? { sourceIds: input.sourceIds } : {}),
      ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}),
      ...(input.version !== undefined ? { version: input.version } : {}),
      symbol: input.symbol,
      ...(input.subjectKind !== undefined ? { subjectKind: input.subjectKind } : {}),
    });
  if (jobType === "equity" && (input.depth ?? "deep") === "deep") {
    const generatedAt = input.generatedAt ?? "2026-05-01T00:00:00.000Z";
    const sources = input.sources ?? [webSource];
    const base = deepEquityEvidenceBundle();
    await writeJson(
      join(runDir, RUN_ARTIFACT_FILES.evidenceBundle),
      deepEquityEvidenceBundle({
        run: { symbol: input.symbol, analysisAsOf: generatedAt },
        evidence: { ...base.evidence, extendedSources: sources, webSubjectProfile: artifact },
        governance: {
          ...base.governance,
          sourcePlan: {
            ...base.governance.sourcePlan,
            generatedAt,
            run: {
              jobType: "equity",
              assetClass: "equity",
              symbol: input.symbol,
              depth: "deep",
            },
          },
          evidenceLanes: { ...base.governance.evidenceLanes, generatedAt },
          sourceLedger: {
            version: 2,
            generatedAt,
            sources: sources.map((source) => ({
              id: source.id,
              kind: source.kind,
              lane: "subject-profile",
              posture: "covered",
              relatedGapIds: [],
              fetchedAt: source.fetchedAt,
            })),
          },
        },
        context: {
          historicalContext: {
            ...base.context.historicalContext,
            generatedAt,
          },
        },
      }),
    );
  } else {
    await writeJson(join(runDir, RUN_ARTIFACT_FILES.webSubjectProfile), artifact);
  }
  if (input.analytics !== undefined) {
    await writeJson(join(runDir, "analytics.json"), input.analytics);
  }
}

describe("Web Subject Profile reuse", () => {
  const reuseDaysBySubjectKind = {
    company: 30,
    "crypto-asset": 7,
    theme: 7,
  } as const;

  test("reuses fresh same-symbol profile when no newer SEC filing exists", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({ dataDir, runId: "prior-aapl", symbol: "AAPL" });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      // A binary midpoint must use the same tenth-day rounding as analytics.
      now: new Date("2026-05-03T13:12:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse?.profile).toMatchObject({ subjectKind: "company", companyName: "AAPL Inc." });
    expect(reuse?.sources.map((source) => source.id)).toEqual([webSource.id]);
    expect(reuse?.gap).toMatchObject({
      message:
        "Reused web subject profile from 2026-05-01T00:00:00.000Z (2.5 days old); latest SEC filing basis 2026-04-25.",
      cause: "reused-in-window",
      evidenceQualityImpact: "no-cap",
    });
    expect(classifyGap(reuse!.gap)).toBe("diagnostic");
  });

  test("offers the normalizer's degraded FPI profile for reuse", async () => {
    const dataDir = tempRunsDir();
    const normalized = buildWebSubjectProfileEvidence({
      command,
      subject: {
        subjectKind: "company",
        subjectId: "AAPL",
        subjectLabel: "AAPL Inc.",
        symbol: "AAPL",
        assetClass: "equity",
      },
      generatedAt: "2026-05-01T00:00:00.000Z",
      runId: "prior-aapl",
      modelContent: JSON.stringify({
        ...profile(),
        subjectSummary: { answer: "", sourceIds: [] },
      }),
      webSources: [webSource],
      extendedEvidence: undefined,
      secFilingBasisDate: "2026-04-25",
    });
    expect(normalized.artifact).toBeDefined();
    const artifact = normalized.artifact!;
    await writePriorRun({ dataDir, runId: "prior-aapl", symbol: "AAPL", artifact });
    const currentSecFilingDate = latestSecFilingDate({
      instrument: { assetClass: "equity", symbol: "AAPL" },
      items: [
        // The producer-backed filing collection test below covers this reader path.
        {
          category: "sec-edgar",
          title: "Foreign private issuer annual report",
          summary: "Annual filing.",
          sourceIds: ["sec-20f"],
          observedAt: "2026-04-25T00:00:00.000Z",
          metrics: { form: "20-F", filingDate: "2026-04-25" },
        },
      ],
      gaps: [],
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      ...(currentSecFilingDate !== undefined ? { currentSecFilingDate } : {}),
    });

    expect(reuse?.profile.subjectSummary).toEqual(normalized.artifact?.subjectSummary);
    expect(reuse?.profile.factLedger).toEqual(artifact.factLedger);
  });

  test("reuses an FPI profile from the filing evidence collection path", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({ dataDir, runId: "prior-aapl", symbol: "AAPL" });
    const fetchedAt = "2026-05-20T00:00:00.000Z";
    const filingEvidence = await executeEvidenceRequestTool("sec_latest_filing", {
      command,
      fetchedAt,
      newsLimit: 0,
      cryptoMoverLimit: 0,
      request: {
        json: async ({ adapter }) => {
          const payload =
            adapter === "sec-tickers"
              ? { "0": { cik_str: 320_193, ticker: "AAPL", title: "Apple Inc." } }
              : {
                  filings: {
                    recent: {
                      form: ["20-F", "6-K"],
                      items: ["", ""],
                      filingDate: ["2026-04-25", "2026-05-15"],
                      reportDate: ["2025-12-31", "2026-05-15"],
                      accessionNumber: ["0000320193-26-000020", "0000320193-26-000060"],
                      primaryDocument: ["a20f.htm", "a6k.htm"],
                    },
                  },
                };
          return { rawSnapshot: { id: `raw-${adapter}`, adapter, fetchedAt, payload }, payload };
        },
        text: async ({ adapter }) => {
          const payload =
            "Apple furnished a current report covering an interim operating update and related corporate events.";
          return { rawSnapshot: { id: `raw-${adapter}`, adapter, fetchedAt, payload }, payload };
        },
      },
    });
    const currentSecFilingDate = latestSecFilingDate({
      instrument: { assetClass: "equity", symbol: "AAPL" },
      items: filingEvidence.items,
      gaps: filingEvidence.gaps,
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date(fetchedAt),
      reuseDaysBySubjectKind,
      ...(currentSecFilingDate !== undefined ? { currentSecFilingDate } : {}),
    });

    expect(filingEvidence.items.map((item) => item.metrics?.form)).toEqual(["20-F", "6-K"]);
    expect(currentSecFilingDate).toBe("2026-04-25");
    expect(reuse?.profile).toMatchObject({
      subjectKind: "company",
      secFilingBasisDate: "2026-04-25",
    });
  });

  test("reads versioned low utilization from the exact reused-profile run without rewriting it", async () => {
    const dataDir = tempRunsDir();
    const analytics = {
      version: 2,
      runId: "prior-aapl",
      webEvidenceUtilization: {
        version: 1,
        acceptedCurrentRun: 5,
        usedCurrentRun: 1,
        profileUsed: 0,
        primaryReportCited: 1,
        structuredExtraCited: 0,
        unusedCurrentRun: 4,
        ratio: 0.2,
        level: "low",
      },
      webSources: { accepted: 5, usageRatio: 1 },
    };
    await writePriorRun({
      dataDir,
      runId: "prior-aapl",
      symbol: "AAPL",
      analytics,
    });
    await writePriorRun({
      dataDir,
      runId: "newer-msft",
      symbol: "MSFT",
      generatedAt: "2026-05-10T00:00:00.000Z",
      analytics: {
        version: 2,
        runId: "newer-msft",
        webEvidenceUtilization: {
          version: 1,
          acceptedCurrentRun: 4,
          usedCurrentRun: 4,
          profileUsed: 0,
          primaryReportCited: 4,
          structuredExtraCited: 0,
          unusedCurrentRun: 0,
          ratio: 1,
          level: "high",
        },
      },
    });
    const priorRunDir = join(dataDir, "prior-aapl");
    const before = await Promise.all([
      readFile(join(priorRunDir, "report.json"), "utf8"),
      readFile(join(priorRunDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8"),
      readFile(join(priorRunDir, "analytics.json"), "utf8"),
    ]);

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toMatchObject({
      runDirName: "prior-aapl",
      priorUtilizationLevel: "low",
      priorUtilizationRatio: 0.2,
    });
    expect(webGatherAcceptancePolicyForReuse(reuse!)).toEqual({
      version: 1,
      mode: "reused-profile-after-low-utilization",
      sourceRunDirName: "prior-aapl",
      priorUtilizationLevel: "low",
      priorUtilizationRatio: 0.2,
      implicitPerQueryAcceptanceCap: 2,
    });
    await expect(
      Promise.all([
        readFile(join(priorRunDir, "report.json"), "utf8"),
        readFile(join(priorRunDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8"),
        readFile(join(priorRunDir, "analytics.json"), "utf8"),
      ]),
    ).resolves.toEqual(before);
  });

  test("derives low utilization from legacy web-source analytics", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({
      dataDir,
      runId: "prior-aapl",
      symbol: "AAPL",
      analytics: {
        version: 2,
        runId: "prior-aapl",
        webSources: { accepted: 5, usageRatio: 0.2 },
      },
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toMatchObject({
      priorUtilizationLevel: "low",
      priorUtilizationRatio: 0.2,
    });
    expect(webGatherAcceptancePolicyForReuse(reuse!).implicitPerQueryAcceptanceCap).toBe(2);
  });

  test("does not reduce the cap for an insufficient legacy sample", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({
      dataDir,
      runId: "prior-aapl",
      symbol: "AAPL",
      analytics: {
        version: 2,
        runId: "prior-aapl",
        webSources: { accepted: 3, usageRatio: 0 },
      },
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse?.priorUtilizationLevel).toBe("insufficient-sample");
    expect(webGatherAcceptancePolicyForReuse(reuse!)).toMatchObject({
      mode: "reused-profile-default",
      implicitPerQueryAcceptanceCap: 3,
    });
  });

  test.each([
    { name: "missing", analytics: undefined },
    {
      name: "future-version",
      analytics: {
        version: 2,
        runId: "prior-aapl",
        webEvidenceUtilization: { version: 2 },
      },
    },
    {
      name: "future-analytics-version",
      analytics: {
        version: 3,
        runId: "prior-aapl",
        webSources: { accepted: 5, usageRatio: 0.2 },
      },
    },
    {
      name: "mismatched-level",
      analytics: {
        version: 2,
        runId: "prior-aapl",
        webEvidenceUtilization: {
          version: 1,
          acceptedCurrentRun: 5,
          usedCurrentRun: 1,
          profileUsed: 0,
          primaryReportCited: 1,
          structuredExtraCited: 0,
          unusedCurrentRun: 4,
          ratio: 0.2,
          level: "high",
        },
      },
    },
    {
      name: "mismatched-run",
      analytics: {
        version: 2,
        runId: "different-run",
        webSources: { accepted: 5, usageRatio: 0.2 },
      },
    },
  ])("treats $name analytics as unknown", async ({ analytics }) => {
    const dataDir = tempRunsDir();
    await writePriorRun({
      dataDir,
      runId: "prior-aapl",
      symbol: "AAPL",
      ...(analytics !== undefined ? { analytics } : {}),
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse?.priorUtilizationLevel).toBeUndefined();
    expect(webGatherAcceptancePolicyForReuse(reuse!)).toEqual({
      version: 1,
      mode: "reused-profile-default",
      sourceRunDirName: "prior-aapl",
      implicitPerQueryAcceptanceCap: 3,
    });
  });

  test("treats malformed analytics JSON as unknown", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({ dataDir, runId: "prior-aapl", symbol: "AAPL" });
    await writeFile(join(dataDir, "prior-aapl", "analytics.json"), "{not-json", "utf8");

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse?.priorUtilizationLevel).toBeUndefined();
    expect(webGatherAcceptancePolicyForReuse(reuse!).implicitPerQueryAcceptanceCap).toBe(3);
  });

  test("rejects reuse when a newer current SEC filing exists", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({ dataDir, runId: "prior-aapl", symbol: "AAPL" });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-05-10",
    });

    expect(reuse).toBeUndefined();
  });

  test("reads but does not reuse legacy company profile v2", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({
      dataDir,
      runId: "prior-aapl-v2",
      symbol: "AAPL",
      version: 2,
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toBeUndefined();
  });

  test("reuses crypto profiles within TTL without SEC filing basis", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({
      dataDir,
      runId: "prior-btc",
      symbol: "BTC",
      subjectKind: "crypto-asset",
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command: cryptoCommand,
      now: new Date("2026-05-07T00:00:00.000Z"),
      reuseDaysBySubjectKind,
    });

    expect(reuse?.profile).toMatchObject({ subjectKind: "crypto-asset", subjectId: "BTC" });
  });

  test("reuses theme profiles within TTL by normalized subject ID", async () => {
    const dataDir = tempRunsDir();
    const subjectId = normalizedSubjectId("AI infrastructure");
    await writePriorRun({
      dataDir,
      runId: "prior-ai-infrastructure",
      symbol: subjectId,
      subjectKind: "theme",
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command: {
        ...researchCommand,
        subject: " ai   infrastructure ",
      },
      now: new Date("2026-05-07T00:00:00.000Z"),
      reuseDaysBySubjectKind,
    });

    expect(reuse?.profile).toMatchObject({ subjectKind: "theme", subjectId });
  });

  test("reuses legacy brief theme profiles for direct brief research callers", async () => {
    const dataDir = tempRunsDir();
    const subjectId = normalizedSubjectId("AI infrastructure");
    await writePriorRun({
      dataDir,
      runId: "prior-ai-infrastructure-brief",
      symbol: subjectId,
      subjectKind: "theme",
      depth: "brief",
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command: { ...researchCommand, subject: "AI infrastructure", depth: "brief" },
      now: new Date("2026-05-07T00:00:00.000Z"),
      reuseDaysBySubjectKind,
    });

    expect(reuse?.profile).toMatchObject({ subjectKind: "theme", subjectId });
  });

  test("reuses a profile at the exact TTL boundary", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({
      dataDir,
      runId: "prior-btc",
      symbol: "BTC",
      subjectKind: "crypto-asset",
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command: cryptoCommand,
      now: new Date("2026-05-08T00:00:00.000Z"),
      reuseDaysBySubjectKind,
    });

    expect(reuse).toBeDefined();
  });

  test("applies the Subject Kind TTL to eight-day-old profiles", async () => {
    const dataDir = tempRunsDir();
    const themeSubjectId = normalizedSubjectId("AI infrastructure");
    await writePriorRun({ dataDir, runId: "prior-aapl", symbol: "AAPL" });
    await writePriorRun({
      dataDir,
      runId: "prior-btc",
      symbol: "BTC",
      subjectKind: "crypto-asset",
    });
    await writePriorRun({
      dataDir,
      runId: "prior-ai-infrastructure",
      symbol: themeSubjectId,
      subjectKind: "theme",
    });
    const now = new Date("2026-05-09T00:00:00.000Z");

    const companyReuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now,
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });
    const cryptoReuse = await findReusableWebSubjectProfile({
      dataDir,
      command: cryptoCommand,
      now,
      reuseDaysBySubjectKind,
    });
    const themeReuse = await findReusableWebSubjectProfile({
      dataDir,
      command: { ...researchCommand, subject: "AI infrastructure" },
      now,
      reuseDaysBySubjectKind,
    });

    expect(companyReuse).toBeDefined();
    expect(cryptoReuse).toBeUndefined();
    expect(themeReuse).toBeUndefined();
  });

  test("rejects profiles older than the reuse TTL", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({ dataDir, runId: "prior-aapl", symbol: "AAPL" });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-06-02T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toBeUndefined();
  });

  test("rejects profiles generated in the future", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({
      dataDir,
      runId: "prior-aapl",
      symbol: "AAPL",
      generatedAt: "2026-06-01T00:00:00.000Z",
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toBeUndefined();
  });

  test("does not reuse or gap an over-age candidate", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({ dataDir, runId: "prior-aapl", symbol: "AAPL" });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-06-15T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toBeUndefined();
  });

  test("rejects different symbols", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({ dataDir, runId: "prior-msft", symbol: "MSFT" });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toBeUndefined();
  });

  test("rejects profiles with unresolved source IDs", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({
      dataDir,
      runId: "prior-aapl-bad-source",
      symbol: "AAPL",
      sourceIds: ["missing-source"],
      sources: [webSource],
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toBeUndefined();
  });

  test("attaches reused profile, cited web sources, and freshness gap", () => {
    const attached = attachReusableWebSubjectProfile({
      command,
      collectedSources: collectedSources(),
      reuse: {
        profile: profile(),
        sources: [webSource],
        runDirName: "prior-aapl",
        ageDays: 19,
        gap: {
          source: "web-subject-profile",
          message: "Reused Web Subject Profile from 2026-05-01T00:00:00.000Z (19.0 days old).",
          provider: "market-bot",
          capability: "extended-evidence",
          cause: "reused-in-window",
          evidenceQualityImpact: "extended-evidence-cap",
        },
      },
    });

    expect(attached.webSubjectProfile?.sourceIds).toEqual([webSource.id]);
    expect(attached.webSubjectProfileReuse).toEqual({
      runDirName: "prior-aapl",
      generatedAt: "2026-05-01T00:00:00.000Z",
      ageDays: 19,
    });
    expect(attached.extendedSources).toEqual([webSource]);
    expect(attached.sourceGaps).toHaveLength(1);
    expect(attached.extendedEvidence?.items).toEqual([
      expect.objectContaining({ category: "web-subject-profile", sourceIds: [webSource.id] }),
    ]);
  });

  test("reads the current SEC filing date from produced filing evidence", async () => {
    const fetchedAt = "2026-05-20T00:00:00.000Z";
    const filingEvidence = await executeEvidenceRequestTool("sec_latest_filing", {
      command,
      fetchedAt,
      newsLimit: 0,
      cryptoMoverLimit: 0,
      request: {
        json: async ({ adapter }) => {
          const payload =
            adapter === "sec-tickers"
              ? { "0": { cik_str: 320_193, ticker: "AAPL", title: "Apple Inc." } }
              : {
                  filings: {
                    recent: {
                      form: ["10-K", "10-Q", "8-K"],
                      items: ["", "", ""],
                      filingDate: ["2026-04-01", "2026-05-10", "2026-05-15"],
                      reportDate: ["2025-12-31", "2026-03-31", "2026-05-15"],
                      accessionNumber: [
                        "0000320193-26-000010",
                        "0000320193-26-000020",
                        "0000320193-26-000030",
                      ],
                      primaryDocument: ["a10-k.htm", "a10-q.htm", "a8-k.htm"],
                    },
                  },
                };
          return { rawSnapshot: { id: `raw-${adapter}`, adapter, fetchedAt, payload }, payload };
        },
        text: async ({ adapter }) => {
          const payload = "";
          return { rawSnapshot: { id: `raw-${adapter}`, adapter, fetchedAt, payload }, payload };
        },
      },
    });
    const evidence: ExtendedEvidence = {
      instrument: { assetClass: "equity", symbol: "AAPL" },
      items: filingEvidence.items,
      gaps: filingEvidence.gaps,
    };

    expect(
      filingEvidence.items.map((item) => [item.metrics?.form, item.metrics?.filingDate]),
    ).toEqual([
      ["10-K", "2026-04-01"],
      ["10-Q", "2026-05-10"],
      ["8-K", "2026-05-15"],
    ]);
    expect(
      evidence.items.map((item) => latestSecFilingDate({ ...evidence, items: [item] })),
    ).toEqual(["2026-04-01", "2026-05-10", undefined]);
    expect(latestSecFilingDate(evidence)).toBe("2026-05-10");
  });

  test("first-hop reuse names the generating run as both copied-from and origin", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({
      dataDir,
      runId: "A",
      symbol: "AAPL",
      artifact: profile({ originRunDirName: "A" }),
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse?.runDirName).toBe("A");
    expect(reuse?.originRunDirName).toBe("A");
  });

  test("chained reuse keeps origin A when C scans B", async () => {
    const dataDir = tempRunsDir();
    const originProfile = profile({
      originRunDirName: "A",
      generatedAt: "2026-05-01T00:00:00.000Z",
    });
    await writePriorRun({
      dataDir,
      runId: "A",
      symbol: "AAPL",
      generatedAt: "2026-05-01T00:00:00.000Z",
      artifact: originProfile,
    });
    const reuseForB = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-10T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    const collectedForB = attachReusableWebSubjectProfile({
      command,
      collectedSources: collectedSources(),
      reuse: reuseForB!,
    });
    const base = deepEquityEvidenceBundle();
    const evidenceBundleForB = buildDeepEquityEvidenceBundle({
      symbol: "AAPL",
      analysisAsOf: "2026-05-10T00:00:00.000Z",
      collectedSources: collectedForB,
      historicalContext: base.context.historicalContext,
      sourcePlan: base.governance.sourcePlan,
      evidenceLanes: base.governance.evidenceLanes,
      sourceLedger: base.governance.sourceLedger,
    });
    const artifactsForB = await prepareRunArtifacts(dataDir, "B");
    await writeJson(
      join(artifactsForB.runDir, RUN_ARTIFACT_FILES.report),
      researchReport({
        runId: "B",
        jobType: "equity",
        assetClass: "equity",
        symbol: "AAPL",
        generatedAt: "2026-05-10T00:00:00.000Z",
        sources: [webSource],
        extras: { depth: "deep" },
      }),
    );
    await persistRunArtifactWrites(artifactsForB, [
      {
        file: RUN_ARTIFACT_FILES.evidenceBundle,
        kind: "json",
        value: evidenceBundleForB,
      },
    ]);

    const reuseForC = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuseForC?.runDirName).toBe("B");
    expect(reuseForC?.originRunDirName).toBe("A");
    const attached = attachReusableWebSubjectProfile({
      command,
      collectedSources: collectedSources(),
      reuse: reuseForC!,
    });
    expect(attached.webSubjectProfileReuse).toEqual({
      runDirName: "B",
      generatedAt: "2026-05-01T00:00:00.000Z",
      ageDays: reuseForC!.ageDays,
      originRunDirName: "A",
    });
    expect(attached.webSubjectProfile?.originRunDirName).toBe("A");
  });

  test("old profiles without origin still reuse and leave origin undefined", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({ dataDir, runId: "prior-aapl", symbol: "AAPL" });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse?.profile).toMatchObject({ subjectId: "AAPL", version: 3 });
    expect(reuse?.runDirName).toBe("prior-aapl");
    expect(reuse?.originRunDirName).toBeUndefined();
    expect("originRunDirName" in (reuse?.profile ?? {})).toBe(false);
  });

  test("acceptance policy stays on copied-from utilization when origin would be medium", async () => {
    const dataDir = tempRunsDir();
    const originProfile = profile({ originRunDirName: "origin-run" });
    await writePriorRun({
      dataDir,
      runId: "origin-run",
      symbol: "AAPL",
      generatedAt: "2026-05-01T00:00:00.000Z",
      artifact: originProfile,
      analytics: {
        version: 2,
        runId: "origin-run",
        webEvidenceUtilization: {
          version: 1,
          acceptedCurrentRun: 10,
          usedCurrentRun: 3,
          profileUsed: 3,
          primaryReportCited: 3,
          structuredExtraCited: 1,
          unusedCurrentRun: 7,
          ratio: 0.3,
          level: "medium",
        },
      },
    });
    await writePriorRun({
      dataDir,
      runId: "copied-from",
      symbol: "AAPL",
      generatedAt: "2026-05-10T00:00:00.000Z",
      artifact: originProfile,
      analytics: {
        version: 2,
        runId: "copied-from",
        webEvidenceUtilization: {
          version: 1,
          acceptedCurrentRun: 5,
          usedCurrentRun: 1,
          profileUsed: 0,
          primaryReportCited: 1,
          structuredExtraCited: 0,
          unusedCurrentRun: 4,
          ratio: 0.2,
          level: "low",
        },
      },
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse?.runDirName).toBe("copied-from");
    expect(reuse?.originRunDirName).toBe("origin-run");
    expect(webGatherAcceptancePolicyForReuse(reuse!)).toEqual({
      version: 1,
      mode: "reused-profile-after-low-utilization",
      sourceRunDirName: "copied-from",
      priorUtilizationLevel: "low",
      priorUtilizationRatio: 0.2,
      implicitPerQueryAcceptanceCap: 2,
    });
  });

  test("origin on an empty profile does not make it reusable", async () => {
    const dataDir = tempRunsDir();
    await writePriorRun({
      dataDir,
      runId: "empty-origin",
      symbol: "AAPL",
      artifact: profile({ sourceIds: [], originRunDirName: "empty-origin" }),
    });

    const reuse = await findReusableWebSubjectProfile({
      dataDir,
      command,
      now: new Date("2026-05-20T00:00:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse).toBeUndefined();
  });

  test("sidecar reader keeps origin when present and omits it when absent", () => {
    const withOrigin = profile({ originRunDirName: "origin-a" });
    expect(readWebSubjectProfileArtifact(withOrigin)?.originRunDirName).toBe("origin-a");
    expect(readWebSubjectProfileArtifact(structuredClone(withOrigin))?.originRunDirName).toBe(
      "origin-a",
    );

    const withoutOrigin = profile();
    const roundTrip = readWebSubjectProfileArtifact(structuredClone(withoutOrigin));
    expect(roundTrip).toMatchObject({ subjectId: "AAPL", version: 3 });
    expect(roundTrip?.originRunDirName).toBeUndefined();
    expect(
      readWebSubjectProfileArtifact({ ...withoutOrigin, extraField: "ignored" })?.originRunDirName,
    ).toBeUndefined();
  });
});
