import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { listRunDirNames } from "../src/data-paths";
import { RUN_ARTIFACT_FILES } from "../src/run-artifact-layout";
import { loadRunArtifact } from "../src/run-artifacts";
import { runEvalSample } from "../src/replay/eval-run";
import type { CollectedSources } from "../src/sources/types";
import { depositoryIssuerSic } from "../src/sources/extended-evidence/industry-classification";
import {
  reportInvariantViolations,
  type MetricSections,
  type ReportViolation,
} from "../src/corpus/report-invariants";
import {
  diffLedgers,
  formatLedgerDiff,
  parseLedger,
  serializeLedger,
  type LedgerRow,
} from "./sec-value-ledger";

interface RunViolation extends ReportViolation {
  readonly run: string;
  readonly symbol: string;
}

function ledgerStatus(status: string | undefined): LedgerRow["status"] {
  if (status === "value") {
    return "published";
  }
  return status === "not-meaningful" || status === "not-applicable" ? status : "missing";
}

export function reportLedgerRows(
  run: string,
  symbol: string,
  sections: MetricSections,
): readonly LedgerRow[] {
  const seen = new Map<string, number>();
  return sections.flatMap((section) =>
    section.metrics.map((metric): LedgerRow => {
      const base = `${section.id ?? ""}/${metric.id ?? ""}`;
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      return {
        cik: run,
        symbol,
        metric: count === 0 ? base : `${base}#${count}`,
        period: metric.periodEnd ?? "",
        status: ledgerStatus(metric.status),
        value: metric.value ?? null,
        unit: metric.unit ?? null,
        currency: metric.currency ?? null,
        reason: metric.reason ?? null,
        accession: null,
        firstPublicAt: null,
        detail: null,
      };
    }),
  );
}

interface ReportSweep {
  readonly runs: number;
  readonly replayed: number;
  readonly withSections: number;
  readonly noCapture: readonly string[];
  readonly upstreamOnly: readonly { readonly run: string; readonly error: string }[];
  readonly failures: readonly { readonly run: string; readonly error: string }[];
  readonly violationCounts: Readonly<Record<string, number>>;
  readonly violations: readonly RunViolation[];
  readonly ledger: readonly LedgerRow[];
}

interface ReplayedReport {
  readonly symbol?: string;
  readonly generatedAt?: string;
  readonly extras?: { readonly metricSections?: unknown };
  readonly extendedEvidence?: unknown;
}

interface SweptRun {
  readonly symbol: string;
  readonly sections: unknown;
  readonly snapshots: Parameters<typeof reportInvariantViolations>[1];
  readonly extendedEvidence: unknown;
  readonly generatedAt: string | undefined;
  // Set when only final-synthesis missed: sections come from the synthesis input, not a report.
  readonly upstreamOnlyError?: string;
}

interface SynthesisInput {
  readonly command?: { readonly symbol?: string };
  readonly collectedSources?: CollectedSources;
  readonly generatedAt?: string;
}

async function replayRun(runsDir: string, run: string, root: string): Promise<SweptRun> {
  const captured: { synthesisInput?: SynthesisInput } = {};
  const result = await runEvalSample({
    root,
    label: "sweep",
    fixture: join(runsDir, run, "replay"),
    sample: "1",
    llm: "replay",
    onSynthesisInput: (input) => {
      captured.synthesisInput = input as SynthesisInput;
    },
  });
  const error = `${result.status}: ${result.error ?? "no published run"}`;
  if (result.status === "completed" && result.runDir !== undefined) {
    const report = (await Bun.file(
      join(result.runDir, RUN_ARTIFACT_FILES.report),
    ).json()) as ReplayedReport;
    const { artifact } = await loadRunArtifact(result.runDir);
    return {
      symbol: report.symbol ?? "",
      sections: report.extras?.metricSections,
      snapshots: artifact?.marketSnapshots ?? [],
      extendedEvidence: report.extendedEvidence,
      generatedAt: report.generatedAt,
    };
  }
  const collected = captured.synthesisInput?.collectedSources;
  const { keys } = result.modelReplayMisses;
  if (
    collected === undefined ||
    result.cassetteMisses.count > 0 ||
    keys.length === 0 ||
    !keys.every((key) => key.startsWith("final-synthesis|")) ||
    /Replay state/iu.test(result.error ?? "")
  ) {
    throw new Error(error);
  }
  return {
    symbol: captured.synthesisInput?.command?.symbol ?? "",
    sections: collected.metricSections,
    snapshots: collected.marketSnapshots,
    extendedEvidence: collected.extendedEvidence,
    generatedAt: captured.synthesisInput?.generatedAt,
    upstreamOnlyError: error,
  };
}

export async function sweepReports(runsDir: string, root: string): Promise<ReportSweep> {
  const names = await listRunDirNames(runsDir);
  const noCapture: string[] = [];
  const upstreamOnly: { run: string; error: string }[] = [];
  const failures: { run: string; error: string }[] = [];
  const violations: RunViolation[] = [];
  const ledger: LedgerRow[] = [];
  let replayed = 0;
  let withSections = 0;
  for (const run of names) {
    if (!existsSync(join(runsDir, run, "replay"))) {
      noCapture.push(run);
      continue;
    }
    let replay: SweptRun;
    try {
      // oxlint-disable-next-line no-await-in-loop -- samples share process-level index overrides
      replay = await replayRun(runsDir, run, root);
    } catch (error) {
      failures.push({ run, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (replay.upstreamOnlyError === undefined) {
      replayed += 1;
    } else {
      upstreamOnly.push({ run, error: replay.upstreamOnlyError });
    }
    const { symbol, sections, snapshots } = replay;
    if (!Array.isArray(sections)) {
      continue;
    }
    withSections += 1;
    ledger.push(...reportLedgerRows(run, symbol, sections as MetricSections));
    violations.push(
      ...reportInvariantViolations(
        sections as MetricSections,
        snapshots,
        depositoryIssuerSic(replay.extendedEvidence),
        replay.generatedAt,
      ).map((violation) => ({
        run,
        symbol,
        ...violation,
      })),
    );
  }
  const violationCounts: Record<string, number> = {};
  for (const { invariant } of violations) {
    violationCounts[invariant] = (violationCounts[invariant] ?? 0) + 1;
  }
  return {
    runs: names.length,
    replayed,
    withSections,
    noCapture,
    upstreamOnly,
    failures,
    violationCounts,
    violations,
    ledger,
  };
}

function formatCountDiff(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): string {
  const lines = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .toSorted()
    .map((name) => `  ${name}: ${before[name] ?? 0} -> ${after[name] ?? 0}`);
  return `Invariant counts (baseline -> current):\n${lines.join("\n") || "  none"}\n`;
}

const rejectNetwork = (): never => {
  throw new Error("Report sweep forbids network access");
};

if (import.meta.main) {
  globalThis.fetch = Object.assign(rejectNetwork, { preconnect: rejectNetwork });
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "runs-dir": { type: "string", default: "data/runs" },
      "out-dir": { type: "string", default: "data/sweeps" },
      diff: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const baselineLedger =
    values.diff === undefined ? undefined : parseLedger(await Bun.file(values.diff).text());
  const baselineJson =
    values.diff === undefined
      ? undefined
      : ((await Bun.file(values.diff.replace(/\.ledger\.jsonl$/u, ".json")).json()) as ReportSweep);
  const started = performance.now();
  const root = await mkdtemp(join(tmpdir(), "market-bot-report-sweep-"));
  const sweep = await sweepReports(resolve(values["runs-dir"]!), root).finally(() =>
    rm(root, { recursive: true, force: true }),
  );
  const outDir = resolve(values["out-dir"]!);
  const stem = join(outDir, `report-${new Date().toISOString().replaceAll(":", "-")}`);
  const { ledger, ...json } = sweep;
  await mkdir(outDir, { recursive: true });
  await writeFile(`${stem}.json`, `${JSON.stringify(json, null, 2)}\n`, { flag: "wx" });
  await writeFile(`${stem}.ledger.jsonl`, serializeLedger(ledger), { flag: "wx" });
  process.stdout.write(
    [
      `Runs: ${sweep.runs}, replayed: ${sweep.replayed}, upstream-only: ${sweep.upstreamOnly.length} (with Metric Sections: ${sweep.withSections}), replay failed: ${sweep.failures.length}, no capture: ${sweep.noCapture.length}`,
      ...sweep.upstreamOnly.map(({ run, error }) => `  upstream-only ${run}: ${error}`),
      ...sweep.failures.map(({ run, error }) => `  failed ${run}: ${error}`),
      ...sweep.noCapture.map((run) => `  no capture ${run}`),
      `Violations: ${
        Object.entries(sweep.violationCounts)
          .map(([name, count]) => `${name} ${count}`)
          .join(", ") || "none"
      }`,
      `JSON: ${stem}.json`,
      `Ledger (${ledger.length} rows): ${stem}.ledger.jsonl`,
      `Wall time: ${((performance.now() - started) / 1000).toFixed(1)}s`,
      "",
    ].join("\n"),
  );
  if (baselineLedger !== undefined && baselineJson !== undefined) {
    process.stdout.write(formatCountDiff(baselineJson.violationCounts, sweep.violationCounts));
    process.stdout.write(formatLedgerDiff(diffLedgers(baselineLedger, ledger)));
  }
}
