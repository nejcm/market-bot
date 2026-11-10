import type { PredictionScoreStatus, ScoreOutcome } from "./types";

export function isTerminal(status: PredictionScoreStatus): boolean {
  return status === "resolved" || status === "voided" || status === "abandoned";
}

export function hasOutcome<
  T extends {
    readonly status?: string | undefined;
    readonly outcome?: ScoreOutcome | undefined;
  },
>(score: T): score is T & { readonly outcome: ScoreOutcome } {
  return score.status === "resolved" && score.outcome !== undefined;
}
