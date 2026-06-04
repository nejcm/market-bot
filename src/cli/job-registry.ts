import type { AssetClass, Depth } from "../domain/types";
import type { HistorySection } from "../history/artifacts";

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

export interface HistoryRebuildCommand {
  readonly jobType: "history-rebuild";
}

export interface HistorySearchCommand {
  readonly jobType: "history-search";
  readonly query: string;
  readonly symbol?: string;
  readonly assetClass?: AssetClass;
  readonly sourceJobType?: "daily" | "weekly" | "ticker" | "alpha-search";
  readonly from?: string;
  readonly to?: string;
  readonly section?: HistorySection;
  readonly provider?: string;
  readonly limit?: number;
}

export interface HistoryThesisDeltaCommand {
  readonly jobType: "history-thesis-delta";
  readonly symbol: string;
  readonly assetClass: AssetClass;
  readonly since?: string;
  readonly to?: string;
  readonly narrative: boolean;
}

export type ResearchCommand = DailyCommand | WeeklyCommand | TickerCommand;
export type CliCommand =
  | ResearchCommand
  | AlphaSearchCommand
  | ScoreCommand
  | CalibrationCommand
  | CachePruneCommand
  | ProviderHealthCommand
  | HistoryRebuildCommand
  | HistorySearchCommand
  | HistoryThesisDeltaCommand;

export const ASSET_CLASS_OPTIONS = ["equity", "crypto"] as const;
export const DEPTH_OPTIONS = ["brief", "deep"] as const;
export const CONSOLE_JOB_TYPES = [
  "daily",
  "weekly",
  "ticker",
  "alpha-search",
  "score",
  "calibration",
  "cache-prune",
  "provider-health",
] as const;
export const SEARCH_JOB_TYPE_OPTIONS = ["", "daily", "weekly", "ticker", "alpha-search"] as const;

export const USAGE =
  "Usage: market-bot daily --asset equity|crypto [--deep] | market-bot weekly --asset equity|crypto [--deep] | market-bot ticker <symbol> --asset equity|crypto [--deep] | market-bot alpha-search --asset equity [--deep] | market-bot score | market-bot calibration | market-bot cache prune | market-bot provider-health | market-bot history rebuild | market-bot history search --query <text> | market-bot history thesis-delta <symbol> [--asset equity|crypto] [--since <date|run-id>] [--to <date|run-id>] [--narrative]";

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

export function jobSupportsAsset(jobType: string): boolean {
  return jobType === "daily" || jobType === "weekly" || jobType === "ticker";
}

export function jobSupportsDepth(jobType: string): boolean {
  return (
    jobType === "daily" ||
    jobType === "weekly" ||
    jobType === "ticker" ||
    jobType === "alpha-search"
  );
}

export function commandLabel(command: CliCommand): string {
  if (
    command.jobType === "score" ||
    command.jobType === "calibration" ||
    command.jobType === "cache-prune" ||
    command.jobType === "provider-health" ||
    command.jobType === "history-rebuild"
  ) {
    return command.jobType;
  }
  if (command.jobType === "history-search") {
    return `history search ${command.query}`;
  }
  if (command.jobType === "history-thesis-delta") {
    return `history thesis-delta ${command.assetClass}:${command.symbol}`;
  }
  const depthSuffix = command.depth === "deep" ? " deep" : "";
  const symbolPart = command.jobType === "ticker" ? ` ${command.symbol}` : "";

  return `${command.jobType}${symbolPart} ${command.assetClass}${depthSuffix}`;
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
