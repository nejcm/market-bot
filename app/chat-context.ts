import type { RunDetail } from "./types";

const DEFAULT_CONTEXT_BUDGET_CHARS = 96_000; // ~24k tokens at ~4 chars/token

interface ContextSection {
  readonly label: string;
  readonly content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function formatScoreOutcomes(score: Record<string, unknown> | undefined): string | undefined {
  if (score === undefined) {
    return undefined;
  }

  const scores = Array.isArray(score.scores) ? score.scores : [];
  if (scores.length === 0) {
    return undefined;
  }

  const lines: string[] = [];
  for (const entry of scores) {
    if (!isRecord(entry)) {
      continue;
    }

    const id = typeof entry.predictionId === "string" ? entry.predictionId : "?";
    const outcome = typeof entry.outcome === "string" ? entry.outcome : "unknown";
    const resolved = entry.resolved === true ? "resolved" : "pending";

    let detail = `- ${id}: ${outcome} (${resolved})`;
    if (isRecord(entry.evidence)) {
      const {close0} = entry.evidence;
      const {closeN} = entry.evidence;
      if (typeof close0 === "number" && typeof closeN === "number") {
        detail += ` | close ${String(close0)} → ${String(closeN)}`;
      }
    }
    if (typeof entry.observedAt === "string") {
      detail += ` observed ${entry.observedAt}`;
    }

    lines.push(detail);
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatReportFields(report: Record<string, unknown>): string | undefined {
  const parts: string[] = [];

  const predictions = Array.isArray(report.predictions) ? report.predictions : [];
  if (predictions.length > 0) {
    const predLines: string[] = [];
    for (const pred of predictions) {
      if (!isRecord(pred)) {
        continue;
      }
      const claim = typeof pred.claim === "string" ? pred.claim : "";
      const prob = typeof pred.probability === "number" ? ` (p=${String(pred.probability)})` : "";
      const horizon =
        typeof pred.horizonTradingDays === "number"
          ? ` [${String(pred.horizonTradingDays)}td]`
          : "";
      const measurable = typeof pred.measurableAs === "string" ? ` → ${pred.measurableAs}` : "";
      predLines.push(`- ${claim}${prob}${horizon}${measurable}`);
    }
    if (predLines.length > 0) {
      parts.push(`Predictions DSL:\n${predLines.join("\n")}`);
    }
  }

  const sources = Array.isArray(report.sources) ? report.sources : [];
  if (sources.length > 0) {
    const sourceLines: string[] = [];
    for (const source of sources) {
      if (!isRecord(source)) {
        continue;
      }
      const id = typeof source.id === "string" ? source.id : "?";
      const title = typeof source.title === "string" ? source.title : "";
      const kind = typeof source.kind === "string" ? ` [${source.kind}]` : "";
      sourceLines.push(`- ${id}: ${title}${kind}`);
    }
    if (sourceLines.length > 0) {
      parts.push(`Sources:\n${sourceLines.join("\n")}`);
    }
  }

  const dataGaps = stringArray(report.dataGaps);
  if (dataGaps.length > 0) {
    parts.push(`Data gaps:\n${dataGaps.map((gap) => `- ${gap}`).join("\n")}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function formatVerifiedSnapshot(snapshot: RunDetail["verifiedMarketSnapshot"]): string | undefined {
  if (snapshot === undefined) {
    return undefined;
  }

  const lines: string[] = [];
  if (typeof snapshot.symbol === "string") {
    lines.push(`Symbol: ${snapshot.symbol}`);
  }
  if (typeof snapshot.analysisDate === "string") {
    lines.push(`Analysis date: ${snapshot.analysisDate}`);
  }

  const {ohlcv} = snapshot;
  if (isRecord(ohlcv)) {
    const fields = ["open", "high", "low", "close", "volume"] as const;
    const ohlcvParts = fields
      .filter((field) => typeof ohlcv[field] === "number")
      .map((field) => `${field}=${String(ohlcv[field])}`);
    if (ohlcvParts.length > 0) {
      lines.push(`OHLCV: ${ohlcvParts.join(" ")}`);
    }
  }

  const closes = Array.isArray(snapshot.recentCloses) ? snapshot.recentCloses : [];
  if (closes.length > 0) {
    const closeParts: string[] = [];
    for (const entry of closes) {
      if (isRecord(entry) && typeof entry.date === "string" && typeof entry.close === "number") {
        closeParts.push(`${entry.date}: ${String(entry.close)}`);
      }
    }
    if (closeParts.length > 0) {
      lines.push(`Recent closes: ${closeParts.join(", ")}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : undefined;
}

function formatNormalizedSidecars(availableFiles: readonly string[]): string | undefined {
  const relevant = availableFiles.filter(
    (file) =>
      file.startsWith("normalized/") &&
      file !== "normalized/verified-market-snapshot.json" &&
      file.endsWith(".json"),
  );
  if (relevant.length === 0) {
    return undefined;
  }
  return `Available normalized sidecars: ${relevant.join(", ")}`;
}

export function buildRunChatContext(
  detail: RunDetail,
  budgetChars: number = DEFAULT_CONTEXT_BUDGET_CHARS,
): string {
  const sections: ContextSection[] = [];

  // 1. report.md — highest priority (human synthesis)
  if (detail.markdown !== undefined && detail.markdown.trim() !== "") {
    sections.push({ label: "Report (markdown)", content: detail.markdown });
  }

  // 2. score.json forecast outcomes
  const scoreText = formatScoreOutcomes(detail.score);
  if (scoreText !== undefined) {
    sections.push({ label: "Forecast score outcomes", content: scoreText });
  }

  // 3. Structured report.json fields not already in markdown
  if (detail.report !== undefined) {
    const reportFields = formatReportFields(detail.report);
    if (reportFields !== undefined) {
      sections.push({ label: "Structured report data", content: reportFields });
    }
  }

  // 4. Verified market snapshot indicator block
  const snapshotText = formatVerifiedSnapshot(detail.verifiedMarketSnapshot);
  if (snapshotText !== undefined) {
    sections.push({ label: "Verified market snapshot", content: snapshotText });
  }

  // 5. Key normalized sidecars — lowest priority, droppable
  const sidecarText = formatNormalizedSidecars(detail.summary.availableFiles);
  if (sidecarText !== undefined) {
    sections.push({ label: "Normalized sidecars", content: sidecarText });
  }

  // Assemble within budget, dropping lowest-priority sections first
  const result: string[] = [];
  let totalChars = 0;
  let includedCount = 0;

  for (const section of sections) {
    const block = `## ${section.label}\n\n${section.content}`;
    if (totalChars + block.length > budgetChars && includedCount > 0) {
      break;
    }
    result.push(block);
    totalChars += block.length;
    includedCount += 1;
  }

  const omittedCount = sections.length - includedCount;
  if (omittedCount > 0) {
    result.push(`[context truncated: ${String(omittedCount)} section(s) omitted]`);
  }

  return result.join("\n\n");
}
