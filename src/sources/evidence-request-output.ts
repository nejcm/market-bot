import type { ExtendedEvidenceItem, Source, SourceGap } from "../domain/types";
import { sourceGap } from "../domain/source-gaps";
import type { ModelInputSanitizationAggregate } from "./model-input-sanitizer";
import type { RawSourceSnapshot } from "./types";

export interface EvidenceRequestToolOutput {
  readonly rawSnapshots: readonly RawSourceSnapshot[];
  readonly sources: readonly Source[];
  readonly items: readonly ExtendedEvidenceItem[];
  readonly gaps: readonly SourceGap[];
  readonly modelInputSanitization?: ModelInputSanitizationAggregate;
}

export function emptyOutput(
  gaps: readonly SourceGap[],
  rawSnapshots: readonly RawSourceSnapshot[] = [],
): EvidenceRequestToolOutput {
  return { rawSnapshots, sources: [], items: [], gaps };
}

export function unsupportedInstrumentGap(
  source: string,
  provider: string,
  symbol: string,
): SourceGap {
  return sourceGap({
    source,
    message: `${provider} does not support ${symbol} (non-US listing)`,
    provider,
    capability: "evidence-request",
    cause: "unsupported-coverage",
    evidenceQualityImpact: "extended-evidence-cap",
  });
}
