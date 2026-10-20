import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../src/guards";
import { readLatestSuccessfulInstrumentRuns } from "../src/run-artifact-index";
import { getRunEarningsDates, putRunEarningsDates, withConsoleDb } from "./console-db";
import type { InstrumentStalenessInput } from "./types";

const EARNINGS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function earningsDatesFromReportExtras(extras: unknown): readonly string[] {
  const setup = isRecord(extras) ? extras.earningsSetup : undefined;
  const event = isRecord(setup) ? setup.event : undefined;
  const date = isRecord(event) && typeof event.date === "string" ? event.date : undefined;
  return date !== undefined && EARNINGS_DATE_PATTERN.test(date) ? [date] : [];
}

async function earningsDatesFromRunArtifact(
  dataDir: string,
  runDirName: string,
): Promise<readonly string[]> {
  if (
    runDirName === "" ||
    runDirName === "." ||
    runDirName === ".." ||
    runDirName.includes("/") ||
    runDirName.includes("\\")
  ) {
    return [];
  }
  const path = join(dataDir, runDirName, "report.json");
  if (!existsSync(path)) {
    return [];
  }
  try {
    const report: unknown = JSON.parse(await readFile(path, "utf8"));
    return earningsDatesFromReportExtras(isRecord(report) ? report.extras : undefined);
  } catch {
    return [];
  }
}

async function readRunEarningsDates(
  dataDir: string,
  dbPath: string,
  runId: string,
  runDirName: string,
): Promise<readonly string[]> {
  if (existsSync(dbPath)) {
    const cached = withConsoleDb(dbPath, (db) => getRunEarningsDates(db, runId));
    if (cached !== undefined) {
      return cached;
    }
  }
  const dates = await earningsDatesFromRunArtifact(dataDir, runDirName);
  if (existsSync(dbPath)) {
    // Report.json is immutable after publish, so cached dates never go stale.
    withConsoleDb(dbPath, (db) => putRunEarningsDates(db, runId, dates));
  }
  return dates;
}

export async function readInstrumentStalenessInputs(
  dataDir: string,
  dbPath: string,
  instruments: readonly { readonly assetClass: string; readonly symbol: string }[],
): Promise<readonly InstrumentStalenessInput[] | undefined> {
  const latest = await readLatestSuccessfulInstrumentRuns(dataDir, instruments);
  if (latest === undefined) {
    return undefined;
  }
  return await Promise.all(
    latest.map(async (run): Promise<InstrumentStalenessInput> => {
      if (run === null) {
        return { state: "never-run" };
      }
      const earningsDates = await readRunEarningsDates(dataDir, dbPath, run.runId, run.runDirName);
      return {
        state: "available",
        ...(run.generatedAt !== null ? { latestRunAt: run.generatedAt } : {}),
        earningsDates,
      };
    }),
  );
}
