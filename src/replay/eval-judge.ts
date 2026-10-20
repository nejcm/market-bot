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
        {
          role: "system",
          content:
            'You audit research claims against quoted evidence. Answer only the question asked, as JSON: {"verdict":"yes"|"no","reason":string}.',
        },
        { role: "user", content: JSON.stringify({ stage: JUDGE_STAGE, ...item }) },
      ],
    });
    votes.push(parseVote(response.content));
  }
  return aggregateVotes(votes);
}
