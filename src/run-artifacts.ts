import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  MarketSnapshot,
  ResearchReport,
  SourceGap,
  SubjectKind,
  VerifiedMarketSnapshot,
} from "./domain/types";
import {
  RUN_ARTIFACT_FILES,
  type ArtifactFileStatus,
  type JsonFileResult,
} from "./run-artifact-layout";
import {
  isDeepEquityReport,
  readDeepEquityEvidenceBundle,
  unresolvedDeepEquityBundleSourceIds,
} from "./deep-equity/artifact-schema";
import type { DeepEquityEvidenceBundleV1 } from "./deep-equity/types";
import type { MissAutopsyEntry, PredictionScore } from "./scoring/types";
import type {
  EvidenceLanesArtifact,
  SourceLedgerArtifact,
  SourcePlanArtifact,
} from "./research/source-plan";
import type { FinancialLensArtifact } from "./sources/extended-evidence/financial-lens";
import {
  readFinancialStatementsArtifact,
  type FinancialStatementsArtifact,
} from "./sources/extended-evidence/financial-statements-contract";
import {
  readSubsequentFinancingBridgeArtifact,
  type SubsequentFinancingBridgeArtifact,
} from "./sources/extended-evidence/subsequent-financing";
import {
  readCapitalOwnershipArtifact,
  type CapitalOwnershipArtifact,
} from "./sources/extended-evidence/capital-ownership";
import type { PeerImpliedRange } from "./sources/extended-evidence/valuation-comps";
import {
  readValuationWorkbenchArtifact,
  type ValuationWorkbenchArtifact,
} from "./sources/extended-evidence/valuation-workbench-contract";
import {
  readReverseDcfArtifact,
  type ReverseDcfArtifact,
} from "./sources/extended-evidence/reverse-dcf";
import type { ReadArtifact } from "./sources/extended-evidence/utils";
import type { FundamentalHistoryArtifact } from "./sources/extended-evidence/fundamental-history";
import type { BusinessFrameworkArtifact } from "./sources/extended-evidence/business-framework";
// Import the public profile contract leaf directly, not the ./web-evidence barrel.
// The web-evidence phase reuses this reader, while its barrel eagerly exports that phase.
// Importing the barrel here would form a run-artifacts → phase → profile-reuse → run-artifacts cycle.
import type { WebSubjectProfileArtifact } from "./web-evidence/contract";
import { readReport, readSourceGaps } from "./run-artifact-report-reader";
import {
  readSnapshots,
  readVerifiedMarketSnapshot,
  readVerifiedMarketSnapshots,
} from "./run-artifact-snapshot-reader";
import { readMissAutopsies, readScores } from "./run-artifact-score-reader";
import { readAnalytics } from "./run-artifact-analytics-reader";
import { readJsonFile } from "./run-artifact-json-reader";
import {
  readBusinessFrameworkArtifact,
  readEvidenceLanes,
  readFinancialLensesArtifact,
  readFundamentalHistoryArtifact,
  readPeerImpliedRange,
  readSourceLedger,
  readSourcePlan,
  readThemeCatalysts,
  readWebSubjectProfileArtifact,
  type ThemeCatalystItem,
} from "./run-artifact-evidence-reader";
import { isRecord } from "./guards";

export { readReportMarketRegimeLabel, readSourceGapAttempts } from "./run-artifact-report-reader";
export { isMissAutopsyCause } from "./run-artifact-score-reader";

// ---------------------------------------------------------------------------
// Run Artifact reader — the single read seam for persisted research runs under
// MARKET_BOT_DATA_DIR/<run-id>/. Parses report.json, score.json, and normalized
// Market snapshots once, leniently, at full fidelity. Callers project down to
// What they need. Reading is intentionally tolerant: older artifacts predate the
// Current schema, and report/schema.ts only validates on write. See ADR 0002.
// The per-artifact shape readers live in the run-artifact-*-reader leaves; this
// Module owns the file IO, the run directory layout, and assembly.
// ---------------------------------------------------------------------------

interface RunArtifactStatus {
  readonly report: ArtifactFileStatus;
  readonly score: ArtifactFileStatus;
  readonly evidenceBundle?: ArtifactFileStatus;
}

// The parsed core of one run directory. Only produced when report.json loads
// (status.report === "ok"). History/alpha-specific files (supplemental
// Snapshots, SEC fundamentals, alpha validation) are read by their one caller,
// Not here.
export interface RunArtifact {
  readonly runDirName: string;
  readonly report: ResearchReport;
  readonly scores: readonly PredictionScore[];
  readonly missAutopsies: readonly MissAutopsyEntry[];
  readonly marketSnapshots: readonly MarketSnapshot[];
  readonly sourceGaps: readonly SourceGap[];
  readonly verifiedMarketSnapshot?: VerifiedMarketSnapshot;
  readonly verifiedRepresentativeSnapshots?: readonly VerifiedMarketSnapshot[];
  readonly themeCatalysts?: readonly ThemeCatalystItem[];
  readonly sourcePlan?: SourcePlanArtifact;
  readonly evidenceLanes?: EvidenceLanesArtifact;
  readonly sourceLedger?: SourceLedgerArtifact;
  readonly financialLenses?: FinancialLensArtifact;
  readonly financialStatements?: ReadArtifact<FinancialStatementsArtifact>;
  readonly subsequentFinancing?: ReadArtifact<SubsequentFinancingBridgeArtifact>;
  readonly capitalOwnership?: ReadArtifact<CapitalOwnershipArtifact>;
  readonly peerImpliedRange?: PeerImpliedRange;
  readonly valuationWorkbench?: ReadArtifact<ValuationWorkbenchArtifact>;
  readonly reverseDcf?: ReadArtifact<ReverseDcfArtifact>;
  readonly fundamentalHistory?: FundamentalHistoryArtifact;
  readonly businessFramework?: BusinessFrameworkArtifact;
  readonly webSubjectProfile?: WebSubjectProfileArtifact;
  readonly deepEquityEvidenceBundle?: DeepEquityEvidenceBundleV1;
  readonly status: RunArtifactStatus;
}

// Status for every scanned directory, including those without a loadable report.
// Callers fold these into their own audit counts.
interface RunScanEntry {
  readonly runDirName: string;
  readonly status: RunArtifactStatus;
}

export interface RunArtifactScan {
  // Report-"ok" runs only.
  readonly artifacts: readonly RunArtifact[];
  // One entry per scanned directory.
  readonly entries: readonly RunScanEntry[];
}

export interface WebSubjectProfileRunArtifact {
  readonly runDirName: string;
  readonly report: ResearchReport;
  readonly webSubjectProfile: WebSubjectProfileArtifact;
  readonly analytics?: unknown;
}

export interface LoadedRunArtifact {
  readonly artifact?: RunArtifact;
  readonly status: RunArtifactStatus;
}

export type LoadedDeepEquityEvidenceBundle =
  | { readonly status: "ok"; readonly value: DeepEquityEvidenceBundleV1 }
  | { readonly status: "absent" | "malformed" };

function scoreStatusFor(
  file: JsonFileResult,
  parsed: readonly PredictionScore[] | undefined,
): ArtifactFileStatus {
  if (file.status === "absent") {
    return "absent";
  }
  return parsed === undefined ? "malformed" : "ok";
}

function readBundleOrSidecar<T>(
  deepEquity: boolean,
  bundleValue: unknown,
  sidecarFile: JsonFileResult | undefined,
  reader: (value: unknown) => T | undefined,
): T | undefined {
  if (deepEquity) {
    return reader(bundleValue);
  }
  return sidecarFile?.status === "ok" ? reader(sidecarFile.value) : undefined;
}

const REPORT_FILE = RUN_ARTIFACT_FILES.report;
const SCORE_FILE = RUN_ARTIFACT_FILES.score;
const MISS_AUTOPSY_FILE = RUN_ARTIFACT_FILES.missAutopsy;
const MARKET_SNAPSHOTS_FILE = RUN_ARTIFACT_FILES.marketSnapshots;
const SOURCE_GAPS_FILE = RUN_ARTIFACT_FILES.sourceGaps;
const VERIFIED_MARKET_SNAPSHOT_FILE = RUN_ARTIFACT_FILES.verifiedMarketSnapshot;
const VERIFIED_REPRESENTATIVE_SNAPSHOTS_FILE = RUN_ARTIFACT_FILES.verifiedRepresentativeSnapshots;
const THEME_CATALYSTS_FILE = RUN_ARTIFACT_FILES.themeCatalysts;
const SOURCE_PLAN_FILE = RUN_ARTIFACT_FILES.sourcePlan;
const EVIDENCE_LANES_FILE = RUN_ARTIFACT_FILES.evidenceLanes;
const SOURCE_LEDGER_FILE = RUN_ARTIFACT_FILES.sourceLedger;
const FINANCIAL_LENSES_FILE = RUN_ARTIFACT_FILES.financialLenses;
const FINANCIAL_STATEMENTS_FILE = RUN_ARTIFACT_FILES.financialStatements;
const SUBSEQUENT_FINANCING_FILE = RUN_ARTIFACT_FILES.subsequentFinancing;
const CAPITAL_OWNERSHIP_FILE = RUN_ARTIFACT_FILES.capitalOwnership;
const VALUATION_COMPS_FILE = RUN_ARTIFACT_FILES.valuationComps;
const VALUATION_WORKBENCH_FILE = RUN_ARTIFACT_FILES.valuationWorkbench;
const REVERSE_DCF_FILE = RUN_ARTIFACT_FILES.reverseDcf;
const FUNDAMENTAL_HISTORY_FILE = RUN_ARTIFACT_FILES.fundamentalHistory;
const BUSINESS_FRAMEWORK_FILE = RUN_ARTIFACT_FILES.businessFramework;
const WEB_SUBJECT_PROFILE_FILE = RUN_ARTIFACT_FILES.webSubjectProfile;
const EVIDENCE_BUNDLE_FILE = RUN_ARTIFACT_FILES.evidenceBundle;

export async function loadDeepEquityEvidenceBundle(
  runDir: string,
  additionalKnownSourceIds: readonly string[] = [],
): Promise<LoadedDeepEquityEvidenceBundle> {
  const file = await readJsonFile(join(runDir, EVIDENCE_BUNDLE_FILE));
  if (file.status !== "ok") {
    return { status: file.status };
  }
  const bundle = readDeepEquityEvidenceBundle(file.value);
  if (
    bundle === undefined ||
    unresolvedDeepEquityBundleSourceIds(bundle, additionalKnownSourceIds).length > 0
  ) {
    return { status: "malformed" };
  }
  return { status: "ok", value: bundle };
}

// Reads one run directory. Returns an artifact only when report.json loads to a
// Valid report; score.json is read only in that case (matching the historical
// Short-circuit so audit counts stay stable).
export async function loadRunArtifact(runDir: string): Promise<LoadedRunArtifact> {
  const runDirName = basename(runDir);
  const reportFile = await readJsonFile(join(runDir, REPORT_FILE));
  const report = reportFile.status === "ok" ? readReport(reportFile.value) : undefined;
  if (report === undefined) {
    // ENOENT stays "absent"; a present-but-bad report becomes "malformed".
    const reportStatus: ArtifactFileStatus =
      reportFile.status === "absent" ? "absent" : "malformed";
    return { status: { report: reportStatus, score: "absent" } };
  }

  const deepEquity = isDeepEquityReport(report);
  const deepEquityEvidenceBundleFile = deepEquity
    ? await loadDeepEquityEvidenceBundle(
        runDir,
        report.sources.map((source) => source.id),
      )
    : undefined;
  const deepEquityEvidenceBundle =
    deepEquityEvidenceBundleFile?.status === "ok" ? deepEquityEvidenceBundleFile.value : undefined;
  const scoreFile = await readJsonFile(join(runDir, SCORE_FILE));
  const parsedScores = scoreFile.status === "ok" ? readScores(scoreFile.value) : undefined;
  const missAutopsyFile = await readJsonFile(join(runDir, MISS_AUTOPSY_FILE));
  const snapshotFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, MARKET_SNAPSHOTS_FILE));
  const sourceGapsFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, SOURCE_GAPS_FILE));
  const verifiedSnapshotFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, VERIFIED_MARKET_SNAPSHOT_FILE));
  const verifiedRepresentativeSnapshotsFile = await readJsonFile(
    join(runDir, VERIFIED_REPRESENTATIVE_SNAPSHOTS_FILE),
  );
  const themeCatalystsFile = await readJsonFile(join(runDir, THEME_CATALYSTS_FILE));
  const sourcePlanFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, SOURCE_PLAN_FILE));
  const evidenceLanesFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, EVIDENCE_LANES_FILE));
  const sourceLedgerFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, SOURCE_LEDGER_FILE));
  const financialLensesFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, FINANCIAL_LENSES_FILE));
  const financialStatementsFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, FINANCIAL_STATEMENTS_FILE));
  const subsequentFinancingFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, SUBSEQUENT_FINANCING_FILE));
  const capitalOwnershipFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, CAPITAL_OWNERSHIP_FILE));
  const valuationCompsFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, VALUATION_COMPS_FILE));
  const valuationWorkbenchFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, VALUATION_WORKBENCH_FILE));
  const reverseDcfFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, REVERSE_DCF_FILE));
  const fundamentalHistoryFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, FUNDAMENTAL_HISTORY_FILE));
  const businessFrameworkFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, BUSINESS_FRAMEWORK_FILE));
  const webSubjectProfileFile = deepEquity
    ? undefined
    : await readJsonFile(join(runDir, WEB_SUBJECT_PROFILE_FILE));
  const status: RunArtifactStatus = {
    report: "ok",
    score: scoreStatusFor(scoreFile, parsedScores),
    ...(deepEquityEvidenceBundleFile !== undefined
      ? { evidenceBundle: deepEquityEvidenceBundleFile.status }
      : {}),
  };
  const verifiedMarketSnapshot = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.evidence.verifiedMarketSnapshot,
    verifiedSnapshotFile,
    readVerifiedMarketSnapshot,
  );
  const verifiedRepresentativeSnapshots =
    verifiedRepresentativeSnapshotsFile.status === "ok"
      ? readVerifiedMarketSnapshots(verifiedRepresentativeSnapshotsFile.value)
      : readVerifiedMarketSnapshots(report.verifiedRepresentativeSnapshots);
  const themeCatalysts =
    themeCatalystsFile.status === "ok" ? readThemeCatalysts(themeCatalystsFile.value) : [];
  const sourcePlan = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.governance.sourcePlan,
    sourcePlanFile,
    readSourcePlan,
  );
  const sourceGaps = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.governance.sourceGaps,
    sourceGapsFile,
    readSourceGaps,
  );
  const evidenceLanes = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.governance.evidenceLanes,
    evidenceLanesFile,
    readEvidenceLanes,
  );
  const sourceLedger = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.governance.sourceLedger,
    sourceLedgerFile,
    readSourceLedger,
  );
  const financialLenses = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.derived.financialLenses,
    financialLensesFile,
    readFinancialLensesArtifact,
  );
  const financialStatements = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.derived.financialStatements,
    financialStatementsFile,
    readFinancialStatementsArtifact,
  );
  const subsequentFinancing = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.derived.subsequentFinancing,
    subsequentFinancingFile,
    readSubsequentFinancingBridgeArtifact,
  );
  const capitalOwnership = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.derived.capitalOwnership,
    capitalOwnershipFile,
    readCapitalOwnershipArtifact,
  );
  const peerImpliedRange = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.derived.valuationComps,
    valuationCompsFile,
    readPeerImpliedRange,
  );
  const valuationWorkbench = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.derived.valuationWorkbench,
    valuationWorkbenchFile,
    readValuationWorkbenchArtifact,
  );
  const reverseDcf = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.derived.reverseDcf,
    reverseDcfFile,
    readReverseDcfArtifact,
  );
  const fundamentalHistory = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.derived.fundamentalHistory,
    fundamentalHistoryFile,
    readFundamentalHistoryArtifact,
  );
  const businessFramework = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.derived.businessFramework,
    businessFrameworkFile,
    readBusinessFrameworkArtifact,
  );
  const webSubjectProfile = readBundleOrSidecar(
    deepEquity,
    deepEquityEvidenceBundle?.evidence.webSubjectProfile,
    webSubjectProfileFile,
    readWebSubjectProfileArtifact,
  );
  const observationDrops = [
    financialStatements,
    subsequentFinancing,
    capitalOwnership,
    valuationWorkbench,
    reverseDcf,
  ].flatMap((artifact) => artifact?.readDiagnostics?.drops ?? []);
  const droppedObservationCount = observationDrops.reduce((sum, drop) => sum + drop.count, 0);
  const readableReport =
    droppedObservationCount === 0
      ? report
      : {
          ...report,
          dataGaps: [
            ...report.dataGaps,
            `Artifact observations unavailable: ${String(droppedObservationCount)} ${droppedObservationCount === 1 ? "observation" : "observations"} dropped (${observationDrops.map((drop) => `${drop.reason}: ${String(drop.count)}`).join(", ")}).`,
          ],
        };

  return {
    artifact: {
      runDirName,
      report: readableReport,
      scores: parsedScores ?? [],
      missAutopsies: readMissAutopsies(missAutopsyFile.value),
      marketSnapshots: deepEquity
        ? readSnapshots(deepEquityEvidenceBundle?.evidence.marketSnapshots)
        : readSnapshots(snapshotFile?.value),
      sourceGaps: sourceGaps ?? [],
      ...(verifiedMarketSnapshot !== undefined ? { verifiedMarketSnapshot } : {}),
      ...(verifiedRepresentativeSnapshots.length > 0 ? { verifiedRepresentativeSnapshots } : {}),
      ...(themeCatalysts.length > 0 ? { themeCatalysts } : {}),
      ...(sourcePlan !== undefined ? { sourcePlan } : {}),
      ...(evidenceLanes !== undefined ? { evidenceLanes } : {}),
      ...(sourceLedger !== undefined ? { sourceLedger } : {}),
      ...(financialLenses !== undefined ? { financialLenses } : {}),
      ...(financialStatements !== undefined ? { financialStatements } : {}),
      ...(subsequentFinancing !== undefined ? { subsequentFinancing } : {}),
      ...(capitalOwnership !== undefined ? { capitalOwnership } : {}),
      ...(peerImpliedRange !== undefined ? { peerImpliedRange } : {}),
      ...(valuationWorkbench !== undefined ? { valuationWorkbench } : {}),
      ...(reverseDcf !== undefined ? { reverseDcf } : {}),
      ...(fundamentalHistory !== undefined ? { fundamentalHistory } : {}),
      ...(businessFramework !== undefined ? { businessFramework } : {}),
      ...(webSubjectProfile !== undefined ? { webSubjectProfile } : {}),
      ...(deepEquityEvidenceBundle !== undefined ? { deepEquityEvidenceBundle } : {}),
      status,
    },
    status,
  };
}

// Scans every run directory under dataDir in one pass. A missing dataDir yields
// An empty scan.
async function scanRunArtifactsFromDisk(dataDir: string): Promise<RunArtifactScan> {
  const dirEntries = await readdir(dataDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return [] as Dirent[];
    }
    throw error;
  });

  const dirs = dirEntries.filter((entry) => entry.isDirectory());
  const loaded = await Promise.all(
    dirs.map(async (entry) => ({
      name: entry.name,
      result: await loadRunArtifact(join(dataDir, entry.name)),
    })),
  );

  return {
    artifacts: loaded.flatMap((item) =>
      item.result.artifact === undefined ? [] : [item.result.artifact],
    ),
    entries: loaded.map((item) => ({ runDirName: item.name, status: item.result.status })),
  };
}

// Full artifact scans always read from disk until the index can hydrate RunArtifact payloads.
export async function scanRunArtifacts(dataDir: string): Promise<RunArtifactScan> {
  return await scanRunArtifactsFromDisk(dataDir);
}

async function readWebSubjectProfileForRun(
  runDir: string,
  report: ResearchReport,
): Promise<WebSubjectProfileArtifact | undefined> {
  if (isDeepEquityReport(report)) {
    const bundleFile = await loadDeepEquityEvidenceBundle(
      runDir,
      report.sources.map((source) => source.id),
    );
    return bundleFile.status === "ok"
      ? readWebSubjectProfileArtifact(bundleFile.value.evidence.webSubjectProfile)
      : undefined;
  }
  const profileFile = await readJsonFile(join(runDir, WEB_SUBJECT_PROFILE_FILE));
  return profileFile.status === "ok" ? readWebSubjectProfileArtifact(profileFile.value) : undefined;
}

export async function scanWebSubjectProfileRunArtifacts(
  dataDir: string,
  input: {
    readonly subjectKind: SubjectKind;
    readonly subjectId: string;
    // Research CLI emits deep theme profiles today; brief remains readable for older artifacts and direct callers.
    readonly depth: "brief" | "deep";
  },
): Promise<readonly WebSubjectProfileRunArtifact[]> {
  const dirEntries = await readdir(dataDir, { withFileTypes: true }).catch((error: unknown) => {
    if (isRecord(error) && error.code === "ENOENT") {
      return [] as Dirent[];
    }
    throw error;
  });

  const reportCandidates = await Promise.all(
    dirEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const runDir = join(dataDir, entry.name);
        const reportFile = await readJsonFile(join(runDir, REPORT_FILE));
        const report = reportFile.status === "ok" ? readReport(reportFile.value) : undefined;
        if (
          report === undefined ||
          report.extras?.depth !== input.depth ||
          !reportMatchesWebSubjectKind(report, input.subjectKind)
        ) {
          return;
        }
        return { runDir, runDirName: entry.name, report };
      }),
  );

  const profileCandidates = await Promise.all(
    reportCandidates.flatMap((candidate) =>
      candidate === undefined
        ? []
        : [
            (async () => {
              const analyticsFile = await readAnalytics(candidate.runDir);
              const webSubjectProfile = await readWebSubjectProfileForRun(
                candidate.runDir,
                candidate.report,
              );
              return webSubjectProfile === undefined ||
                webSubjectProfile.subjectKind !== input.subjectKind ||
                webSubjectProfile.subjectId.toUpperCase() !== input.subjectId.toUpperCase()
                ? undefined
                : {
                    runDirName: candidate.runDirName,
                    report: candidate.report,
                    webSubjectProfile,
                    ...(analyticsFile.status === "ok" ? { analytics: analyticsFile.value } : {}),
                  };
            })(),
          ],
    ),
  );

  return profileCandidates.flatMap((candidate) => (candidate === undefined ? [] : [candidate]));
}

function reportMatchesWebSubjectKind(report: ResearchReport, subjectKind: SubjectKind): boolean {
  if (subjectKind === "company") {
    return report.jobType === "equity";
  }
  if (subjectKind === "crypto-asset") {
    return report.jobType === "crypto";
  }
  return report.jobType === "research";
}
