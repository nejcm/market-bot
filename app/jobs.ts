import { commandLabel, parseArgs } from "../src/cli/args";
import type { AssetClass, Depth } from "../src/domain/types";
import type { ConsoleJob } from "./types";

export interface JobRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type JobRunner = (argv: readonly string[]) => Promise<JobRunResult>;

export interface ResearchConsoleJobQueueOptions {
  readonly maxRetainedJobs?: number;
  readonly maxOutputChars?: number;
}

type MutableConsoleJob = {
  -readonly [Key in keyof ConsoleJob]: ConsoleJob[Key];
};

const DEFAULT_MAX_RETAINED_JOBS = 50;
const DEFAULT_MAX_JOB_OUTPUT_CHARS = 20_000;
const TRUNCATION_NOTICE = "\n[truncated]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readAssetClass(value: string | undefined): AssetClass {
  if (value === "equity" || value === "crypto") {
    return value;
  }

  throw new Error("Expected assetClass equity|crypto");
}

function readDepth(value: string | undefined): Depth {
  if (value === undefined || value === "brief") {
    return "brief";
  }

  if (value === "deep") {
    return "deep";
  }

  throw new Error("Expected depth brief|deep");
}

function depthArg(depth: Depth): readonly string[] {
  return depth === "deep" ? ["--deep"] : [];
}

export function jobRequestArgv(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    throw new Error("Job request must be an object");
  }

  const jobType = readString(value, "jobType");
  if (jobType === "daily" || jobType === "weekly") {
    const assetClass = readAssetClass(readString(value, "assetClass"));
    return [jobType, "--asset", assetClass, ...depthArg(readDepth(readString(value, "depth")))];
  }

  if (jobType === "ticker") {
    const symbol = readString(value, "symbol");
    if (symbol === undefined || symbol.trim() === "") {
      throw new Error("Expected ticker symbol");
    }

    const assetClass = readAssetClass(readString(value, "assetClass"));
    return [
      "ticker",
      symbol,
      "--asset",
      assetClass,
      ...depthArg(readDepth(readString(value, "depth"))),
    ];
  }

  if (jobType === "alpha-search") {
    return [
      "alpha-search",
      "--asset",
      "equity",
      ...depthArg(readDepth(readString(value, "depth"))),
    ];
  }

  if (jobType === "score" || jobType === "calibration" || jobType === "provider-health") {
    return [jobType];
  }

  if (jobType === "cache-prune") {
    return ["cache", "prune"];
  }

  throw new Error("Unsupported job type");
}

function nowIso(): string {
  return new Date().toISOString();
}

function snapshot(job: MutableConsoleJob): ConsoleJob {
  return { ...job };
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function outputRunPath(stdout: string): string | undefined {
  const lastLine = stdout
    .split(/\r?\n/u)
    .findLast((line) => line.trim() !== "")
    ?.trim();

  if (lastLine === undefined) {
    return undefined;
  }

  return /(^[A-Za-z]:[\\/]|^data[\\/]|[\\/]data[\\/]runs[\\/])/u.test(lastLine)
    ? lastLine
    : undefined;
}

export class ResearchConsoleJobQueue {
  readonly #jobs: MutableConsoleJob[] = [];
  readonly #maxOutputChars: number;
  readonly #maxRetainedJobs: number;
  readonly #runner: JobRunner;
  #draining = false;

  constructor(runner: JobRunner = runCliJob, options: ResearchConsoleJobQueueOptions = {}) {
    this.#runner = runner;
    this.#maxRetainedJobs = positiveLimit(
      options.maxRetainedJobs,
      DEFAULT_MAX_RETAINED_JOBS,
      "maxRetainedJobs",
    );
    this.#maxOutputChars = positiveLimit(
      options.maxOutputChars,
      DEFAULT_MAX_JOB_OUTPUT_CHARS,
      "maxOutputChars",
    );
  }

  enqueue(request: unknown): ConsoleJob {
    const argv = jobRequestArgv(request);
    const command = parseArgs(argv);
    this.#trimRetainedJobs(this.#maxRetainedJobs - 1);
    if (this.#jobs.length >= this.#maxRetainedJobs) {
      throw new Error("Job queue limit reached");
    }

    const job: MutableConsoleJob = {
      id: crypto.randomUUID(),
      status: "queued",
      argv,
      label: commandLabel(command),
      createdAt: nowIso(),
      stdout: "",
      stderr: "",
    };

    this.#jobs.push(job);
    void this.#drain();
    return snapshot(job);
  }

  list(): readonly ConsoleJob[] {
    return this.#jobs.toReversed().map((job) => snapshot(job));
  }

  get(id: string): ConsoleJob | undefined {
    const job = this.#jobs.find((candidate) => candidate.id === id);
    return job === undefined ? undefined : snapshot(job);
  }

  #trimOutput(value: string): string {
    return value.length <= this.#maxOutputChars
      ? value
      : `${value.slice(0, this.#maxOutputChars)}${TRUNCATION_NOTICE}`;
  }

  #trimRetainedJobs(maxJobs = this.#maxRetainedJobs): void {
    while (this.#jobs.length > maxJobs) {
      const completedIndex = this.#jobs.findIndex(
        (job) => job.status === "succeeded" || job.status === "failed",
      );
      if (completedIndex === -1) {
        return;
      }

      this.#jobs.splice(completedIndex, 1);
    }
  }

  async #drain(): Promise<void> {
    if (this.#draining) {
      return;
    }

    this.#draining = true;
    try {
      await this.#runNext();
    } finally {
      this.#draining = false;
    }
  }

  async #runNext(): Promise<void> {
    const job = this.#jobs.find((candidate) => candidate.status === "queued");
    if (job === undefined) {
      return;
    }

    await this.#run(job);
    await this.#runNext();
  }

  async #run(job: MutableConsoleJob): Promise<void> {
    job.status = "running";
    job.startedAt = nowIso();

    try {
      const result = await this.#runner(job.argv);
      job.stdout = this.#trimOutput(result.stdout);
      job.stderr = this.#trimOutput(result.stderr);
      job.exitCode = result.exitCode;
      const path = outputRunPath(result.stdout);
      if (path !== undefined) {
        job.outputRunPath = path;
      }
      job.status = result.exitCode === 0 ? "succeeded" : "failed";
    } catch (error: unknown) {
      job.status = "failed";
      job.stderr = error instanceof Error ? error.message : String(error);
    } finally {
      job.completedAt = nowIso();
      this.#trimRetainedJobs();
    }
  }
}

async function streamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  return stream === null ? "" : await new Response(stream).text();
}

export async function runCliJob(argv: readonly string[]): Promise<JobRunResult> {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", ...argv], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    streamText(process.stdout),
    streamText(process.stderr),
    process.exited,
  ]);

  return { stdout, stderr, exitCode };
}

export function createJobQueue(
  runner?: JobRunner,
  options?: ResearchConsoleJobQueueOptions,
): ResearchConsoleJobQueue {
  return new ResearchConsoleJobQueue(runner, options);
}
