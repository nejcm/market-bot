import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  readDeepEquityEvidenceBundle,
  unresolvedDeepEquityBundleSourceIds,
  isDeepEquityReport,
} from "../deep-equity/artifact-schema";
import { readReport } from "../run-artifact-report-reader";
import { RUN_ARTIFACT_FILES } from "../run-artifact-layout";
import {
  projectExtendedEvidenceReportExtras,
  EXTENDED_EVIDENCE_EXTRA_KEYS,
} from "../research/extended-evidence-projections";
import { assertSafeReportLanguage, validateResearchReport } from "../report/schema";
import { assertNoUnresolvedMetricReferences } from "../research/metric-references";
import { renderMarkdownReport } from "../report/markdown";
import type { CollectedSources } from "../sources/types";
import type { ResearchReport } from "../domain/report";
import { freshEvalDir, writeEvalJson } from "./eval-output";

async function readJson(path: string, optional = false): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (
      optional &&
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function normalizedSources(
  runDir: string,
  deep: boolean,
  sourceIds: ReadonlySet<string>,
): Promise<CollectedSources> {
  const marketContext = await readJson(join(runDir, RUN_ARTIFACT_FILES.marketContext));
  if (deep) {
    const bundle = readDeepEquityEvidenceBundle(
      await readJson(join(runDir, RUN_ARTIFACT_FILES.evidenceBundle)),
    );
    if (
      bundle === undefined ||
      unresolvedDeepEquityBundleSourceIds(bundle, [...sourceIds]).length > 0
    ) {
      throw new Error("Invalid normalized evidence bundle or unresolved source ids");
    }
    return {
      ...bundle.evidence,
      ...bundle.derived,
      rawSnapshots: [],
      marketContextSources: [],
      sourceGaps: bundle.governance.sourceGaps,
      ...(marketContext === null || marketContext === undefined
        ? {}
        : { marketContext: marketContext as NonNullable<CollectedSources["marketContext"]> }),
    };
  }
  const keys = [
    "marketSnapshots",
    "supplementalMarketSnapshots",
    "newsSources",
    "extendedSources",
    "sourceGaps",
    "extendedEvidence",
    "verifiedMarketSnapshot",
    "verifiedRepresentativeSnapshots",
    "resolvedSubject",
    "valuationComps",
    "valuationWorkbench",
    "reverseDcf",
    "financialLenses",
    "fundamentalHistory",
    "financialStatements",
    "untaggedFinancialStatements",
    "subsequentFinancing",
    "capitalOwnership",
    "businessFramework",
    "webSubjectProfile",
  ] as const;
  const required = new Set<string>([
    "marketSnapshots",
    "supplementalMarketSnapshots",
    "newsSources",
    "extendedSources",
    "sourceGaps",
    "extendedEvidence",
    "webSubjectProfile",
  ]);
  const report = readReport(await readJson(join(runDir, RUN_ARTIFACT_FILES.report)))!;
  if (report.jobType === "equity" || report.jobType === "crypto") {
    [
      "verifiedMarketSnapshot",
      "valuationComps",
      "valuationWorkbench",
      "reverseDcf",
      "financialLenses",
      "fundamentalHistory",
      "financialStatements",
      "businessFramework",
    ].forEach((key) => required.add(key));
  }
  const entries = await Promise.all(
    keys.map(
      async (key) =>
        [key, await readJson(join(runDir, RUN_ARTIFACT_FILES[key]), !required.has(key))] as const,
    ),
  );
  const values = Object.fromEntries(
    entries.filter(([, value]) => value !== null && value !== undefined),
  );
  for (const key of [
    "marketSnapshots",
    "supplementalMarketSnapshots",
    "newsSources",
    "extendedSources",
    "sourceGaps",
  ]) {
    if (!Array.isArray(values[key])) {
      throw new TypeError(`Missing normalized input: ${key}`);
    }
  }
  return {
    ...values,
    rawSnapshots: [],
    marketContextSources: [],
    ...(report.extras?.earningsSetup === undefined
      ? {}
      : { earningsSetup: report.extras.earningsSetup }),
    ...(report.extras?.metricSections === undefined
      ? {}
      : { metricSections: report.extras.metricSections }),
    ...(marketContext === null || marketContext === undefined ? {} : { marketContext }),
  } as unknown as CollectedSources;
}

export interface ReprojectedRun {
  readonly report: ResearchReport;
  readonly markdown: string;
}

// Re-projects a saved run's report extras at the current code; throws when the run cannot be rebuilt.
export async function reprojectRun(runDir: string): Promise<ReprojectedRun> {
  const original = readReport(await readJson(join(runDir, RUN_ARTIFACT_FILES.report)));
  if (original === undefined) {
    throw new Error("Past run has no readable report");
  }
  const collected = await normalizedSources(
    runDir,
    isDeepEquityReport(original),
    new Set(original.sources.map((source) => source.id)),
  );
  const report = validateResearchReport({
    ...original,
    extras: {
      ...Object.fromEntries(
        Object.entries(original.extras ?? {}).filter(
          ([key]) => !EXTENDED_EVIDENCE_EXTRA_KEYS.has(key),
        ),
      ),
      ...projectExtendedEvidenceReportExtras({
        modelExtras: original.extras ?? {},
        collectedSources: collected,
      }),
    },
  });
  assertNoUnresolvedMetricReferences(report, collected);
  assertSafeReportLanguage(report);
  const snapshot = collected.marketSnapshots.find((row) => row.symbol === report.symbol);
  return { report, markdown: renderMarkdownReport(report, snapshot, collected) };
}

export async function rerunReport(options: {
  readonly run: string;
  readonly label: string;
  readonly root?: string;
}): Promise<{
  readonly status: "completed" | "failed";
  readonly dir: string;
  readonly durationMs: number;
}> {
  const runDir = options.run.includes("/")
    ? resolve(options.run)
    : resolve(import.meta.dir, "../../data/runs", options.run);
  if (readReport(await readJson(join(runDir, RUN_ARTIFACT_FILES.report))) === undefined) {
    throw new Error("Past run has no readable report");
  }
  const dir = await freshEvalDir(options.label, options.root);
  const started = performance.now();
  let status: "completed" | "failed" = "completed";
  let failureMessage: string | undefined = undefined;
  try {
    const { report, markdown } = await reprojectRun(runDir);
    await writeEvalJson(dir, "report.json", report);
    await writeFile(join(dir, "report.md"), markdown);
    await writeEvalJson(dir, "validation.json", {
      schema: "passed",
      researchLanguage: "passed",
      sourceIds: "passed",
    });
  } catch (error) {
    status = "failed";
    failureMessage = error instanceof Error ? error.message : String(error);
  }
  const durationMs = performance.now() - started;
  await writeEvalJson(dir, "eval-sample.json", {
    status,
    scope: "report-projection-only",
    partial: true,
    runDir,
    durationMs,
    error: failureMessage,
    modelCalls: { live: 0, replayed: 0 },
  });
  return { status, dir, durationMs };
}
