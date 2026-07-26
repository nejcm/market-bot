import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { migrateDeepEquityEvidenceBundles } from "../src/deep-equity/migration";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";
import { deepEquityEvidenceBundle, marketSnapshot, researchReport } from "./support/fixtures";

const GENERATED_AT = "2026-05-19T00:00:00.000Z";
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tempRunsDir(): string {
  const dir = join(
    tmpdir(),
    `market-bot-deep-equity-migration-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    "runs",
  );
  tempDirs.push(dirname(dir));
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function legacyBundle(symbol = "AAPL") {
  const snapshot = marketSnapshot({ sourceId: `market-${symbol}`, symbol });
  const base = deepEquityEvidenceBundle();
  return deepEquityEvidenceBundle({
    run: { symbol, analysisAsOf: GENERATED_AT },
    evidence: { ...base.evidence, marketSnapshots: [snapshot] },
    governance: {
      ...base.governance,
      sourcePlan: {
        ...base.governance.sourcePlan,
        generatedAt: GENERATED_AT,
        run: { jobType: "equity", assetClass: "equity", symbol, depth: "deep" },
      },
      evidenceLanes: { ...base.governance.evidenceLanes, generatedAt: GENERATED_AT },
      sourceLedger: {
        version: 2,
        generatedAt: GENERATED_AT,
        sources: [
          {
            id: snapshot.sourceId,
            kind: "market-data",
            lane: "market-data",
            posture: "covered",
            relatedGapIds: [],
            observedAt: GENERATED_AT,
          },
        ],
      },
    },
    context: {
      historicalContext: { ...base.context.historicalContext, generatedAt: GENERATED_AT },
    },
  });
}

async function writeLegacyRun(
  runsDir: string,
  runId: string,
  bundle = legacyBundle(),
): Promise<string> {
  const runDir = join(runsDir, runId);
  await writeJson(
    join(runDir, RUN_ARTIFACT_FILES.report),
    researchReport({
      runId,
      jobType: "equity",
      assetClass: "equity",
      symbol: bundle.run.symbol,
      generatedAt: bundle.run.analysisAsOf,
      extras: { depth: "deep" },
      sources: [],
    }),
  );
  const componentValues: Readonly<Record<string, unknown>> = {
    [RUN_ARTIFACT_FILES.marketSnapshots]: bundle.evidence.marketSnapshots,
    [RUN_ARTIFACT_FILES.supplementalMarketSnapshots]: bundle.evidence.supplementalMarketSnapshots,
    [RUN_ARTIFACT_FILES.newsSources]: bundle.evidence.newsSources,
    [RUN_ARTIFACT_FILES.extendedSources]: bundle.evidence.extendedSources,
    [RUN_ARTIFACT_FILES.sourceGaps]: bundle.governance.sourceGaps,
    [RUN_ARTIFACT_FILES.sourcePlan]: bundle.governance.sourcePlan,
    [RUN_ARTIFACT_FILES.evidenceLanes]: bundle.governance.evidenceLanes,
    [RUN_ARTIFACT_FILES.sourceLedger]: bundle.governance.sourceLedger,
    [RUN_ARTIFACT_FILES.historicalContext]: bundle.context.historicalContext,
  };
  await Promise.all(
    Object.entries(componentValues).map(([file, value]) => writeJson(join(runDir, file), value)),
  );
  return runDir;
}

describe("deep-equity evidence bundle migration", () => {
  test("is dry-run by default, writes only with --write semantics, and is idempotent", async () => {
    const runsDir = tempRunsDir();
    const runDir = await writeLegacyRun(runsDir, "run-aapl");

    const dryRun = await migrateDeepEquityEvidenceBundles({ runsDir });

    expect(dryRun).toMatchObject({
      mode: "dry-run",
      eligibleRunCount: 1,
      plannedWriteCount: 1,
      writtenCount: 0,
      unchangedCount: 0,
      failures: [],
    });
    await expect(
      readFile(join(runDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8"),
    ).rejects.toThrow();

    const write = await migrateDeepEquityEvidenceBundles({ runsDir, write: true });
    const written = await readFile(join(runDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8");
    const repeat = await migrateDeepEquityEvidenceBundles({ runsDir, write: true });

    expect(write).toMatchObject({ plannedWriteCount: 1, writtenCount: 1, failures: [] });
    expect(repeat).toMatchObject({
      plannedWriteCount: 0,
      writtenCount: 0,
      unchangedCount: 1,
      failures: [],
    });
    expect(await readFile(join(runDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8")).toBe(written);
    await expect(readFile(join(runDir, RUN_ARTIFACT_FILES.marketSnapshots), "utf8")).resolves.toBe(
      `${JSON.stringify(legacyBundle().evidence.marketSnapshots, null, 2)}\n`,
    );
  });

  test("repairs malformed or schema-invalid existing evidence bundles", async () => {
    const runsDir = tempRunsDir();
    const malformedDir = await writeLegacyRun(runsDir, "malformed");
    const invalidDir = await writeLegacyRun(runsDir, "invalid");
    await writeFile(
      join(malformedDir, RUN_ARTIFACT_FILES.evidenceBundle),
      '{"schemaVersion":',
      "utf8",
    );
    await writeJson(join(invalidDir, RUN_ARTIFACT_FILES.evidenceBundle), {
      schemaVersion: 1,
    });

    const result = await migrateDeepEquityEvidenceBundles({ runsDir, write: true });

    expect(result).toMatchObject({
      eligibleRunCount: 2,
      plannedWriteCount: 2,
      writtenCount: 2,
      failures: [],
    });
    expect(
      JSON.parse(await readFile(join(malformedDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8")),
    ).toEqual(legacyBundle());
    expect(
      JSON.parse(await readFile(join(invalidDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8")),
    ).toEqual(legacyBundle());
  });

  test("reports corrupt and missing required sidecars without writing", async () => {
    const runsDir = tempRunsDir();
    const missingDir = await writeLegacyRun(runsDir, "missing-plan");
    const corruptDir = await writeLegacyRun(runsDir, "corrupt-news");
    await unlink(join(missingDir, RUN_ARTIFACT_FILES.sourcePlan));
    await writeFile(join(corruptDir, RUN_ARTIFACT_FILES.newsSources), "{bad", "utf8");

    const result = await migrateDeepEquityEvidenceBundles({ runsDir, write: true });

    expect(result.failures).toHaveLength(2);
    expect(result.failures.map((failure) => failure.message).join("\n")).toContain(
      "normalized/source-plan.json is absent",
    );
    expect(result.failures.map((failure) => failure.message).join("\n")).toContain(
      "normalized/news-sources.json is malformed",
    );
    await expect(
      readFile(join(missingDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(corruptDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8"),
    ).rejects.toThrow();
  });

  test("refuses to overwrite a conflicting existing bundle", async () => {
    const runsDir = tempRunsDir();
    const runDir = await writeLegacyRun(runsDir, "conflict");
    const conflicting = legacyBundle();
    const conflictingSnapshot = marketSnapshot({
      sourceId: "market-AAPL",
      symbol: "AAPL",
      price: 999,
    });
    await writeJson(join(runDir, RUN_ARTIFACT_FILES.evidenceBundle), {
      ...conflicting,
      evidence: { ...conflicting.evidence, marketSnapshots: [conflictingSnapshot] },
    });
    const before = await readFile(join(runDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8");

    const result = await migrateDeepEquityEvidenceBundles({ runsDir, write: true });

    expect(result.failures).toEqual([
      {
        runId: "conflict",
        message: "refusing to overwrite a conflicting existing evidence bundle",
      },
    ]);
    expect(await readFile(join(runDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8")).toBe(before);
  });

  test("rejects unresolved citations in available legacy sidecars", async () => {
    const runsDir = tempRunsDir();
    const runDir = await writeLegacyRun(runsDir, "unresolved");
    await writeJson(join(runDir, RUN_ARTIFACT_FILES.valuationComps), {
      version: 1,
      sourceIds: ["missing-source"],
    });

    const result = await migrateDeepEquityEvidenceBundles({ runsDir, write: true });

    expect(result.failures).toEqual([
      { runId: "unresolved", message: "unresolved source IDs: missing-source" },
    ]);
    await expect(
      readFile(join(runDir, RUN_ARTIFACT_FILES.evidenceBundle), "utf8"),
    ).rejects.toThrow();
  });
});
