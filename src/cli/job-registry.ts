import {
  isInstrumentJobType,
  type AssetClass,
  type Depth,
  type InstrumentJobType,
  type LegacyMarketUpdateJobType,
} from "../domain/types";
import type { HistorySection } from "../history/artifacts";
import { isRecord } from "../sources/guards";

export interface MarketOverviewCommand {
  readonly jobType: "market-overview";
  readonly assetClass: AssetClass;
  readonly depth: Depth;
  readonly horizonTradingDays: number;
  readonly prompt?: string;
  readonly legacyAlias?: LegacyMarketUpdateJobType;
}

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

export interface InstrumentCommand {
  readonly jobType: InstrumentJobType;
  readonly assetClass: AssetClass;
  readonly symbol: string;
  readonly depth: Depth;
}

export interface AlphaSearchCommand {
  readonly jobType: "alpha-search";
  readonly assetClass: "equity";
  readonly depth: Depth;
}

export interface ResearchSubjectCommand {
  readonly jobType: "research";
  readonly assetClass: "equity";
  readonly subject: string;
  readonly subjectKey?: string;
  readonly predictionProxySymbol?: string;
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

export interface IndexRebuildCommand {
  readonly jobType: "index-rebuild";
}

export interface HistorySearchCommand {
  readonly jobType: "history-search";
  readonly query: string;
  readonly symbol?: string;
  readonly assetClass?: AssetClass;
  readonly sourceJobType?:
    | "market-overview"
    | "daily"
    | "weekly"
    | "equity"
    | "crypto"
    | "alpha-search"
    | "research";
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

export type ResearchCommand =
  | MarketOverviewCommand
  | DailyCommand
  | WeeklyCommand
  | InstrumentCommand
  | ResearchSubjectCommand;
export type CliCommand =
  | ResearchCommand
  | AlphaSearchCommand
  | ScoreCommand
  | CalibrationCommand
  | CachePruneCommand
  | ProviderHealthCommand
  | HistoryRebuildCommand
  | IndexRebuildCommand
  | HistorySearchCommand
  | HistoryThesisDeltaCommand;

// Narrows a command to a single-instrument (equity / crypto) run, exposing `symbol`.
export function isInstrumentCommand(command: ResearchCommand): command is InstrumentCommand {
  return isInstrumentJobType(command.jobType);
}

export const ASSET_CLASS_OPTIONS = ["equity", "crypto"] as const;
export const DEPTH_OPTIONS = ["brief", "deep"] as const;

export const CONSOLE_JOB_TYPES = [
  "daily",
  "weekly",
  "market-overview",
  "equity",
  "crypto",
  "research",
  "alpha-search",
  "score",
  "calibration",
  "cache-prune",
  "provider-health",
] as const;
export const SEARCH_JOB_TYPE_OPTIONS = [
  "",
  "market-overview",
  "daily",
  "weekly",
  "equity",
  "crypto",
  "alpha-search",
  "research",
] as const;

export const USAGE =
  "Usage: market-bot market-overview --asset equity|crypto [--horizon trading-days] [--deep] [prompt] | market-bot daily --asset equity|crypto [--deep] | market-bot weekly --asset equity|crypto [--deep] | market-bot equity <symbol> [--deep] | market-bot crypto <symbol> [--deep] | market-bot research <subject> [--deep] | market-bot alpha-search --asset equity [--deep] | market-bot score | market-bot calibration | market-bot cache prune | market-bot provider-health | market-bot index rebuild | market-bot history rebuild | market-bot history search --query <text> | market-bot history thesis-delta <symbol> [--asset equity|crypto] [--since <date|run-id>] [--to <date|run-id>] [--narrative]";

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readPositiveIntegerString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
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
  return jobType === "daily" || jobType === "weekly" || jobType === "market-overview";
}

export function jobSupportsDepth(jobType: string): boolean {
  return (
    jobType === "daily" ||
    jobType === "weekly" ||
    jobType === "market-overview" ||
    jobType === "equity" ||
    jobType === "crypto" ||
    jobType === "alpha-search" ||
    jobType === "research"
  );
}

export function commandLabel(command: CliCommand): string {
  if (
    command.jobType === "score" ||
    command.jobType === "calibration" ||
    command.jobType === "cache-prune" ||
    command.jobType === "provider-health" ||
    command.jobType === "history-rebuild" ||
    command.jobType === "index-rebuild"
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
  if (command.jobType === "equity" || command.jobType === "crypto") {
    return `${command.jobType} ${command.symbol}${depthSuffix}`;
  }
  if (command.jobType === "market-overview") {
    const alias = command.legacyAlias === undefined ? "market-overview" : command.legacyAlias;
    return `${alias} ${command.assetClass} ${String(command.horizonTradingDays)}d${depthSuffix}`;
  }
  if (command.jobType === "research") {
    return `research ${command.subject}${depthSuffix}`;
  }

  return `${command.jobType} ${command.assetClass}${depthSuffix}`;
}

export function jobRequestArgv(value: unknown): readonly string[] {
  if (!isRecord(value)) {
    throw new Error("Job request must be an object");
  }

  const jobType = readString(value, "jobType");
  if (jobType === "daily" || jobType === "weekly" || jobType === "market-overview") {
    const assetClass = readAssetClass(readString(value, "assetClass"));
    const horizon = readPositiveIntegerString(value, "horizonTradingDays");
    return [
      jobType,
      "--asset",
      assetClass,
      ...(jobType === "market-overview" && horizon !== undefined ? ["--horizon", horizon] : []),
      ...depthArg(readDepth(readString(value, "depth"))),
    ];
  }

  if (jobType === "equity" || jobType === "crypto") {
    const symbol = readString(value, "symbol");
    if (symbol === undefined || symbol.trim() === "") {
      throw new Error(`Expected ${jobType} symbol`);
    }

    return [jobType, symbol, ...depthArg(readDepth(readString(value, "depth")))];
  }

  if (jobType === "alpha-search") {
    return [
      "alpha-search",
      "--asset",
      "equity",
      ...depthArg(readDepth(readString(value, "depth"))),
    ];
  }

  if (jobType === "research") {
    const subject = readString(value, "subject")?.trim();
    if (subject === undefined || subject === "") {
      throw new Error("Expected research subject");
    }

    return [
      "research",
      ...subject.split(/\s+/u),
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
