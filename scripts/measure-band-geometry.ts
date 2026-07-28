import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isRecord, readNumber, readString } from "../src/guards";
import { parseObservableExpression } from "../src/forecast/observable";

const REPOSITORY_ROOT = resolve(import.meta.dir, "..");
const DATA_DIR = resolve(REPOSITORY_ROOT, "data");
const EVALUATIONS_DIR = resolve(DATA_DIR, "evaluations");
const EVALUATION_PREFIX = "deep-equity-";
const EVALUATION_FILE = "evaluation.json";
const REPORT_FILE = "report.json";
const EVIDENCE_BUNDLE_FILE = "normalized/evidence-bundle.json";
const COPY_EPSILON = 0.05;

type VariantName = "legacy" | "simplified";
type UnmeasurableReason =
  | "missing-measurable-as"
  | "unparseable-range-bounds"
  | "zero-midpoint"
  | "missing-price-reference";

interface ParsedArguments {
  readonly root?: string;
  readonly json: boolean;
  readonly out?: string;
}

interface PriceReference {
  readonly kind: "current-price-reference" | "verified-snapshot-latest-close";
  readonly price: number;
  readonly asOf: string;
  readonly sourceId: string;
}

interface MetricResult {
  readonly status: "measured" | "unmeasurable";
  readonly valuePercent?: number;
  readonly reason?: UnmeasurableReason;
}

interface CopyDetection {
  readonly status: "checked" | "unavailable";
  readonly matches?: boolean;
  readonly reason?: "missing-implied-price-range";
}

export interface BandGeometryMeasurement {
  readonly predictionId: string;
  readonly subject: string;
  readonly measurableAs?: string;
  readonly bounds?: { readonly low: number; readonly high: number };
  readonly midpoint?: number;
  readonly relativeBandHalfWidth: MetricResult;
  readonly bandCentring: MetricResult & { readonly reference?: PriceReference };
  readonly impliedPriceRangeCopy: CopyDetection;
  readonly unmeasurableReasons: readonly UnmeasurableReason[];
}

interface VariantMeasurement {
  readonly status: "measured" | "variant-error" | "artifact-error";
  readonly runDir?: string;
  readonly error?: string;
  readonly rangePredictionCount: number;
  readonly measurablePredictionCount: number;
  readonly unmeasurablePredictionCount: number;
  readonly unmeasurableReasonCounts: Readonly<Record<string, number>>;
  readonly measurements: readonly BandGeometryMeasurement[];
}

interface PairMeasurement {
  readonly scenario: string;
  readonly repetition: number;
  readonly variants: Readonly<Record<VariantName, VariantMeasurement>>;
}

interface VariantTotals {
  readonly rangePredictionCount: number;
  readonly measurablePredictionCount: number;
  readonly unmeasurablePredictionCount: number;
  readonly impliedPriceRangeCopyCount: number;
  readonly copyCheckUnavailableCount: number;
  readonly variantErrorCount: number;
  readonly artifactErrorCount: number;
  readonly unmeasurableReasonCounts: Readonly<Record<string, number>>;
}

export interface BandGeometryArtifact {
  readonly version: 1;
  readonly evaluationRoot: string;
  readonly selectedAutomatically: boolean;
  readonly records: readonly PairMeasurement[];
  readonly totals: Readonly<Record<VariantName, VariantTotals>>;
}

interface RunEvidence {
  readonly marketSnapshots: readonly unknown[];
  readonly verifiedMarketSnapshot?: Readonly<Record<string, unknown>>;
  readonly impliedPriceRange?: { readonly low: number; readonly high: number };
}

function usage(): never {
  throw new Error(
    "Usage: bun run scripts/measure-band-geometry.ts [evaluation-root] [--json] [--out <path>]",
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
    if (argument === "--json") {
      json = true;
    } else if (argument === "--out") {
      out = requiredFlagValue(args, index, argument);
      index += 1;
    } else if (
      argument?.startsWith("--") === true ||
      argument === undefined ||
      root !== undefined
    ) {
      usage();
    } else {
      root = argument;
    }
  }
  return {
    ...(root !== undefined ? { root } : {}),
    json,
    ...(out !== undefined ? { out } : {}),
  };
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

function impliedPriceRange(
  value: unknown,
): { readonly low: number; readonly high: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const low = readNumber(value, "low");
  const high = readNumber(value, "high");
  return low !== undefined && high !== undefined && low < high ? { low, high } : undefined;
}

function runEvidence(bundle: unknown): RunEvidence {
  if (!isRecord(bundle)) {
    return { marketSnapshots: [] };
  }
  const evidence = isRecord(bundle.evidence) ? bundle.evidence : undefined;
  const derived = isRecord(bundle.derived) ? bundle.derived : undefined;
  const valuationComps =
    derived !== undefined && isRecord(derived.valuationComps) ? derived.valuationComps : undefined;
  const range =
    valuationComps === undefined ? undefined : impliedPriceRange(valuationComps.impliedPriceRange);
  return {
    marketSnapshots:
      evidence !== undefined && Array.isArray(evidence.marketSnapshots)
        ? evidence.marketSnapshots
        : [],
    ...(evidence !== undefined && isRecord(evidence.verifiedMarketSnapshot)
      ? { verifiedMarketSnapshot: evidence.verifiedMarketSnapshot }
      : {}),
    ...(range !== undefined ? { impliedPriceRange: range } : {}),
  };
}

function positiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function priceReference(evidence: RunEvidence, subject: string): PriceReference | undefined {
  const normalizedSubject = subject.toUpperCase();
  const quote = evidence.marketSnapshots.find(
    (candidate) =>
      isRecord(candidate) &&
      readString(candidate, "symbol")?.toUpperCase() === normalizedSubject &&
      positiveNumber(candidate.price) &&
      readString(candidate, "observedAt") !== undefined &&
      readString(candidate, "sourceId") !== undefined,
  );
  const snapshot = evidence.verifiedMarketSnapshot;
  const snapshotMatches =
    snapshot !== undefined &&
    readString(snapshot, "symbol")?.toUpperCase() === normalizedSubject &&
    isRecord(snapshot.ohlcv) &&
    positiveNumber(snapshot.ohlcv.close) &&
    readString(snapshot, "latestSessionDate") !== undefined;
  const latestSessionDate = snapshotMatches ? readString(snapshot, "latestSessionDate") : undefined;
  if (isRecord(quote)) {
    const observedAt = readString(quote, "observedAt")!;
    if (latestSessionDate === undefined || observedAt.slice(0, 10) >= latestSessionDate) {
      return {
        kind: "current-price-reference",
        price: readNumber(quote, "price")!,
        asOf: observedAt,
        sourceId: readString(quote, "sourceId")!,
      };
    }
  }
  if (snapshotMatches) {
    return {
      kind: "verified-snapshot-latest-close",
      price: readNumber(snapshot.ohlcv as Record<string, unknown>, "close")!,
      asOf: latestSessionDate!,
      sourceId: `verified-snapshot-${normalizedSubject}`,
    };
  }
  return undefined;
}

function rangeBounds(
  measurableAs: string | undefined,
): { readonly low: number; readonly high: number } | UnmeasurableReason {
  if (measurableAs === undefined) {
    return "missing-measurable-as";
  }
  try {
    const expression = parseObservableExpression(measurableAs);
    return expression.kind === "range"
      ? { low: expression.lo, high: expression.hi }
      : "unparseable-range-bounds";
  } catch {
    return "unparseable-range-bounds";
  }
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= COPY_EPSILON;
}

export function measureRangePrediction(
  prediction: Readonly<Record<string, unknown>>,
  evidence: RunEvidence,
): BandGeometryMeasurement {
  const predictionId = readString(prediction, "id") ?? "(missing id)";
  const subject = readString(prediction, "subject") ?? "(missing subject)";
  const measurableAs = readString(prediction, "measurableAs");
  const bounds = rangeBounds(measurableAs);
  if (typeof bounds === "string") {
    return {
      predictionId,
      subject,
      ...(measurableAs !== undefined ? { measurableAs } : {}),
      relativeBandHalfWidth: { status: "unmeasurable", reason: bounds },
      bandCentring: { status: "unmeasurable", reason: bounds },
      impliedPriceRangeCopy:
        evidence.impliedPriceRange === undefined
          ? { status: "unavailable", reason: "missing-implied-price-range" }
          : { status: "checked", matches: false },
      unmeasurableReasons: [bounds],
    };
  }
  const midpoint = (bounds.low + bounds.high) / 2;
  const reference = priceReference(evidence, subject);
  const width =
    midpoint === 0
      ? ({ status: "unmeasurable", reason: "zero-midpoint" } as const)
      : ({
          status: "measured",
          valuePercent: ((bounds.high - bounds.low) / 2 / midpoint) * 100,
        } as const);
  const centring =
    reference === undefined
      ? ({ status: "unmeasurable", reason: "missing-price-reference" } as const)
      : ({
          status: "measured",
          valuePercent: ((midpoint - reference.price) / reference.price) * 100,
          reference,
        } as const);
  const reasons: UnmeasurableReason[] = [];
  if (width.reason !== undefined) {
    reasons.push(width.reason);
  }
  if (centring.reason !== undefined) {
    reasons.push(centring.reason);
  }
  return {
    predictionId,
    subject,
    ...(measurableAs !== undefined ? { measurableAs } : {}),
    bounds,
    midpoint,
    relativeBandHalfWidth: width,
    bandCentring: centring,
    impliedPriceRangeCopy:
      evidence.impliedPriceRange === undefined
        ? { status: "unavailable", reason: "missing-implied-price-range" }
        : {
            status: "checked",
            matches:
              approximatelyEqual(bounds.low, evidence.impliedPriceRange.low) &&
              approximatelyEqual(bounds.high, evidence.impliedPriceRange.high),
          },
    unmeasurableReasons: reasons,
  };
}

function reasonCounts(
  measurements: readonly BandGeometryMeasurement[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const measurement of measurements) {
    for (const reason of measurement.unmeasurableReasons) {
      counts[reason] = (counts[reason] ?? 0) + 1;
    }
  }
  return counts;
}

function measuredVariant(
  runDir: string,
  report: unknown,
  evidence: RunEvidence,
): VariantMeasurement {
  const predictions =
    isRecord(report) && Array.isArray(report.predictions)
      ? report.predictions.filter(
          (prediction) => isRecord(prediction) && readString(prediction, "kind") === "range",
        )
      : [];
  const measurements = predictions.map((prediction) =>
    measureRangePrediction(prediction, evidence),
  );
  const unmeasurablePredictionCount = measurements.filter(
    (measurement) => measurement.unmeasurableReasons.length > 0,
  ).length;
  return {
    status: "measured",
    runDir,
    rangePredictionCount: measurements.length,
    measurablePredictionCount: measurements.length - unmeasurablePredictionCount,
    unmeasurablePredictionCount,
    unmeasurableReasonCounts: reasonCounts(measurements),
    measurements,
  };
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
    rangePredictionCount: 0,
    measurablePredictionCount: 0,
    unmeasurablePredictionCount: 0,
    unmeasurableReasonCounts: {},
    measurements: [],
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
  const runDir = resolvedRunDir(storedRunDir);
  try {
    const [report, bundle] = await Promise.all([
      readJson(resolve(runDir, REPORT_FILE)),
      readJson(resolve(runDir, EVIDENCE_BUNDLE_FILE)),
    ]);
    return measuredVariant(storedRunDir, report, runEvidence(bundle));
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

export function totalFor(records: readonly PairMeasurement[], variant: VariantName): VariantTotals {
  const variants = records.map((record) => record.variants[variant]);
  const measurements = variants.flatMap((result) => result.measurements);
  return {
    rangePredictionCount: measurements.length,
    measurablePredictionCount: measurements.filter(
      (measurement) => measurement.unmeasurableReasons.length === 0,
    ).length,
    unmeasurablePredictionCount: measurements.filter(
      (measurement) => measurement.unmeasurableReasons.length > 0,
    ).length,
    impliedPriceRangeCopyCount: measurements.filter(
      (measurement) => measurement.impliedPriceRangeCopy.matches === true,
    ).length,
    copyCheckUnavailableCount: measurements.filter(
      (measurement) => measurement.impliedPriceRangeCopy.status === "unavailable",
    ).length,
    variantErrorCount: variants.filter((result) => result.status === "variant-error").length,
    artifactErrorCount: variants.filter((result) => result.status === "artifact-error").length,
    unmeasurableReasonCounts: reasonCounts(measurements),
  };
}

export async function measureEvaluationRoot(
  root: string,
  selectedAutomatically = false,
): Promise<BandGeometryArtifact> {
  const evaluationRoot = resolve(root);
  const evaluationPath = resolve(evaluationRoot, EVALUATION_FILE);
  let evaluation: unknown = undefined;
  try {
    evaluation = await readJson(evaluationPath);
  } catch (error) {
    throw new Error(
      `Cannot read ${evaluationPath}: ${error instanceof Error ? error.message : error}`,
      {
        cause: error,
      },
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
    totals: {
      legacy: totalFor(records, "legacy"),
      simplified: totalFor(records, "simplified"),
    },
  };
}

function percent(metric: MetricResult): string {
  return metric.status === "measured" ? `${metric.valuePercent!.toFixed(2)}%` : `n/a`;
}

function formatBounds(measurement: BandGeometryMeasurement): string {
  return measurement.bounds === undefined
    ? "n/a"
    : `[${String(measurement.bounds.low)}, ${String(measurement.bounds.high)}]`;
}

function copyLabel(copy: CopyDetection): string {
  if (copy.status === "unavailable") {
    return "n/a";
  }
  return copy.matches === true ? "YES" : "no";
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value.padEnd(width);
}

export function renderHuman(artifact: BandGeometryArtifact): string {
  const lines = [
    `Evaluation root: ${artifact.evaluationRoot}`,
    "",
    [
      pad("scenario", 38),
      pad("rep", 4),
      pad("variant", 11),
      pad("prediction", 14),
      pad("bounds", 24),
      pad("half-width", 12),
      pad("centring", 11),
      pad("reference", 38),
      "implied copy",
    ].join("  "),
  ];
  for (const record of artifact.records) {
    for (const variant of ["legacy", "simplified"] as const) {
      const result = record.variants[variant];
      if (result.status !== "measured") {
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
      const { measurements } = result;
      if (measurements.length === 0) {
        lines.push(
          [
            pad(record.scenario, 38),
            pad(String(record.repetition), 4),
            pad(variant, 11),
            "(no range predictions)",
          ].join("  "),
        );
        continue;
      }
      for (const measurement of measurements) {
        const {
          bandCentring: { reference },
        } = measurement;
        const referenceLabel =
          reference === undefined
            ? "n/a"
            : `${reference.kind} ${String(reference.price)} @ ${reference.asOf}`;
        const suffix =
          measurement.unmeasurableReasons.length === 0
            ? ""
            : `  reasons=${measurement.unmeasurableReasons.join(",")}`;
        lines.push(
          [
            pad(record.scenario, 38),
            pad(String(record.repetition), 4),
            pad(variant, 11),
            pad(measurement.predictionId, 14),
            pad(formatBounds(measurement), 24),
            pad(percent(measurement.relativeBandHalfWidth), 12),
            pad(percent(measurement.bandCentring), 11),
            pad(referenceLabel, 38),
            `${copyLabel(measurement.impliedPriceRangeCopy)}${suffix}`,
          ].join("  "),
        );
      }
    }
  }
  lines.push("", "Totals:");
  for (const variant of ["legacy", "simplified"] as const) {
    const total = artifact.totals[variant];
    lines.push(
      `  ${variant}: range=${String(total.rangePredictionCount)}, measurable=${String(total.measurablePredictionCount)}, unmeasurable=${String(total.unmeasurablePredictionCount)}, implied-copies=${String(total.impliedPriceRangeCopyCount)}, copy-check-unavailable=${String(total.copyCheckUnavailableCount)}, variant-errors=${String(total.variantErrorCount)}, artifact-errors=${String(total.artifactErrorCount)}, reasons=${JSON.stringify(total.unmeasurableReasonCounts)}`,
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
      `Band geometry measurement failed: ${error instanceof Error ? error.message : error}\n`,
    );
    process.exitCode = 1;
  }
}
