import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ResearchReport } from "../domain/types";
import { isRecord } from "../guards";
import { RUN_ARTIFACT_FILES, type RunArtifactFileName } from "../run-artifact-layout";
import { validateResearchReport } from "../report/schema";
import {
  isDeepEquityReport,
  readDeepEquityEvidenceBundle,
  unresolvedDeepEquityBundleSourceIds,
} from "./artifact-schema";
import type { DeepEquityEvidenceBundleV1 } from "./types";

export interface DeepEquityBundleMigrationFailure {
  readonly runId: string;
  readonly message: string;
}

export interface DeepEquityBundleMigrationResult {
  readonly mode: "dry-run" | "write";
  readonly scannedRunCount: number;
  readonly eligibleRunCount: number;
  readonly plannedWriteCount: number;
  readonly writtenCount: number;
  readonly unchangedCount: number;
  readonly failures: readonly DeepEquityBundleMigrationFailure[];
}

interface JsonArtifact {
  readonly status: "ok" | "absent" | "malformed";
  readonly value?: unknown;
}

const REQUIRED_COMPONENT_FILES = [
  RUN_ARTIFACT_FILES.marketSnapshots,
  RUN_ARTIFACT_FILES.supplementalMarketSnapshots,
  RUN_ARTIFACT_FILES.newsSources,
  RUN_ARTIFACT_FILES.extendedSources,
  RUN_ARTIFACT_FILES.sourceGaps,
  RUN_ARTIFACT_FILES.sourcePlan,
  RUN_ARTIFACT_FILES.evidenceLanes,
  RUN_ARTIFACT_FILES.sourceLedger,
  RUN_ARTIFACT_FILES.historicalContext,
] as const;

const OPTIONAL_EVIDENCE_FILES = {
  verifiedMarketSnapshot: RUN_ARTIFACT_FILES.verifiedMarketSnapshot,
  extendedEvidence: RUN_ARTIFACT_FILES.extendedEvidence,
  webSubjectProfile: RUN_ARTIFACT_FILES.webSubjectProfile,
} as const;

const OPTIONAL_DERIVED_FILES = {
  financialStatements: RUN_ARTIFACT_FILES.financialStatements,
  fundamentalHistory: RUN_ARTIFACT_FILES.fundamentalHistory,
  financialLenses: RUN_ARTIFACT_FILES.financialLenses,
  capitalOwnership: RUN_ARTIFACT_FILES.capitalOwnership,
  subsequentFinancing: RUN_ARTIFACT_FILES.subsequentFinancing,
  valuationComps: RUN_ARTIFACT_FILES.valuationComps,
  valuationWorkbench: RUN_ARTIFACT_FILES.valuationWorkbench,
  reverseDcf: RUN_ARTIFACT_FILES.reverseDcf,
  businessFramework: RUN_ARTIFACT_FILES.businessFramework,
} as const;

// Analyst expectations, institutional ownership, and earnings setup had no legacy sidecars.
// Model-input sanitization and news analytics also were never persisted as sidecars.

async function readJsonArtifact(runDir: string, file: RunArtifactFileName): Promise<JsonArtifact> {
  try {
    const raw = await readFile(join(runDir, file), "utf8");
    try {
      return { status: "ok", value: JSON.parse(raw) as unknown };
    } catch {
      return { status: "malformed" };
    }
  } catch (error) {
    return isRecord(error) && error.code === "ENOENT"
      ? { status: "absent" }
      : { status: "malformed" };
  }
}

function assertReportIdentity(report: ReturnType<typeof validatedReport>, runId: string): void {
  if (report.runId !== runId) {
    throw new Error(`report identity runId ${report.runId} does not match directory ${runId}`);
  }
  if (Number.isNaN(Date.parse(report.generatedAt))) {
    throw new TypeError("report identity generatedAt is not a valid timestamp");
  }
}

function validatedReport(value: unknown): ResearchReport {
  if (!isDeepEquityReport(value)) {
    throw new Error("report identity is not equity <symbol> --deep");
  }
  return validateResearchReport(value as unknown as ResearchReport);
}

async function requiredValue(runDir: string, file: RunArtifactFileName): Promise<unknown> {
  const artifact = await readJsonArtifact(runDir, file);
  if (artifact.status !== "ok") {
    throw new Error(`${file} is ${artifact.status}`);
  }
  return artifact.value;
}

async function optionalRecordValue(
  runDir: string,
  file: RunArtifactFileName,
): Promise<{ readonly value?: Record<string, unknown> }> {
  const artifact = await readJsonArtifact(runDir, file);
  if (artifact.status === "absent") {
    return {};
  }
  if (artifact.status === "malformed") {
    throw new Error(`${file} is malformed`);
  }
  if (artifact.value === null) {
    return {};
  }
  if (!isRecord(artifact.value)) {
    throw new TypeError(`${file} must contain an object or null`);
  }
  return { value: artifact.value };
}

function assertBundleIdentity(bundle: DeepEquityEvidenceBundleV1, report: ResearchReport): void {
  if (bundle.run.symbol !== report.symbol?.toUpperCase()) {
    throw new Error("evidence bundle symbol conflicts with report identity");
  }
  if (bundle.run.analysisAsOf !== report.generatedAt) {
    throw new Error("evidence bundle analysisAsOf conflicts with report identity");
  }
}

function assertBundleSourceReferences(
  bundle: DeepEquityEvidenceBundleV1,
  report: ResearchReport,
): void {
  const unresolved = unresolvedDeepEquityBundleSourceIds(
    bundle,
    report.sources.map((source) => source.id),
  );
  if (unresolved.length > 0) {
    throw new Error(`unresolved source IDs: ${unresolved.join(", ")}`);
  }
}

async function buildLegacyBundle(
  runDir: string,
  report: ResearchReport,
): Promise<DeepEquityEvidenceBundleV1> {
  const [
    marketSnapshots,
    supplementalMarketSnapshots,
    newsSources,
    extendedSources,
    sourceGaps,
    sourcePlan,
    evidenceLanes,
    sourceLedger,
    historicalContext,
  ] = await Promise.all(REQUIRED_COMPONENT_FILES.map((file) => requiredValue(runDir, file)));
  const identity = await optionalRecordValue(runDir, RUN_ARTIFACT_FILES.instrumentIdentity);
  const evidenceEntries = await Promise.all(
    Object.entries(OPTIONAL_EVIDENCE_FILES).map(
      async ([key, file]) => [key, await optionalRecordValue(runDir, file)] as const,
    ),
  );
  const derivedEntries = await Promise.all(
    Object.entries(OPTIONAL_DERIVED_FILES).map(
      async ([key, file]) => [key, await optionalRecordValue(runDir, file)] as const,
    ),
  );
  const evidenceOptionals = Object.fromEntries(
    evidenceEntries.flatMap(([key, artifact]) =>
      artifact.value === undefined ? [] : [[key, artifact.value]],
    ),
  );
  const derived = Object.fromEntries(
    derivedEntries.flatMap(([key, artifact]) =>
      artifact.value === undefined ? [] : [[key, artifact.value]],
    ),
  );
  const candidate: unknown = {
    schemaVersion: 1,
    run: {
      symbol: report.symbol?.toUpperCase(),
      analysisAsOf: report.generatedAt,
      ...(identity.value !== undefined ? { identity: identity.value } : {}),
    },
    evidence: {
      marketSnapshots,
      supplementalMarketSnapshots,
      newsSources,
      extendedSources,
      ...evidenceOptionals,
    },
    derived,
    governance: {
      sourceGaps,
      sourcePlan,
      evidenceLanes,
      sourceLedger,
    },
    context: { historicalContext },
  };
  const bundle = readDeepEquityEvidenceBundle(candidate);
  if (bundle === undefined) {
    throw new Error("legacy sidecars do not form a valid DeepEquityEvidenceBundleV1");
  }
  assertBundleIdentity(bundle, report);
  assertBundleSourceReferences(bundle, report);
  return bundle;
}

function projectToShape(value: unknown, shape: unknown): unknown {
  if (Array.isArray(shape)) {
    return value;
  }
  if (!isRecord(shape) || !isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(shape).map(([key, childShape]) => [key, projectToShape(value[key], childShape)]),
  );
}

function bundlesConflict(
  existing: DeepEquityEvidenceBundleV1,
  legacy: DeepEquityEvidenceBundleV1,
): boolean {
  // Array order is intentionally significant; extra existing keys outside the legacy shape are ignored.
  return JSON.stringify(projectToShape(existing, legacy)) !== JSON.stringify(legacy);
}

async function writeBundleAtomically(
  path: string,
  bundle: DeepEquityEvidenceBundleV1,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    await rename(tempPath, path);
  } catch (error: unknown) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function migrateRun(
  runDir: string,
  write: boolean,
): Promise<"skipped" | "planned" | "written" | "unchanged"> {
  const reportArtifact = await readJsonArtifact(runDir, RUN_ARTIFACT_FILES.report);
  if (reportArtifact.status !== "ok" || !isDeepEquityReport(reportArtifact.value)) {
    return "skipped";
  }
  const report = validatedReport(reportArtifact.value);
  assertReportIdentity(report, basename(runDir));

  const existingArtifact = await readJsonArtifact(runDir, RUN_ARTIFACT_FILES.evidenceBundle);
  if (existingArtifact.status === "ok") {
    const existing = readDeepEquityEvidenceBundle(existingArtifact.value);
    if (existing !== undefined) {
      assertBundleIdentity(existing, report);
      assertBundleSourceReferences(existing, report);
      const requiredStates = await Promise.all(
        REQUIRED_COMPONENT_FILES.map((file) => readJsonArtifact(runDir, file)),
      );
      const presentRequiredCount = requiredStates.filter(
        (artifact) => artifact.status !== "absent",
      ).length;
      if (presentRequiredCount === 0) {
        return "unchanged";
      }
      if (presentRequiredCount !== REQUIRED_COMPONENT_FILES.length) {
        throw new Error("legacy sidecars are partially missing beside the existing bundle");
      }
      const legacy = await buildLegacyBundle(runDir, report);
      if (bundlesConflict(existing, legacy)) {
        throw new Error("refusing to overwrite a conflicting existing evidence bundle");
      }
      return "unchanged";
    }
  }

  const legacy = await buildLegacyBundle(runDir, report);
  if (!write) {
    return "planned";
  }
  await writeBundleAtomically(join(runDir, RUN_ARTIFACT_FILES.evidenceBundle), legacy);
  return "written";
}

export async function migrateDeepEquityEvidenceBundles(input: {
  readonly runsDir: string;
  readonly write?: boolean;
}): Promise<DeepEquityBundleMigrationResult> {
  const write = input.write === true;
  const entries = await readdir(input.runsDir, { withFileTypes: true }).catch(() => []);
  const runDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(input.runsDir, entry.name));
  let eligibleRunCount = 0;
  let plannedWriteCount = 0;
  let writtenCount = 0;
  let unchangedCount = 0;
  const failures: DeepEquityBundleMigrationFailure[] = [];
  const outcomes = await Promise.all(
    runDirs.map(async (runDir) => {
      try {
        return { runId: basename(runDir), status: await migrateRun(runDir, write) } as const;
      } catch (error) {
        return {
          runId: basename(runDir),
          error: error instanceof Error ? error.message : String(error),
        } as const;
      }
    }),
  );

  for (const outcome of outcomes) {
    if ("error" in outcome) {
      eligibleRunCount += 1;
      failures.push({ runId: outcome.runId, message: outcome.error });
    } else if (outcome.status !== "skipped") {
      eligibleRunCount += 1;
      if (outcome.status === "planned") {
        plannedWriteCount += 1;
      } else if (outcome.status === "written") {
        plannedWriteCount += 1;
        writtenCount += 1;
      } else {
        unchangedCount += 1;
      }
    }
  }

  return {
    mode: write ? "write" : "dry-run",
    scannedRunCount: runDirs.length,
    eligibleRunCount,
    plannedWriteCount,
    writtenCount,
    unchangedCount,
    failures,
  };
}
