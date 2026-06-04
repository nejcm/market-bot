import { commandLabel, parseArgs } from "../src/cli/args";
import type { AssetClass, Depth } from "../src/domain/types";
import type { ConsoleJob } from "./types";

export interface JobRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type JobRunner = (argv: readonly string[]) => Promise<JobRunResult>;

type MutableConsoleJob = {
  -readonly [Key in keyof ConsoleJob]: ConsoleJob[Key];
};

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
  readonly #runner: JobRunner;
  #draining = false;

  constructor(runner: JobRunner = runCliJob) {
    this.#runner = runner;
  }

  enqueue(request: unknown): ConsoleJob {
    const argv = jobRequestArgv(request);
    const command = parseArgs(argv);
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
      job.stdout = result.stdout;
      job.stderr = result.stderr;
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

export function createJobQueue(runner?: JobRunner): ResearchConsoleJobQueue {
  return new ResearchConsoleJobQueue(runner);
}
