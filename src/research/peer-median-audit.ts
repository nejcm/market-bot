import type { ResearchCommand } from "../cli/args";
import type { PostSynthesisAuditWarning } from "../domain/run-trace";
import { isRecord } from "../guards";
import { withUntrustedModelInputRule } from "../model/trust-guard";
import type { ModelParams, ModelProvider } from "../model/types";
import type { StageOutput } from "./final-synthesis";
import type { PeerMedianLabels, PeerMedianMetric } from "./post-synthesis-audit";
import { loadStagePrompt } from "./prompt-loader";
import { ModelReplayError } from "../replay/llm-cassette";

export interface PeerMedianAuditClause {
  readonly location: string;
  readonly text: string;
}

interface PeerMedianAuditResult {
  readonly labels: PeerMedianLabels;
  readonly warnings: readonly PostSynthesisAuditWarning[];
  readonly stageOutput?: StageOutput;
}

export type PeerMedianAudit = (
  clauses: readonly PeerMedianAuditClause[],
) => Promise<PeerMedianAuditResult>;

const METRICS: readonly PeerMedianMetric[] = ["ev-revenue", "other", "absence"];

export function createPeerMedianAudit(options: {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly params?: ModelParams;
  readonly command: ResearchCommand;
  readonly promptDir?: string;
}): PeerMedianAudit {
  return async (clauses) => {
    const loaded = await loadStagePrompt("peer-median-audit", options.command, options.promptDir);
    const startedAt = performance.now();
    let content: string;
    let stageOutput: StageOutput;
    try {
      const response = await options.provider.generate({
        stage: "peer-median-audit",
        model: options.model,
        ...(options.params === undefined ? {} : { params: options.params }),
        responseFormat: "json",
        messages: [
          { role: "system", content: withUntrustedModelInputRule(loaded.system) },
          {
            role: "user",
            content: JSON.stringify({
              stage: "peer-median-audit",
              instruction: loaded.instruction,
              goal: loaded.goal,
              compsMetrics: ["EV/revenue"],
              clauses: clauses.map((clause, index) => ({ id: index + 1, ...clause })),
            }),
          },
        ],
      });
      ({ content } = response);
      stageOutput = {
        stage: "peer-median-audit",
        content: response.content,
        tokenEstimate: response.tokenEstimate,
        usage: response.usage ?? "unknown",
        durationMs: Math.max(performance.now() - startedAt, Number.EPSILON),
        ...(response.costEstimateUsd === undefined
          ? {}
          : { costEstimateUsd: response.costEstimateUsd }),
        ...(response.costPricing === undefined ? {} : { costPricing: response.costPricing }),
      };
    } catch (error) {
      // A replay miss is a missing recording, not a provider failure; strict replay must fail.
      if (error instanceof ModelReplayError) {
        throw error;
      }
      return unavailable(error instanceof Error ? error.message : String(error));
    }
    const labels = parseLabels(content, clauses);
    return labels === undefined
      ? { ...unavailable("malformed response"), stageOutput }
      : { labels, warnings: [], stageOutput };
  };
}

function parseLabels(
  content: string,
  clauses: readonly PeerMedianAuditClause[],
): PeerMedianLabels | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.clauses)) {
    return undefined;
  }
  const labels = new Map<string, PeerMedianMetric>();
  const conflicted = new Set<string>();
  for (const row of parsed.clauses) {
    const clause = isRecord(row) && typeof row.id === "number" ? clauses[row.id - 1] : undefined;
    const metric = isRecord(row) ? METRICS.find((value) => value === row.metric) : undefined;
    if (clause === undefined || metric === undefined) {
      continue;
    }
    if ((labels.get(clause.text) ?? metric) !== metric) {
      conflicted.add(clause.text);
    }
    labels.set(clause.text, metric);
  }
  for (const text of conflicted) {
    labels.delete(text);
  }
  return labels;
}

function unavailable(reason: string): PeerMedianAuditResult {
  return {
    labels: new Map(),
    warnings: [
      {
        code: "peer-median-audit-unavailable",
        location: "report",
        message: `peer-median audit unavailable (${reason}); regex classification used`,
        sourceIds: [],
      },
    ],
  };
}
