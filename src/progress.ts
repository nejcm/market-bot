// Run progress goes to stderr so stdout stays reserved for the run-dir path.
// Default: on when stderr is a terminal. MARKET_BOT_PROGRESS=off|on|verbose overrides;
// "verbose" adds one line per source HTTP request.
const PROGRESS_LEVELS = ["off", "on", "verbose"] as const;
type ProgressLevel = (typeof PROGRESS_LEVELS)[number];

function resolveLevel(env: string | undefined, isTty: boolean): ProgressLevel {
  const requested = env?.trim().toLowerCase();
  if (requested !== undefined && (PROGRESS_LEVELS as readonly string[]).includes(requested)) {
    return requested as ProgressLevel;
  }
  return isTty ? "on" : "off";
}

let level = resolveLevel(process.env.MARKET_BOT_PROGRESS, process.stderr.isTTY === true);
let startedAtMs = Date.now();

// Test seam: re-resolve the level and reset the elapsed clock.
export function configureProgress(options: {
  readonly env?: string | undefined;
  readonly isTty?: boolean;
  readonly nowMs?: number;
}): void {
  level = resolveLevel(options.env, options.isTty ?? false);
  startedAtMs = options.nowMs ?? Date.now();
}

export function progressEnabled(): boolean {
  return level !== "off";
}

export function progressVerbose(): boolean {
  return level === "verbose";
}

export function formatProgressLine(message: string, elapsedMs: number): string {
  return `[${(elapsedMs / 1000).toFixed(1).padStart(7)}s] ${message}`;
}

export function progress(message: string): void {
  if (level === "off") {
    return;
  }
  process.stderr.write(`${formatProgressLine(message, Date.now() - startedAtMs)}\n`);
}

export function progressDetail(message: string): void {
  if (level !== "verbose") {
    return;
  }
  progress(message);
}
