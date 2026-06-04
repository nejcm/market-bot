import type { AssetClass, Depth } from "../domain/types";
import { createInstrument } from "../domain/instrument";
import { commandLabel, USAGE, type CliCommand } from "./job-registry";

export { commandLabel };
export type {
  AlphaSearchCommand,
  CachePruneCommand,
  CalibrationCommand,
  CliCommand,
  DailyCommand,
  ProviderHealthCommand,
  ResearchCommand,
  ScoreCommand,
  TickerCommand,
  WeeklyCommand,
} from "./job-registry";

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

  throw new Error(USAGE);
}
