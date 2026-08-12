import {
  sourceProvider,
  type Source,
  type SourceKind,
  type SourceTextResearchOnlyAudit,
  type SourceTextResearchOnlyItem,
} from "../domain/types";
import { violatesResearchOnly } from "../domain/research-language";

export function auditSourceTextResearchOnly(
  sources: readonly Source[],
): SourceTextResearchOnlyAudit {
  const items: SourceTextResearchOnlyItem[] = [];
  const flaggedByKind: Partial<Record<SourceKind, number>> = {};
  const flaggedByProvider: Record<string, number> = {};
  let flaggedCount = 0;

  for (const source of sources) {
    const provider = sourceProvider(source) ?? "unknown";
    let flagged = false;
    for (const field of ["title", "summary", "snippet"] as const) {
      const text = source[field];
      if (text === undefined) {
        continue;
      }
      const violation = violatesResearchOnly(text);
      if (violation === null) {
        continue;
      }
      flagged = true;
      items.push({
        sourceId: source.id,
        kind: source.kind,
        provider,
        field,
        match: violation.match,
      });
    }
    if (!flagged) {
      continue;
    }
    flaggedCount += 1;
    flaggedByKind[source.kind] = (flaggedByKind[source.kind] ?? 0) + 1;
    flaggedByProvider[provider] = (flaggedByProvider[provider] ?? 0) + 1;
  }

  return {
    summary: {
      scannedCount: sources.length,
      flaggedCount,
      flaggedByKind,
      flaggedByProvider,
    },
    items,
  };
}
