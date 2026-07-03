import type { ResearchCommand } from "../cli/args";
import { marketSpotlightOptions, type AppConfig } from "../config";
import { isMarketUpdateJobType, type Mover } from "../domain/types";
import type { ModelProvider } from "../model/types";
import { withUntrustedModelInputRule } from "../model/trust-guard";
import { rankMovers } from "../movers/ranking";
import type { CollectedSources } from "../sources/types";
import type { StageOutput } from "./final-synthesis";
import type { HistoricalContextReader, HistoricalResearchContext } from "./historical-context";
import { buildMarketUpdateDelta } from "./market-update-delta";
import { loadStagePrompt } from "./prompt-loader";
import {
  buildSpotlightSelectionPrompt,
  moverLimitFor,
  type ResearchContext,
} from "./research-context";
import {
  buildSpotlightCandidates,
  parseSpotlightSelection,
  type loadAlphaWatchlistForSpotlights,
  type SpotlightCandidate,
  type SpotlightSelectionResult,
} from "./spotlights";

function spotlightCap(command: ResearchCommand, config: AppConfig): number {
  const options = marketSpotlightOptions(config);
  return command.depth === "deep" ? options.deepLimit : options.briefLimit;
}

function emptySpotlightSelection(cap: number, candidateCount: number): SpotlightSelectionResult {
  return {
    selected: [],
    rejected: [],
    audit: {
      cap,
      candidateCount,
      selectedCount: 0,
      rejectedCount: 0,
      malformed: false,
    },
  };
}

export function emptySpotlightSelectionFor(
  command: ResearchCommand,
  config: AppConfig,
): SpotlightSelectionResult {
  return emptySpotlightSelection(spotlightCap(command, config), 0);
}

async function runSpotlightSelection(input: {
  readonly command: ResearchCommand;
  readonly config: AppConfig;
  readonly provider: ModelProvider;
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly candidates: readonly SpotlightCandidate[];
  readonly cap: number;
}): Promise<{
  readonly output?: StageOutput;
  readonly selection: SpotlightSelectionResult;
}> {
  if (input.cap <= 0 || input.candidates.length === 0) {
    return {
      selection: emptySpotlightSelection(input.cap, input.candidates.length),
    };
  }
  const loaded = await loadStagePrompt(
    "spotlight-selection",
    input.command,
    input.config.promptDir,
  );
  const response = await input.provider.generate({
    model: input.context.runParams.quickModel,
    ...(input.context.runParams.modelParams !== undefined
      ? { params: input.context.runParams.modelParams }
      : {}),
    responseFormat: "json",
    messages: [
      { role: "system", content: withUntrustedModelInputRule(loaded.system) },
      {
        role: "user",
        content: buildSpotlightSelectionPrompt(
          input.command,
          input.collectedSources,
          input.context,
          loaded,
          input.candidates,
          input.cap,
        ),
      },
    ],
  });
  return {
    output: {
      stage: "spotlight-selection",
      content: response.content,
      tokenEstimate: response.tokenEstimate,
      costEstimateUsd: response.costEstimateUsd,
    },
    selection: parseSpotlightSelection(response.content, input.candidates, input.cap),
  };
}

function refreshSpotlightSelection(
  selection: SpotlightSelectionResult,
  candidates: readonly SpotlightCandidate[],
): SpotlightSelectionResult {
  const candidateBySymbol = new Map(candidates.map((candidate) => [candidate.symbol, candidate]));
  return {
    ...(selection.rationale !== undefined ? { rationale: selection.rationale } : {}),
    selected: selection.selected.flatMap((item) => {
      const candidate = candidateBySymbol.get(item.symbol);
      return candidate === undefined ? [] : [{ ...item, candidate }];
    }),
    rejected: selection.rejected,
    audit: selection.audit,
  };
}

export async function runMarketUpdatePhase(input: {
  readonly command: ResearchCommand;
  readonly config: AppConfig;
  readonly provider: ModelProvider;
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly historicalContext: HistoricalResearchContext;
  readonly historicalContextReader: HistoricalContextReader;
  readonly alpha: Awaited<ReturnType<typeof loadAlphaWatchlistForSpotlights>>;
  readonly alphaGaps: readonly string[];
  readonly now: Date;
}): Promise<{
  readonly context: ResearchContext;
  readonly historicalContext: HistoricalResearchContext;
  readonly spotlightCandidates?: readonly SpotlightCandidate[];
  readonly spotlightSelection?: SpotlightSelectionResult;
  readonly spotlightOutput?: StageOutput;
  readonly marketUpdateMovers?: readonly Mover[];
}> {
  if (!isMarketUpdateJobType(input.command.jobType)) {
    return { context: input.context, historicalContext: input.historicalContext };
  }

  let { historicalContext } = input;
  const marketOnlyHistoricalContext = historicalContext;
  const currentMarketSymbols = [
    ...new Set(
      input.collectedSources.marketSnapshots
        .filter((snapshot) => snapshot.assetClass === input.command.assetClass)
        .map((snapshot) => snapshot.symbol.toUpperCase()),
    ),
  ];
  let { context } = input;
  if (currentMarketSymbols.length > 0) {
    historicalContext = await input.historicalContextReader.load({
      command: input.command,
      config: input.config,
      now: input.now,
      spotlightSymbols: currentMarketSymbols,
      extraGaps: input.alphaGaps,
    });
    context = { ...context, historicalContext };
  }
  const cap = spotlightCap(input.command, input.config);
  const { candidateLimit } = marketSpotlightOptions(input.config);
  let spotlightCandidates = buildSpotlightCandidates({
    marketSnapshots: input.collectedSources.marketSnapshots.filter(
      (snapshot) => snapshot.assetClass === input.command.assetClass,
    ),
    historicalContext,
    candidateLimit,
    ...(input.alpha.watchlist !== undefined ? { alphaWatchlist: input.alpha.watchlist } : {}),
  });
  const spotlight = await runSpotlightSelection({
    command: input.command,
    config: input.config,
    provider: input.provider,
    collectedSources: input.collectedSources,
    context: { ...context, spotlightCandidates },
    candidates: spotlightCandidates,
    cap,
  });
  let spotlightSelection = spotlight.selection;
  if (spotlightSelection.selected.length > 0) {
    historicalContext = await input.historicalContextReader.load({
      command: input.command,
      config: input.config,
      now: input.now,
      spotlightSymbols: spotlightSelection.selected.map((item) => item.symbol),
      extraGaps: input.alphaGaps,
    });
    spotlightCandidates = buildSpotlightCandidates({
      marketSnapshots: input.collectedSources.marketSnapshots.filter(
        (snapshot) => snapshot.assetClass === input.command.assetClass,
      ),
      historicalContext,
      candidateLimit,
      ...(input.alpha.watchlist !== undefined ? { alphaWatchlist: input.alpha.watchlist } : {}),
    });
    spotlightSelection = refreshSpotlightSelection(spotlightSelection, spotlightCandidates);
  } else {
    historicalContext = marketOnlyHistoricalContext;
  }
  const marketUpdateMovers = rankMovers(
    input.collectedSources.marketSnapshots.filter(
      (snapshot) => snapshot.assetClass === input.command.assetClass,
    ),
    moverLimitFor(input.command, input.config),
  );
  const marketUpdateDelta = await buildMarketUpdateDelta({
    dataDir: input.config.dataDir,
    command: input.command,
    now: input.now,
    currentMovers: marketUpdateMovers,
    currentRegime: context.marketRegime,
    moverLimit: moverLimitFor(input.command, input.config),
  });
  context = {
    ...context,
    historicalContext,
    spotlightCandidates: spotlightSelection.selected.map((item) => item.candidate),
    spotlightSelection,
    marketUpdateDelta,
  };

  return {
    context,
    historicalContext,
    spotlightCandidates,
    spotlightSelection,
    ...(spotlight.output !== undefined ? { spotlightOutput: spotlight.output } : {}),
    marketUpdateMovers,
  };
}
