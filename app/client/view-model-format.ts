import type { RunSummary } from "../types";
import { isRecord } from "../../src/guards";

// Formatting and lenient-read primitives shared by more than one view-model
// Module. Kept on their own leaf so the calibration views can label a run
// Without the run-list module depending back on them.

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function runLabel(run: RunSummary): string {
  const subject = run.symbol ?? run.assetClass ?? "unknown";
  return `${run.jobType ?? "run"} / ${subject}`;
}

export function formatDate(value: string | undefined): string {
  if (value === undefined) {
    return "unknown time";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function formatDateMinute(value: string | undefined): string {
  if (value === undefined) {
    return "unknown time";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      });
}
