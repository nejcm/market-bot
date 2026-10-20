import { isRecord } from "../guards";
import type { ModelProvider } from "../model/types";

export const JUDGE_STAGE = "eval-judge";
export const JUDGE_SAMPLES = 3;

type JudgeVote = "yes" | "no" | "insufficient-evidence" | "invalid";

export interface JudgeItem {
  readonly question: string;
  readonly claim: string;
  readonly evidence: readonly { readonly sourceId: string; readonly text: string }[];
}

export interface JudgeResult {
  readonly verdict: "yes" | "no" | "insufficient-evidence" | "undecided";
  readonly votes: readonly JudgeVote[];
  readonly agreement: number;
}

export function aggregateVotes(votes: readonly JudgeVote[]): JudgeResult {
  const counts = (["yes", "no", "insufficient-evidence"] as const).map(
    (verdict) => [verdict, votes.filter((vote) => vote === verdict).length] as const,
  );
  const [top, topCount] = counts.toSorted((a, b) => b[1] - a[1])[0]!;
  return {
    verdict: topCount > votes.length / 2 ? top : "undecided",
    votes,
    agreement: votes.length === 0 ? 0 : topCount / votes.length,
  };
}

function parseVote(content: string): JudgeVote {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) &&
      (parsed.verdict === "yes" ||
        parsed.verdict === "no" ||
        parsed.verdict === "insufficient-evidence")
      ? parsed.verdict
      : "invalid";
  } catch {
    return "invalid";
  }
}

const JUDGE_SYSTEM =
  'You audit research claims against quoted evidence. Answer only the question asked, as JSON: {"verdict":"yes"|"no"|"insufficient-evidence","reason":string}. Use "insufficient-evidence" when the evidence shown cannot settle the question.';
const JUDGE_OUTPUT_TOKENS = 120;

function judgeUserMessage(item: JudgeItem): string {
  return JSON.stringify({ stage: JUDGE_STAGE, ...item });
}

export async function judgeItem(
  provider: ModelProvider,
  model: string,
  item: JudgeItem,
  samples: number = JUDGE_SAMPLES,
): Promise<JudgeResult & { readonly tokens: number }> {
  const votes: JudgeVote[] = [];
  let tokens = 0;
  for (let sample = 0; sample < samples; sample += 1) {
    // oxlint-disable-next-line no-await-in-loop -- independent votes stay in recorded order for cassette replay
    const response = await provider.generate({
      stage: JUDGE_STAGE,
      model,
      responseFormat: "json",
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: judgeUserMessage(item) },
      ],
    });
    tokens += response.tokenEstimate;
    votes.push(parseVote(response.content));
  }
  return { ...aggregateVotes(votes), tokens };
}

// Planning estimate only: characters/4 input plus a fixed output allowance per vote.
export function estimateJudgeTokens(
  items: readonly JudgeItem[],
  samples: number = JUDGE_SAMPLES,
): number {
  return items.reduce(
    (sum, item) =>
      sum +
      samples *
        (Math.ceil((JUDGE_SYSTEM.length + judgeUserMessage(item).length) / 4) +
          JUDGE_OUTPUT_TOKENS),
    0,
  );
}
