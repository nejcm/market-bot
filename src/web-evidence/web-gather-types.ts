import type { AppConfig } from "../config";
import type { CostPricing } from "../model/pricing";
import type { ResearchCommand } from "../cli/args";
import type {
  WebGatherSanitizerAudit,
  WebGatherLoopAudit,
  WebGatherDuplicateResultAudit,
  WebGatherToolName,
  WebGatherAcceptancePolicy,
  WebSearchType,
} from "../domain/types";
import type { CollectedSources, FetchLike } from "../sources/types";
import { WEB_GATHER_TOOL_UNITS } from "../sources/web-gather-tools";
import type { WebGatherSubject, WebGatherToolOutput } from "../sources/web-gather-emit";
import type { ResearchContext, WebGatherContext } from "../research/research-context-types";

export interface WebGatherStageOutput {
  readonly stage: "web-gather";
  readonly content: string;
  readonly tokenEstimate: number;
  readonly durationMs?: number;
  readonly costEstimateUsd?: number;
  readonly costPricing?: CostPricing;
}

export interface WebGatherLoopResult {
  readonly collectedSources: CollectedSources;
  readonly stageOutputs: readonly WebGatherStageOutput[];
  readonly audit?: WebGatherLoopAudit;
  readonly skipCode?: WebGatherSkipCode;
}

export type WebGatherSkipCode =
  | "run-not-applicable"
  | "missing-exa-credential"
  | "disabled-by-config"
  | "round-budget-zero"
  | "tool-call-budget-zero"
  | "source-budget-zero"
  | "subject-unavailable";

export interface WebGatherLoopInput {
  readonly command: ResearchCommand;
  readonly config: AppConfig;
  readonly collectedSources: CollectedSources;
  readonly context: ResearchContext;
  readonly now: Date;
  readonly fetchImpl?: FetchLike;
  readonly retryDelaysMs?: readonly number[];
  readonly reusedProfileCoverage?: WebGatherContext["reusedProfileCoverage"];
  readonly acceptancePolicy?: WebGatherAcceptancePolicy;
  readonly generateRound: (
    collectedSources: CollectedSources,
    context: ResearchContext,
    priorStages: readonly WebGatherStageOutput[],
  ) => Promise<WebGatherStageOutput>;
}

export type ModelWebGatherRequest =
  | {
      readonly tool: "web_search";
      readonly args: {
        readonly query: string;
        readonly searchType: WebSearchType;
        readonly numResults?: number;
      };
      readonly rationale: string;
    }
  | {
      readonly tool: "web_fetch";
      readonly args: { readonly url: string };
      readonly rationale: string;
    };

export interface ValidationState {
  readonly seenKeys: Set<string>;
  readonly surfacedUrls: Set<string>;
  readonly thematicListSearchWidened: { value: boolean };
  readonly subject: WebGatherSubject;
  readonly subjectTerms: readonly string[];
  readonly command: ResearchCommand;
  readonly secFilingCoverage: WebGatherContext["secFilingCoverage"];
  readonly reusedProfileCoverage: WebGatherContext["reusedProfileCoverage"];
  readonly acceptancePolicy: WebGatherAcceptancePolicy | undefined;
  readonly config: AppConfig;
  readonly round: number;
}

export interface WebGatherExecutionAudit {
  readonly sanitizer: WebGatherSanitizerAudit;
  readonly freshness?: NonNullable<WebGatherToolOutput["freshness"]>;
  readonly fallback?: NonNullable<WebGatherToolOutput["fallback"]>;
  readonly duplicateResults?: readonly WebGatherDuplicateResultAudit[];
}

export const ALLOWED_TOOLS: ReadonlySet<string> = new Set(Object.keys(WEB_GATHER_TOOL_UNITS));
export const AVAILABLE_TOOLS: readonly WebGatherToolName[] = ["web_search", "web_fetch"];
export const MAX_RATIONALE_TRACE_LENGTH = 500;
export const MAX_PARSE_FAILURE_ECHO_LENGTH = 2000;
