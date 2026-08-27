import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  researchReportEvidenceQuality,
  type Prediction,
  type ResearchReport,
} from "./domain/types";
import {
  buildReportSearchEntries,
  predictionClaim,
  type ReportSearchScope,
} from "./report-search-entries";
import {
  readDepth,
  runSubsystemOutcomesFromSidecar,
  type RunSubsystemOutcomeLedger,
} from "./run-artifact-projection";
import { readJsonFile } from "./run-artifact-json-reader";
import { predictionShortfallGapCount } from "./report/prediction-shortfall";
import { loadRunArtifact, readReportMarketRegimeLabel } from "./run-artifacts";
import { RUN_ARTIFACT_FILES } from "./run-artifact-layout";
import type { MissAutopsyEntry, PredictionScore } from "./scoring/types";
import type {
  ArtifactFileRow,
  PredictionRow,
  RunIndexRows,
  RunRow,
  ScoreRow,
  SearchEntryRow,
  SubsystemOutcomeRow,
} from "./run-artifact-index-types";

function sourceIdsJson(sourceIds: readonly string[]): string {
  return JSON.stringify(sourceIds);
}

function indexedSearchKeySuffix(key: string, index: number): string {
  return `${key}:${String(index)}`;
}

function searchEntriesForReport(
  report: ResearchReport,
  scores: readonly PredictionScore[],
  scope: ReportSearchScope,
): readonly SearchEntryRow[] {
  return buildReportSearchEntries(report, scores, scope).map((entry) => {
    const id = `${entry.runId}:${scope}:${entry.section}:${entry.keySuffix}`;
    return {
      entry_key: `${scope}:${id}`,
      scope,
      id,
      run_id: entry.runId,
      generated_at: entry.generatedAt,
      job_type: entry.jobType,
      asset_class: entry.assetClass,
      symbol: entry.symbol ?? null,
      section: entry.section,
      label: entry.label,
      text: entry.text,
      source_ids_json: sourceIdsJson(entry.sourceIds),
      provider: entry.provider ?? null,
      source_kind: entry.sourceKind ?? null,
      prediction_id: entry.predictionId ?? null,
      sequence: entry.sequence,
    };
  });
}

async function listArtifactFiles(
  runDir: string,
  runId: string,
): Promise<readonly ArtifactFileRow[]> {
  const rows: ArtifactFileRow[] = [];

  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
          return;
        }
        if (!entry.isFile()) {
          return;
        }
        const metadata = await stat(fullPath);
        rows.push({
          run_id: runId,
          path: relative(runDir, fullPath).replaceAll("\\", "/"),
          size: metadata.size,
          modified_at: metadata.mtimeMs,
        });
      }),
    );
  }

  await visit(runDir);
  return rows.toSorted((left, right) => left.path.localeCompare(right.path));
}

function runRowFor(
  runDirName: string,
  loaded: Awaited<ReturnType<typeof loadRunArtifact>>,
  files: readonly ArtifactFileRow[],
  outcomesStatus: RunSubsystemOutcomeLedger["status"],
): RunRow {
  const { artifact } = loaded;
  if (artifact === undefined) {
    return {
      run_id: runDirName,
      run_dir_name: runDirName,
      generated_at: null,
      job_type: null,
      asset_class: null,
      symbol: null,
      evidence_quality: null,
      depth: null,
      market_regime_label: null,
      horizon_trading_days: null,
      finding_count: 0,
      prediction_count: 0,
      source_count: 0,
      data_gap_count: 0,
      has_score: files.some((file) => file.path === RUN_ARTIFACT_FILES.score) ? 1 : 0,
      report_status: files.some((file) => file.path === RUN_ARTIFACT_FILES.failure)
        ? "failed"
        : loaded.status.report,
      score_status: loaded.status.score,
      outcomes_status: outcomesStatus,
    };
  }
  const { report } = artifact;
  return {
    run_id: report.runId,
    run_dir_name: runDirName,
    generated_at: report.generatedAt,
    job_type: report.jobType,
    asset_class: report.assetClass,
    symbol: report.symbol?.toUpperCase() ?? null,
    evidence_quality: researchReportEvidenceQuality(report),
    depth: readDepth(report) ?? null,
    market_regime_label: readReportMarketRegimeLabel(report) ?? null,
    horizon_trading_days: report.horizonTradingDays ?? null,
    finding_count: report.keyFindings.length,
    prediction_count: report.predictions.length,
    source_count: report.sources.length,
    data_gap_count: predictionShortfallGapCount(report.predictionShortfall, report.dataGaps),
    has_score: files.some((file) => file.path === RUN_ARTIFACT_FILES.score) ? 1 : 0,
    report_status: loaded.status.report,
    score_status: loaded.status.score,
    outcomes_status: outcomesStatus,
  };
}

function predictionRowsFor(
  runId: string,
  predictions: readonly Prediction[],
): readonly PredictionRow[] {
  const seenIds = new Set<string>();
  return predictions.map((prediction, index) => {
    const id = seenIds.has(prediction.id)
      ? indexedSearchKeySuffix(prediction.id, index)
      : prediction.id;
    seenIds.add(prediction.id);
    return {
      id,
      run_id: runId,
      kind: prediction.kind,
      subject: prediction.subject,
      claim: predictionClaim(prediction),
      probability: prediction.probability,
      horizon_trading_days: prediction.horizonTradingDays,
      measurable_as: prediction.measurableAs,
      source_ids_json: sourceIdsJson(prediction.sourceIds),
    };
  });
}

function scoreRowsFor(
  runId: string,
  scores: readonly PredictionScore[],
  missAutopsies: readonly MissAutopsyEntry[],
): readonly ScoreRow[] {
  const causeByPrediction = new Map(
    missAutopsies.map((autopsy) => [autopsy.predictionId, autopsy.cause]),
  );
  return scores.map((score) => ({
    prediction_id: score.predictionId,
    run_id: runId,
    resolved: score.resolved ? 1 : 0,
    status: score.status ?? null,
    outcome: score.outcome ?? null,
    observed_at: score.observedAt ?? null,
    scoring_version: score.scoringVersion ?? null,
    miss_autopsy_cause: causeByPrediction.get(score.predictionId) ?? null,
  }));
}

export async function readRunSubsystemOutcomesFromDisk(
  runDir: string,
  runId: string,
): Promise<RunSubsystemOutcomeLedger> {
  const file = await readJsonFile(join(runDir, RUN_ARTIFACT_FILES.outcomes));
  return runSubsystemOutcomesFromSidecar(runId, file);
}

export async function indexRowsForRun(dataDir: string, runDirName: string): Promise<RunIndexRows> {
  const runDir = join(dataDir, runDirName);
  const loaded = await loadRunArtifact(runDir);
  const runId = loaded.artifact?.report.runId ?? runDirName;
  const [files, outcomes] = await Promise.all([
    listArtifactFiles(runDir, runId),
    readRunSubsystemOutcomesFromDisk(runDir, runId),
  ]);
  return {
    run: runRowFor(runDirName, loaded, files, outcomes.status),
    files,
    searchEntries:
      loaded.artifact === undefined
        ? []
        : [
            ...searchEntriesForReport(loaded.artifact.report, loaded.artifact.scores, "console"),
            ...searchEntriesForReport(loaded.artifact.report, loaded.artifact.scores, "history"),
          ],
    predictions:
      loaded.artifact === undefined
        ? []
        : predictionRowsFor(runId, loaded.artifact.report.predictions),
    scores:
      loaded.artifact === undefined
        ? []
        : scoreRowsFor(runId, loaded.artifact.scores, loaded.artifact.missAutopsies),
    outcomes: outcomes.outcomes.map(
      (outcome): SubsystemOutcomeRow => ({
        run_id: outcome.runId,
        subsystem: outcome.subsystem,
        expectation: outcome.expectation,
        outcome: outcome.outcome,
        code: outcome.code,
        stage: outcome.stage ?? null,
        count: outcome.count ?? null,
        detail_json: outcome.detail === undefined ? null : JSON.stringify(outcome.detail),
      }),
    ),
  };
}
