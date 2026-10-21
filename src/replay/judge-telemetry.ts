import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { isRecord } from "../guards";

interface JudgeIdentity {
  readonly provider: string;
  readonly model: string;
}

// One judged sample's measured spend: items before cancellation, items actually judged, judge calls and tokens.
export interface JudgeTelemetrySample extends JudgeIdentity {
  readonly capture: string;
  readonly arm: string;
  readonly items: number;
  readonly judgedItems: number;
  readonly calls: number;
  readonly tokens: number;
}

export interface JudgeCalibration {
  readonly samples: number;
  readonly tokensPerCall: number;
  readonly votesPerJudgedItem: number;
  // Measured only on the same capture and arm; absent elsewhere, so no cancellation rate transfers.
  readonly cancelShare: { readonly ablation?: number; readonly control?: number };
}

export const captureOf = (input: string) => basename(dirname(dirname(input)));

const count = (value: unknown, min: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min;

function usable(row: unknown): row is JudgeTelemetrySample {
  return (
    isRecord(row) &&
    typeof row.provider === "string" &&
    typeof row.model === "string" &&
    typeof row.capture === "string" &&
    typeof row.arm === "string" &&
    count(row.judgedItems, 1) &&
    count(row.items, row.judgedItems as number) &&
    count(row.calls, row.judgedItems as number) &&
    typeof row.tokens === "number" &&
    Number.isFinite(row.tokens) &&
    row.tokens > 0
  );
}

function fromEvalSample(sample: unknown): unknown {
  if (!isRecord(sample) || sample.status !== "completed" || !isRecord(sample.judged)) {
    return undefined;
  }
  const { judged } = sample;
  return {
    ...(isRecord(judged.judge) ? judged.judge : {}),
    capture: typeof sample.input === "string" ? captureOf(sample.input) : undefined,
    arm: isRecord(sample.arm) ? sample.arm.name : "baseline",
    items: judged.items,
    judgedItems: Array.isArray(judged.units) ? judged.units.length : undefined,
    calls: isRecord(sample.modelCalls) ? sample.modelCalls.judge : undefined,
    tokens: isRecord(sample.tokens) ? sample.tokens.judge : undefined,
  };
}

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

// Judged samples under `evalsRoot` that record their judge identity, plus the checked-in telemetry file; unusable records are counted, never thrown.
export async function readJudgeTelemetry(
  evalsRoot: string,
  telemetryFile: string,
): Promise<{ readonly samples: readonly JudgeTelemetrySample[]; readonly skipped: number }> {
  const samples: JudgeTelemetrySample[] = [];
  let skipped = 0;
  const fixture = await readJson(telemetryFile);
  const rows = [
    ...(isRecord(fixture) && Array.isArray(fixture.samples) ? fixture.samples : []),
  ] as unknown[];
  for await (const path of new Bun.Glob("*/*/eval-sample.json").scan({ cwd: evalsRoot })) {
    const sample = await readJson(join(evalsRoot, path));
    if (sample === undefined || (isRecord(sample) && isRecord(sample.judged))) {
      rows.push(fromEvalSample(sample));
    }
  }
  for (const row of rows) {
    if (usable(row)) {
      samples.push(row);
    } else {
      skipped += 1;
    }
  }
  return { samples, skipped };
}

const ratio = (
  rows: readonly JudgeTelemetrySample[],
  top: keyof JudgeTelemetrySample,
  bottom: keyof JudgeTelemetrySample,
) =>
  rows.reduce((sum, row) => sum + (row[top] as number), 0) /
  rows.reduce((sum, row) => sum + (row[bottom] as number), 0);

// Undefined unless some sample was judged by exactly this provider and model.
export function calibrateJudge(
  samples: readonly JudgeTelemetrySample[],
  identity: JudgeIdentity,
  pair: { readonly capture: string; readonly ablation: string; readonly control: string },
): JudgeCalibration | undefined {
  const matching = samples.filter(
    (row) => row.provider === identity.provider && row.model === identity.model,
  );
  if (matching.length === 0) {
    return undefined;
  }
  const cancelShare = (arm: string) => {
    const same = matching.filter((row) => row.capture === pair.capture && row.arm === arm);
    return same.length === 0 ? undefined : 1 - ratio(same, "judgedItems", "items");
  };
  const ablation = cancelShare(pair.ablation);
  const control = cancelShare(pair.control);
  return {
    samples: matching.length,
    tokensPerCall: ratio(matching, "tokens", "calls"),
    votesPerJudgedItem: ratio(matching, "calls", "judgedItems"),
    cancelShare: {
      ...(ablation === undefined ? {} : { ablation }),
      ...(control === undefined ? {} : { control }),
    },
  };
}

// Every --input plan states whether the capture's measured per-call overhead applies to the configured judge.
export function overheadDisclosure(
  captured: JudgeIdentity | undefined,
  configured: JudgeIdentity | undefined,
  callOverhead: number,
): string {
  const who =
    configured === undefined
      ? "an unresolved provider/model"
      : `${configured.provider}/${configured.model}`;
  return captured !== undefined &&
    configured !== undefined &&
    captured.provider === configured.provider &&
    captured.model === configured.model
    ? `~${String(callOverhead)} overhead tokens/call measured on the capture's own ${who} calls`
    : `overhead unknown: the capture ran ${captured === undefined ? "an unrecorded provider" : `${captured.provider}/${captured.model}`}, not ${who}, so its measured ~${String(callOverhead)} tokens/call is a guess`;
}
