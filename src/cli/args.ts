import type { AssetClass, Depth } from "../domain/types";
import { isResearchJobType } from "../domain/run-types";
import { createInstrument } from "../domain/instrument";
import { HISTORY_SECTIONS, type HistorySection } from "../history/artifacts";
import {
  commandLabel,
  isInstrumentCommand,
  isResearchCommand,
  USAGE,
  type CliCommand,
  type HistoryRebuildCommand,
  type HistorySearchCommand,
  type HistoryThesisDeltaCommand,
  type IndexRebuildCommand,
  type MarketOverviewCommand,
  type ResearchSubjectCommand,
} from "./job-registry";

export { commandLabel, isInstrumentCommand, isResearchCommand };
export type {
  AlphaSearchCommand,
  CachePruneCommand,
  CalibrationCommand,
  CliCommand,
  HistoryRebuildCommand,
  HistorySearchCommand,
  HistoryThesisDeltaCommand,
  IndexRebuildCommand,
  MarketOverviewCommand,
  InstrumentCommand,
  ProviderHealthCommand,
  ResearchCommand,
  ScoreCommand,
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

function readOptionalAsset(value: string | undefined): AssetClass | undefined {
  return value === undefined ? undefined : parseAsset(value);
}

function readLimit(value: string | undefined): number | undefined {
  if (value === undefined) {
    return;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("Expected positive integer after --limit");
  }
  return parsed;
}

function readHorizon(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    throw new Error("Expected --horizon integer 1-20");
  }
  return parsed;
}

function readPromptPositionals(
  args: readonly string[],
  allowedFlags: ReadonlySet<string>,
): string | undefined {
  const positionals: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (!allowedFlags.has(arg)) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    if (arg !== "--deep") {
      index += 1;
    }
  }
  const prompt = positionals.join(" ").trim();
  return prompt === "" ? undefined : prompt;
}

function parseMarketOverviewArgs(
  command: "market-overview" | "daily" | "weekly",
  args: readonly string[],
): MarketOverviewCommand {
  const defaultHorizon = command === "daily" ? 5 : 15;
  const allowedFlags =
    command === "market-overview"
      ? new Set(["--asset", "--deep", "--horizon"])
      : new Set(["--asset", "--deep"]);
  const prompt = readPromptPositionals(args, allowedFlags);
  return {
    jobType: "market-overview",
    assetClass: parseAsset(readFlagValue(args, "--asset")),
    depth: readDepth(args),
    horizonTradingDays: readHorizon(readFlagValue(args, "--horizon"), defaultHorizon),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(command === "daily" || command === "weekly" ? { legacyAlias: command } : {}),
  };
}

function parseResearchArgs(args: readonly string[]): ResearchSubjectCommand {
  const subject = readPromptPositionals(args, new Set(["--deep"]));
  if (subject === undefined) {
    throw new Error("Expected subject for research command");
  }

  return {
    jobType: "research",
    assetClass: "equity",
    subject,
    depth: readDepth(args),
  };
}

function readSection(value: string | undefined): HistorySection | undefined {
  if (value === undefined) {
    return;
  }
  if (!(HISTORY_SECTIONS as readonly string[]).includes(value)) {
    throw new Error(`Expected --section ${HISTORY_SECTIONS.join("|")}`);
  }
  return value as HistorySection;
}

// Boolean flags stand alone; any other allowed flag consumes the next arg as its value.
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["--deep", "--narrative"]);

function rejectUnknownHistoryArgs(
  args: readonly string[],
  allowedFlags: ReadonlySet<string>,
): void {
  for (let index = 0; index < args.length; index += 1) {
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
    if (!BOOLEAN_FLAGS.has(arg)) {
      index += 1;
    }
  }
}

function rejectUnknownArgs(
  args: readonly string[],
  allowedPositionals: number,
  allowedFlags: ReadonlySet<string>,
): void {
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

    if (!BOOLEAN_FLAGS.has(arg)) {
      index += 1;
    }
  }
}

export function parseArgs(args: readonly string[]): CliCommand {
  const [command, maybeSymbol] = args;

  if (command === "market-overview" || command === "daily" || command === "weekly") {
    return parseMarketOverviewArgs(command, args);
  }

  if (command === "equity" || command === "crypto") {
    rejectUnknownArgs(args, 2, new Set(["--deep"]));

    if (maybeSymbol === undefined || maybeSymbol.startsWith("--")) {
      throw new Error(`Expected symbol for ${command} command`);
    }

    const instrument = createInstrument(maybeSymbol, command);

    return {
      jobType: command,
      assetClass: command,
      symbol: instrument.symbol,
      depth: readDepth(args),
    };
  }

  if (command === "alpha-search") {
    rejectUnknownArgs(args, 1, new Set(["--asset", "--deep"]));

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

  if (command === "research") {
    return parseResearchArgs(args);
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

  if (command === "index" && maybeSymbol === "rebuild" && args.length === 2) {
    return { jobType: "index-rebuild" } satisfies IndexRebuildCommand;
  }

  if (command === "history" && maybeSymbol === "rebuild" && args.length === 2) {
    return { jobType: "history-rebuild" } satisfies HistoryRebuildCommand;
  }

  if (command === "history" && maybeSymbol === "search") {
    rejectUnknownHistoryArgs(
      args.slice(2),
      new Set([
        "--query",
        "--symbol",
        "--asset",
        "--job-type",
        "--from",
        "--to",
        "--section",
        "--provider",
        "--limit",
      ]),
    );
    const query = readFlagValue(args, "--query");
    if (query === undefined || query.trim() === "") {
      throw new Error("Expected --query for history search");
    }
    const symbol = readFlagValue(args, "--symbol");
    const assetClass = readOptionalAsset(readFlagValue(args, "--asset"));
    const jobType = readFlagValue(args, "--job-type");
    const from = readFlagValue(args, "--from");
    const to = readFlagValue(args, "--to");
    const section = readSection(readFlagValue(args, "--section"));
    const provider = readFlagValue(args, "--provider");
    const limit = readLimit(readFlagValue(args, "--limit"));
    if (jobType !== undefined && !isResearchJobType(jobType)) {
      throw new Error(
        "Expected --job-type market-overview|daily|weekly|equity|crypto|alpha-search|research",
      );
    }
    return {
      jobType: "history-search",
      query,
      ...(symbol !== undefined ? { symbol: symbol.toUpperCase() } : {}),
      ...(assetClass !== undefined ? { assetClass } : {}),
      ...(jobType !== undefined ? { sourceJobType: jobType } : {}),
      ...(from !== undefined ? { from } : {}),
      ...(to !== undefined ? { to } : {}),
      ...(section !== undefined ? { section } : {}),
      ...(provider !== undefined ? { provider } : {}),
      ...(limit !== undefined ? { limit } : {}),
    } satisfies HistorySearchCommand;
  }

  if (command === "history" && maybeSymbol === "thesis-delta") {
    rejectUnknownHistoryArgs(args.slice(3), new Set(["--asset", "--since", "--to", "--narrative"]));
    const symbol = args.at(2);
    if (symbol === undefined || symbol.startsWith("--")) {
      throw new Error("Expected symbol for history thesis-delta");
    }
    const since = readFlagValue(args, "--since");
    const to = readFlagValue(args, "--to");
    return {
      jobType: "history-thesis-delta",
      symbol: symbol.toUpperCase(),
      assetClass: readOptionalAsset(readFlagValue(args, "--asset")) ?? "equity",
      ...(since !== undefined ? { since } : {}),
      ...(to !== undefined ? { to } : {}),
      narrative: args.includes("--narrative"),
    } satisfies HistoryThesisDeltaCommand;
  }

  throw new Error(USAGE);
}
