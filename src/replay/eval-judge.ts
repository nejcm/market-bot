import { isRecord } from "../guards";
import type { ModelProvider } from "../model/types";

export const JUDGE_STAGE = "eval-judge";
const JUDGE_SAMPLES = 3;

type JudgeVote = "yes" | "no" | "invalid";

export interface JudgeItem {
  readonly question: string;
  readonly claim: string;
  readonly evidence: readonly { readonly sourceId: string; readonly text: string }[];
}

export interface JudgeResult {
  readonly verdict: "yes" | "no" | "undecided";
  readonly votes: readonly JudgeVote[];
  readonly agreement: number;
}

export function aggregateVotes(votes: readonly JudgeVote[]): JudgeResult {
  const yes = votes.filter((vote) => vote === "yes").length;
  const no = votes.filter((vote) => vote === "no").length;
  const majority = votes.length / 2;
  let verdict: JudgeResult["verdict"] = "undecided";
  if (yes > majority) {
    verdict = "yes";
  } else if (no > majority) {
    verdict = "no";
  }
  return {
    verdict,
    votes,
    agreement: votes.length === 0 ? 0 : Math.max(yes, no) / votes.length,
  };
}

function parseVote(content: string): JudgeVote {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) && (parsed.verdict === "yes" || parsed.verdict === "no")
      ? parsed.verdict
      : "invalid";
  } catch {
    return "invalid";
  }
}

const JUDGE_SYSTEM =
  'You audit research claims against quoted evidence. Answer only the question asked, as JSON: {"verdict":"yes"|"no","reason":string}.';
const JUDGE_OUTPUT_TOKENS = 120;

function judgeUserMessage(item: JudgeItem): string {
  return JSON.stringify({ stage: JUDGE_STAGE, ...item });
}

export async function judgeItem(
  provider: ModelProvider,
  model: string,
  item: JudgeItem,
  samples: number = JUDGE_SAMPLES,
): Promise<JudgeResult> {
  const votes: JudgeVote[] = [];
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
    votes.push(parseVote(response.content));
  }
  return aggregateVotes(votes);
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
