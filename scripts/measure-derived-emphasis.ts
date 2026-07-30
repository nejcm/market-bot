import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isRecord, readNumber, readString } from "../src/guards";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const DATA_DIR = resolve(REPOSITORY_ROOT, "data");
const EVALUATIONS_DIR = resolve(DATA_DIR, "evaluations");
const EVALUATION_PREFIX = "deep-equity-";
const EVALUATION_FILE = "evaluation.json";
const REPORT_FILE = "report.md";
const VARIANTS = ["legacy", "simplified"] as const;

const DERIVED_MARKER_SOURCE = String.raw`\b(?:ttm|trailing[\s-]+(?:twelve|12)(?:[\s-]+months?)?|cagr|compound[\s-]+annual[\s-]+growth[\s-]+rate|peer[\s-]+median|peer[\s-]+implied(?:[\s-]+range)?|implied[\s-]+range|annuali[sz]ed)\b`;
const REPORTED_MARKER_SOURCE = String.raw`(?:\d{4}-\d{2}-\d{2}|\bperiod[\s-]+end(?:ed)?\b|\bq[1-4](?:[\s-]*(?:fy)?[\s']*\d{2,4})?\b|\bfy[\s-]*['’]?\d{2,4}\b|\bfiscal[\s-]+(?:year|q[1-4]|(?:first|second|third|fourth|1st|2nd|3rd|4th)[\s-]+quarter)(?:[\s,]+(?:fy)?[\s']*\d{2,4})?\b|\b(?:10[\s-]?[kq]|6[\s-]?k|20[\s-]?f)\b)`;

type VariantName = (typeof VARIANTS)[number];

export interface ParsedArguments {
  readonly root?: string;
  readonly json: boolean;
  readonly out?: string;
}

export interface ReportMeasurement {
  readonly wordCount: number;
  readonly derivedMarkerCount: number;
  readonly reportedMarkerCount: number;
  readonly derivedPerThousandWords: number;
  readonly reportedPerThousandWords: number;
  readonly derivedToReportedRatio: number | null;
  readonly firstDerivedFraction: number | null;
}

export interface VariantMeasurement {
  readonly status: "measured" | "variant-error" | "artifact-error";
  readonly runDir?: string;
  readonly error?: string;
  readonly measurement?: ReportMeasurement;
}

export interface PairMeasurement {
  readonly scenario: string;
  readonly repetition: number;
  readonly variants: Readonly<Record<VariantName, VariantMeasurement>>;
}

export interface MetricMedians {
  readonly derivedMarkerCount: number | null;
  readonly reportedMarkerCount: number | null;
  readonly derivedPerThousandWords: number | null;
  readonly reportedPerThousandWords: number | null;
  readonly derivedToReportedRatio: number | null;
  readonly firstDerivedFraction: number | null;
}

export interface VariantAggregate {
  readonly measuredReportCount: number;
  readonly errorCount: number;
  readonly medians: MetricMedians;
}

export interface ScenarioAggregate {
  readonly scenario: string;
  readonly variants: Readonly<Record<VariantName, VariantAggregate>>;
  readonly simplifiedMinusLegacy: MetricMedians;
}

export interface DerivedEmphasisArtifact {
  readonly version: 1;
  readonly evaluationRoot: string;
  readonly selectedAutomatically: boolean;
  readonly records: readonly PairMeasurement[];
  readonly scenarios: readonly ScenarioAggregate[];
}

function usage(): never {
  throw new Error(
    "Usage: bun run scripts/measure-derived-emphasis.ts [--root <path>] [--json] [--out <path>]",
  );
}

function requiredFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${flag} requires a value`);
  }
  return value;
}

export function parseArguments(args: readonly string[]): ParsedArguments {
  let root: string | undefined = undefined;
  let json = false;
  let out: string | undefined = undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--root") {
      if (root !== undefined) {
        usage();
      }
      root = requiredFlagValue(args, index, argument);
      index += 1;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--out") {
      if (out !== undefined) {
        usage();
      }
      out = requiredFlagValue(args, index, argument);
      index += 1;
    } else {
      usage();
    }
  }
  return {
    ...(root !== undefined ? { root } : {}),
    json,
    ...(out !== undefined ? { out } : {}),
  };
}

function markerMatches(text: string, source: string): readonly RegExpMatchArray[] {
  return [...text.matchAll(new RegExp(source, "giu"))];
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

export function measureReport(text: string): ReportMeasurement {
  const words = wordCount(text);
  const derivedMatches = markerMatches(text, DERIVED_MARKER_SOURCE);
  const reportedMatches = markerMatches(text, REPORTED_MARKER_SOURCE);
  const derivedMarkerCount = derivedMatches.length;
  const reportedMarkerCount = reportedMatches.length;
  const firstDerivedIndex = derivedMatches[0]?.index;
  return {
    wordCount: words,
    derivedMarkerCount,
    reportedMarkerCount,
    derivedPerThousandWords: words === 0 ? 0 : (derivedMarkerCount / words) * 1000,
    reportedPerThousandWords: words === 0 ? 0 : (reportedMarkerCount / words) * 1000,
    derivedToReportedRatio:
      reportedMarkerCount === 0 ? null : derivedMarkerCount / reportedMarkerCount,
    firstDerivedFraction:
      firstDerivedIndex === undefined || text.length === 0 ? null : firstDerivedIndex / text.length,
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function nullableValues(
  measurements: readonly ReportMeasurement[],
  select: (measurement: ReportMeasurement) => number | null,
): readonly number[] {
  return measurements.flatMap((measurement) => {
    const value = select(measurement);
    return value === null ? [] : [value];
  });
}

export function aggregateMeasurements(measurements: readonly ReportMeasurement[]): MetricMedians {
  return {
    derivedMarkerCount: median(measurements.map((value) => value.derivedMarkerCount)),
    reportedMarkerCount: median(measurements.map((value) => value.reportedMarkerCount)),
    derivedPerThousandWords: median(measurements.map((value) => value.derivedPerThousandWords)),
    reportedPerThousandWords: median(measurements.map((value) => value.reportedPerThousandWords)),
    derivedToReportedRatio: median(
      nullableValues(measurements, (value) => value.derivedToReportedRatio),
    ),
    firstDerivedFraction: median(
      nullableValues(measurements, (value) => value.firstDerivedFraction),
    ),
  };
}

function delta(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right;
}

function aggregateVariant(
  records: readonly PairMeasurement[],
  variant: VariantName,
): VariantAggregate {
  const results = records.map((record) => record.variants[variant]);
  const measurements = results.flatMap((result) =>
    result.status === "measured" && result.measurement !== undefined ? [result.measurement] : [],
  );
  return {
    measuredReportCount: measurements.length,
    errorCount: results.length - measurements.length,
    medians: aggregateMeasurements(measurements),
  };
}

export function aggregateRecords(
  records: readonly PairMeasurement[],
): readonly ScenarioAggregate[] {
  return [...new Set(records.map((record) => record.scenario))].toSorted().map((scenario) => {
    const scenarioRecords = records.filter((record) => record.scenario === scenario);
    const legacy = aggregateVariant(scenarioRecords, "legacy");
    const simplified = aggregateVariant(scenarioRecords, "simplified");
    return {
      scenario,
      variants: { legacy, simplified },
      simplifiedMinusLegacy: {
        derivedMarkerCount: delta(
          simplified.medians.derivedMarkerCount,
          legacy.medians.derivedMarkerCount,
        ),
        reportedMarkerCount: delta(
          simplified.medians.reportedMarkerCount,
          legacy.medians.reportedMarkerCount,
        ),
        derivedPerThousandWords: delta(
          simplified.medians.derivedPerThousandWords,
          legacy.medians.derivedPerThousandWords,
        ),
        reportedPerThousandWords: delta(
          simplified.medians.reportedPerThousandWords,
          legacy.medians.reportedPerThousandWords,
        ),
        derivedToReportedRatio: delta(
          simplified.medians.derivedToReportedRatio,
          legacy.medians.derivedToReportedRatio,
        ),
        firstDerivedFraction: delta(
          simplified.medians.firstDerivedFraction,
          legacy.medians.firstDerivedFraction,
        ),
      },
    };
  });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function mostRecentEvaluationRoot(): Promise<string> {
  const entries = await readdir(EVALUATIONS_DIR, { withFileTypes: true }).catch((error) => {
    throw new Error(`Cannot read evaluation directory ${EVALUATIONS_DIR}`, { cause: error });
  });
  const latest = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(EVALUATION_PREFIX))
    .map((entry) => entry.name)
    .toSorted()
    .at(-1);
  if (latest === undefined) {
    throw new Error(`No ${EVALUATION_PREFIX}* directories found under ${EVALUATIONS_DIR}`);
  }
  return resolve(EVALUATIONS_DIR, latest);
}

function evaluationRecords(value: unknown): readonly Record<string, unknown>[] {
  if (!isRecord(value) || !Array.isArray(value.records)) {
    throw new Error("evaluation.json does not contain a records array");
  }
  return value.records.filter(isRecord);
}

function emptyVariant(
  status: "variant-error" | "artifact-error",
  error: string,
  runDir?: string,
): VariantMeasurement {
  return {
    status,
    ...(runDir !== undefined ? { runDir } : {}),
    error,
  };
}

function resolvedRunDir(runDir: string): string {
  return isAbsolute(runDir) ? runDir : resolve(REPOSITORY_ROOT, runDir);
}

async function measureVariant(value: unknown): Promise<VariantMeasurement> {
  if (!isRecord(value)) {
    return emptyVariant("variant-error", "missing variant record");
  }
  const status = readString(value, "status");
  const storedRunDir = readString(value, "runDir");
  if (status !== "success") {
    return emptyVariant(
      "variant-error",
      readString(value, "error") ?? `variant status is ${status ?? "missing"}`,
      storedRunDir,
    );
  }
  if (storedRunDir === undefined) {
    return emptyVariant("artifact-error", "successful variant has no runDir");
  }
  const reportPath = resolve(resolvedRunDir(storedRunDir), REPORT_FILE);
  try {
    return {
      status: "measured",
      runDir: storedRunDir,
      measurement: measureReport(await readFile(reportPath, "utf8")),
    };
  } catch (error) {
    return emptyVariant(
      "artifact-error",
      error instanceof Error ? error.message : String(error),
      storedRunDir,
    );
  }
}

async function measurePair(record: Record<string, unknown>): Promise<PairMeasurement> {
  const variants = isRecord(record.variants) ? record.variants : {};
  const [legacy, simplified] = await Promise.all([
    measureVariant(variants.legacy),
    measureVariant(variants.simplified),
  ]);
  return {
    scenario: readString(record, "scenario") ?? "(missing scenario)",
    repetition: readNumber(record, "repetition") ?? 0,
    variants: { legacy, simplified },
  };
}

export async function measureEvaluationRoot(
  root: string,
  selectedAutomatically = false,
): Promise<DerivedEmphasisArtifact> {
  const evaluationRoot = resolve(root);
  const evaluationPath = resolve(evaluationRoot, EVALUATION_FILE);
  let evaluation: unknown = undefined;
  try {
    evaluation = await readJson(evaluationPath);
  } catch (error) {
    throw new Error(
      `Cannot read ${evaluationPath}: ${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  }
  const records = await Promise.all(
    evaluationRecords(evaluation).map((record) => measurePair(record)),
  );
  return {
    version: 1,
    evaluationRoot,
    selectedAutomatically,
    records,
    scenarios: aggregateRecords(records),
  };
}

function fixed(value: number | null, digits = 2): string {
  return value === null ? "n/a" : value.toFixed(digits);
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width);
}

export function renderHuman(artifact: DerivedEmphasisArtifact): string {
  const lines = [
    `Evaluation root: ${artifact.evaluationRoot}`,
    "",
    [
      pad("scenario", 38),
      pad("rep", 4),
      pad("variant", 11),
      pad("derived", 7),
      pad("reported", 8),
      pad("derived/1kw", 12),
      pad("reported/1kw", 13),
      pad("ratio", 7),
      pad("first-derived", 13),
      "words",
    ].join("  "),
  ];
  for (const record of artifact.records) {
    for (const variant of VARIANTS) {
      const result = record.variants[variant];
      if (result.status !== "measured" || result.measurement === undefined) {
        lines.push(
          [
            pad(record.scenario, 38),
            pad(String(record.repetition), 4),
            pad(variant, 11),
            `${result.status}: ${result.error ?? "unknown error"}`,
          ].join("  "),
        );
        continue;
      }
      const { measurement } = result;
      lines.push(
        [
          pad(record.scenario, 38),
          pad(String(record.repetition), 4),
          pad(variant, 11),
          pad(String(measurement.derivedMarkerCount), 7),
          pad(String(measurement.reportedMarkerCount), 8),
          pad(fixed(measurement.derivedPerThousandWords), 12),
          pad(fixed(measurement.reportedPerThousandWords), 13),
          pad(fixed(measurement.derivedToReportedRatio), 7),
          pad(percent(measurement.firstDerivedFraction), 13),
          String(measurement.wordCount),
        ].join("  "),
      );
    }
  }
  lines.push("", "Scenario medians (simplified delta is simplified minus legacy):");
  for (const scenario of artifact.scenarios) {
    lines.push(`  ${scenario.scenario}`);
    for (const variant of VARIANTS) {
      const aggregate = scenario.variants[variant];
      lines.push(
        `    ${variant}: n=${String(aggregate.measuredReportCount)}, errors=${String(aggregate.errorCount)}, derived=${fixed(aggregate.medians.derivedMarkerCount)}, reported=${fixed(aggregate.medians.reportedMarkerCount)}, derived/1kw=${fixed(aggregate.medians.derivedPerThousandWords)}, reported/1kw=${fixed(aggregate.medians.reportedPerThousandWords)}, ratio=${fixed(aggregate.medians.derivedToReportedRatio)}, first-derived=${percent(aggregate.medians.firstDerivedFraction)}`,
      );
    }
    const change = scenario.simplifiedMinusLegacy;
    lines.push(
      `    delta: derived=${fixed(change.derivedMarkerCount)}, reported=${fixed(change.reportedMarkerCount)}, derived/1kw=${fixed(change.derivedPerThousandWords)}, reported/1kw=${fixed(change.reportedPerThousandWords)}, ratio=${fixed(change.derivedToReportedRatio)}, first-derived=${percent(change.firstDerivedFraction)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function assertOutputOutsideData(out: string): string {
  const outputPath = resolve(REPOSITORY_ROOT, out);
  const relativeToData = relative(DATA_DIR, outputPath);
  if (relativeToData === "" || (!relativeToData.startsWith("..") && !isAbsolute(relativeToData))) {
    throw new Error("--out must not write under data/");
  }
  return outputPath;
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  const selectedAutomatically = parsed.root === undefined;
  const root = parsed.root === undefined ? await mostRecentEvaluationRoot() : parsed.root;
  if (selectedAutomatically) {
    process.stderr.write(`Selected evaluation root: ${root}\n`);
  }
  const artifact = await measureEvaluationRoot(root, selectedAutomatically);
  const json = `${JSON.stringify(artifact, null, 2)}\n`;
  if (parsed.out !== undefined) {
    const outputPath = assertOutputOutsideData(parsed.out);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json, "utf8");
    process.stderr.write(`Wrote ${outputPath}\n`);
  }
  process.stdout.write(parsed.json ? json : renderHuman(artifact));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `Derived emphasis measurement failed: ${error instanceof Error ? error.message : error}\n`,
    );
    process.exitCode = 1;
  }
}
