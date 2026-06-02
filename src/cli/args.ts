import type { AssetClass, Depth } from "../domain/types";
import { createInstrument } from "../domain/instrument";

export interface DailyCommand {
  readonly jobType: "daily";
  readonly assetClass: AssetClass;
  readonly depth: Depth;
}

export interface WeeklyCommand {
  readonly jobType: "weekly";
  readonly assetClass: AssetClass;
  readonly depth: Depth;
}

export interface TickerCommand {
  readonly jobType: "ticker";
  readonly assetClass: AssetClass;
  readonly symbol: string;
  readonly depth: Depth;
}

export interface AlphaSearchCommand {
  readonly jobType: "alpha-search";
  readonly assetClass: "equity";
  readonly depth: Depth;
}

export interface ScoreCommand {
  readonly jobType: "score";
}

export interface CalibrationCommand {
  readonly jobType: "calibration";
}

export interface CachePruneCommand {
  readonly jobType: "cache-prune";
}

export interface ProviderHealthCommand {
  readonly jobType: "provider-health";
}

export type ResearchCommand = DailyCommand | WeeklyCommand | TickerCommand;
export type CliCommand =
  | ResearchCommand
  | AlphaSearchCommand
  | ScoreCommand
  | CalibrationCommand
  | CachePruneCommand
  | ProviderHealthCommand;

function parseAsset(value: string | undefined): AssetClass {
  if (value === "equity" || value === "crypto") {
    return value;
  }

  throw new Error("Expected --asset equity|crypto");
}

function readFlagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Expected value after ${flag}`);
  }

  return value;
}

function readDepth(args: readonly string[]): Depth {
  return args.includes("--deep") ? "deep" : "brief";
}

function rejectUnknownArgs(args: readonly string[], allowedPositionals: number): void {
  const allowedFlags = new Set(["--asset", "--deep"]);

  for (let index = allowedPositionals; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === undefined) {
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    if (!allowedFlags.has(arg)) {
      throw new Error(`Unknown flag: ${arg}`);
    }

    if (arg === "--asset") {
      index += 1;
    }
  }
}

export function parseArgs(args: readonly string[]): CliCommand {
  const [command, maybeSymbol] = args;

  if (command === "daily" || command === "weekly") {
    rejectUnknownArgs(args, 1);

    return {
      jobType: command,
      assetClass: parseAsset(readFlagValue(args, "--asset")),
      depth: readDepth(args),
    };
  }

  if (command === "ticker") {
    rejectUnknownArgs(args, 2);

    if (maybeSymbol === undefined || maybeSymbol.startsWith("--")) {
      throw new Error("Expected symbol for ticker command");
    }

    const assetClass = parseAsset(readFlagValue(args, "--asset"));
    const instrument = createInstrument(maybeSymbol, assetClass);

    return {
      jobType: "ticker",
      assetClass,
      symbol: instrument.symbol,
      depth: readDepth(args),
    };
  }

  if (command === "alpha-search") {
    rejectUnknownArgs(args, 1);

    const assetClass = parseAsset(readFlagValue(args, "--asset"));
    if (assetClass !== "equity") {
      throw new Error("alpha-search supports only --asset equity in V1");
    }

    return {
      jobType: "alpha-search",
      assetClass,
      depth: readDepth(args),
    };
  }

  if (command === "score") {
    return { jobType: "score" };
  }

  if (command === "calibration") {
    return { jobType: "calibration" };
  }

  if (command === "cache" && maybeSymbol === "prune" && args.length === 2) {
    return { jobType: "cache-prune" };
  }

  if (command === "provider-health" && args.length === 1) {
    return { jobType: "provider-health" };
  }

  throw new Error(
    "Usage: market-bot daily --asset equity|crypto [--deep] | market-bot weekly --asset equity|crypto [--deep] | market-bot ticker <symbol> --asset equity|crypto [--deep] | market-bot alpha-search --asset equity [--deep] | market-bot score | market-bot calibration | market-bot cache prune | market-bot provider-health",
  );
}

export function commandLabel(command: CliCommand): string {
  if (
    command.jobType === "score" ||
    command.jobType === "calibration" ||
    command.jobType === "cache-prune" ||
    command.jobType === "provider-health"
  ) {
    return command.jobType;
  }
  const depthSuffix = command.depth === "deep" ? " deep" : "";
  const symbolPart = command.jobType === "ticker" ? ` ${command.symbol}` : "";

  return `${command.jobType}${symbolPart} ${command.assetClass}${depthSuffix}`;
}
