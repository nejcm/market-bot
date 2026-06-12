import { commandLabel, parseArgs } from "../src/cli/args";
import { jobRequestArgv } from "../src/cli/job-registry";
import type { ConsoleJob } from "./types";

export { jobRequestArgv } from "../src/cli/job-registry";

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
  // Anchor the spawned CLI at the project root so Bun auto-loads the root `.env`
  // (and resolves `src/cli.ts`) regardless of the cwd the console was launched from.
  const projectRoot = join(import.meta.dir, "..");
  const process = Bun.spawn(["bun", "run", join(projectRoot, "src/cli.ts"), ...argv], {
    cwd: projectRoot,
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
