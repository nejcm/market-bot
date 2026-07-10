import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { InstrumentCommand, ResearchCommand } from "../src/cli/args";
import {
  attachReusableWebSubjectProfile,
  findReusableWebSubjectProfile,
  latestSecFilingDate,
} from "../src/research/web-subject-profile-reuse";
import {
  normalizedSubjectId,
  type WebSubjectProfileArtifact,
} from "../src/sources/extended-evidence/web-subject-profile";
import type { ExtendedEvidence, Source } from "../src/domain/types";
import { collectedSources } from "./support/fixtures";

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
    readonly version?: 2 | 3;
  } = {},
): WebSubjectProfileArtifact {
  const symbol = input.symbol ?? "AAPL";
  const subjectKind = input.subjectKind ?? "company";
  const sourceIds = input.sourceIds ?? [webSource.id];
  const answer = { answer: `${symbol} sells devices and services.`, sourceIds };
  if (subjectKind === "crypto-asset") {
    return {
      version: 2,
      generatedAt: input.generatedAt ?? "2026-05-01T00:00:00.000Z",
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
  await writeJson(
    join(runDir, "normalized", "web-subject-profile.json"),
    profile({
      ...(input.sourceIds !== undefined ? { sourceIds: input.sourceIds } : {}),
      ...(input.generatedAt !== undefined ? { generatedAt: input.generatedAt } : {}),
      ...(input.version !== undefined ? { version: input.version } : {}),
      symbol: input.symbol,
      ...(input.subjectKind !== undefined ? { subjectKind: input.subjectKind } : {}),
    }),
  );
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
      // A fractional age (19.7 days) must be disclosed as-is, not floored to 19.
      now: new Date("2026-05-20T16:48:00.000Z"),
      reuseDaysBySubjectKind,
      currentSecFilingDate: "2026-04-25",
    });

    expect(reuse?.profile).toMatchObject({ subjectKind: "company", companyName: "AAPL Inc." });
    expect(reuse?.sources.map((source) => source.id)).toEqual([webSource.id]);
    expect(reuse?.gap.message).toContain("19.7 days old");
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
        gap: {
          source: "web-subject-profile",
          message: "Reused Web Subject Profile from 2026-05-01T00:00:00.000Z (19.0 days old).",
          provider: "market-bot",
          capability: "extended-evidence",
          cause: "stale-fallback",
          evidenceQualityImpact: "extended-evidence-cap",
        },
      },
    });

    expect(attached.webSubjectProfile?.sourceIds).toEqual([webSource.id]);
    expect(attached.webSubjectProfileReuse).toEqual({
      runDirName: "prior-aapl",
      generatedAt: "2026-05-01T00:00:00.000Z",
    });
    expect(attached.extendedSources).toEqual([webSource]);
    expect(attached.sourceGaps).toHaveLength(1);
    expect(attached.extendedEvidence?.items).toEqual([
      expect.objectContaining({ category: "web-subject-profile", sourceIds: [webSource.id] }),
    ]);
  });

  test("reads the current SEC filing date from extended evidence", () => {
    const evidence: ExtendedEvidence = {
      instrument: { assetClass: "equity", symbol: "AAPL" },
      items: [
        {
          category: "sec-edgar",
          title: "Older filing",
          summary: "Older filing.",
          sourceIds: ["sec-old"],
          observedAt: "2026-05-01T00:00:00.000Z",
          metrics: { filingDate: "2026-04-01" },
        },
        {
          category: "sec-edgar",
          title: "Latest filing",
          summary: "Latest filing.",
          sourceIds: ["sec-new"],
          observedAt: "2026-05-10T00:00:00.000Z",
          metrics: { filingDate: "2026-05-10" },
        },
      ],
      gaps: [],
    };

    expect(latestSecFilingDate(evidence)).toBe("2026-05-10");
  });
});
