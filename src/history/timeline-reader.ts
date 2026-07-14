import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AssetClass } from "../domain/types";
import { RUN_ARTIFACT_FILES } from "../run-artifact-layout";
import { scanRunArtifacts } from "../run-artifacts";
import { isRecord } from "../guards";
import {
  buildInstrumentTimelines,
  historyDir,
  instrumentFileName,
  instrumentKey,
  type InstrumentTimeline,
  type LoadedHistoryRun,
  loadRunSidecars,
  readJson,
} from "./artifacts";

export interface InstrumentTimelineReadResult {
  readonly timeline: InstrumentTimeline;
  readonly source: "history" | "live";
  readonly malformedRunCount: number;
}

const TIMELINE_FRESHNESS_FILES = [
  RUN_ARTIFACT_FILES.report,
  RUN_ARTIFACT_FILES.score,
  RUN_ARTIFACT_FILES.missAutopsy,
  RUN_ARTIFACT_FILES.verifiedMarketSnapshot,
] as const;

function emptyInstrumentTimeline(
  assetClass: AssetClass,
  symbol: string,
  generatedAt: string,
): InstrumentTimeline {
  const key = instrumentKey(assetClass, symbol);
  return {
    version: 1,
    generatedAt,
    instrumentKey: key,
    assetClass,
    symbol: symbol.toUpperCase(),
    entries: [],
  };
}

function timelineHasConsoleFields(timeline: InstrumentTimeline): boolean {
  return timeline.entries.every((entry) => "missAutopsies" in entry);
}

async function fileMtimeMs(path: string): Promise<number | undefined> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() ? metadata.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

async function timelineIsFresh(dataDir: string, timelinePath: string): Promise<boolean> {
  const timelineMtime = await fileMtimeMs(timelinePath);
  if (timelineMtime === undefined) {
    return false;
  }

  const entries = await readdir(dataDir, { withFileTypes: true }).catch(() => []);
  const checks = entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) =>
      TIMELINE_FRESHNESS_FILES.map(async (file) => {
        const mtime = await fileMtimeMs(join(dataDir, entry.name, file));
        return mtime === undefined || mtime <= timelineMtime;
      }),
    );
  const results = await Promise.all(checks);
  return results.every(Boolean);
}

async function readFreshTimeline(
  dataDir: string,
  assetClass: AssetClass,
  symbol: string,
): Promise<InstrumentTimeline | undefined> {
  const key = instrumentKey(assetClass, symbol);
  const timelinePath = join(historyDir(dataDir), "instruments", instrumentFileName(key));
  const parsed = await readJson(timelinePath);
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.entries) ||
    !timelineHasConsoleFields(parsed as unknown as InstrumentTimeline)
  ) {
    return undefined;
  }
  return (await timelineIsFresh(dataDir, timelinePath))
    ? (parsed as unknown as InstrumentTimeline)
    : undefined;
}

export async function readInstrumentTimeline(
  dataDir: string,
  assetClass: AssetClass,
  symbol: string,
  now: Date = new Date(),
): Promise<InstrumentTimelineReadResult> {
  const normalizedSymbol = symbol.toUpperCase();
  const fresh = await readFreshTimeline(dataDir, assetClass, normalizedSymbol);
  if (fresh !== undefined) {
    return { timeline: fresh, source: "history", malformedRunCount: 0 };
  }

  const scan = await scanRunArtifacts(dataDir);
  const loaded: readonly LoadedHistoryRun[] = await Promise.all(
    scan.artifacts.map(async (artifact) => {
      const sidecars = await loadRunSidecars(join(dataDir, artifact.runDirName));
      return {
        report: artifact.report,
        scores: artifact.scores,
        missAutopsies: artifact.missAutopsies,
        ...(artifact.verifiedMarketSnapshot !== undefined
          ? { verifiedMarketSnapshot: artifact.verifiedMarketSnapshot }
          : {}),
        ...sidecars,
        snapshots: [
          ...artifact.marketSnapshots.map(
            (snapshot) => snapshot as unknown as Record<string, unknown>,
          ),
          ...sidecars.snapshots,
        ],
      };
    }),
  );
  const generatedAt = now.toISOString();
  const timelines = buildInstrumentTimelines(loaded, generatedAt);
  const key = instrumentKey(assetClass, normalizedSymbol);
  const malformedRunCount = scan.entries.filter(
    (entry) => entry.status.report === "malformed",
  ).length;
  return {
    timeline:
      timelines.find((timeline) => timeline.instrumentKey === key) ??
      emptyInstrumentTimeline(assetClass, normalizedSymbol, generatedAt),
    source: "live",
    malformedRunCount,
  };
}
