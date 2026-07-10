import type {
  EvidenceQualityAssessment,
  EvidenceQualityCheck,
  ReportIntegrity,
} from "../domain/types";
import { EVIDENCE_LANES, LEGACY_EVIDENCE_LANES, type EvidenceLane } from "./source-plan";

type FailedCheckKind = "coverage" | "freshness" | "corroboration";

export interface QualityDriverIntegrityResult {
  readonly reportIntegrity: ReportIntegrity;
  readonly researchQuality: ReportIntegrity;
  readonly pruned: readonly { readonly location: string }[];
}

const FAILED_CHECK_ORDER: readonly FailedCheckKind[] = ["coverage", "freshness", "corroboration"];

const LANE_LABELS: Readonly<Record<EvidenceLane, string>> = {
  "market-data": "market data",
  "supplemental-market": "supplemental market",
  news: "news",
  "market-context": "market context",
  "verified-price-history": "verified price history",
  "regulatory-filings": "regulatory filing",
  "corporate-events": "corporate event",
  "macro-indicators": "macro indicator",
  "derivatives-volatility": "derivatives volatility",
  "on-chain": "on-chain",
  "target-valuation": "target valuation",
  "peer-valuation": "peer valuation",
  "subject-profile": "subject profile",
  "macro-context": "macro context",
  "verified-snapshot": "verified snapshot",
  "sec-edgar": "SEC filing",
  "equity-events": "equity event",
  "extended-fred-macro": "FRED macro",
  "options-iv": "options IV",
  valuation: "valuation",
};

const REMEDIATION_BY_FAILURE: Readonly<Record<string, string>> = {
  "market-data:coverage": "rerun after primary market data is available",
  "market-data:freshness": "rerun with fresh primary market data",
  "supplemental-market:coverage": "configure MARKET_BOT_MASSIVE_API_KEY or rerun",
  "supplemental-market:freshness": "rerun with fresh supplemental market data",
  "news:coverage": "configure news providers or rerun with fresh news coverage",
  "news:freshness": "rerun with fresher news coverage",
  "news:corroboration": "add a second current news source or rerun",
  "market-context:coverage": "configure MARKET_BOT_FRED_API_KEY or rerun",
  "market-context:freshness": "rerun with fresh market context",
  "verified-price-history:coverage": "rerun after verified price history is available",
  "verified-price-history:freshness": "rerun with fresh verified price history",
  "regulatory-filings:coverage": "configure SEC access or rerun after filings are available",
  "regulatory-filings:freshness": "rerun with current regulatory filings",
  "corporate-events:coverage": "configure MARKET_BOT_FINNHUB_API_TOKEN or rerun",
  "corporate-events:freshness": "rerun with fresh corporate event data",
  "macro-indicators:coverage": "configure MARKET_BOT_FRED_API_KEY or rerun",
  "macro-indicators:freshness": "rerun with fresh macro indicators",
  "derivatives-volatility:coverage": "configure MARKET_BOT_TRADIER_API_TOKEN or rerun",
  "derivatives-volatility:freshness": "rerun with fresh derivatives volatility data",
  "on-chain:coverage": "configure MARKET_BOT_GLASSNODE_API_KEY or rerun",
  "on-chain:freshness": "rerun with fresh on-chain data",
  "target-valuation:coverage": "improve normalized valuation inputs or rerun",
  "target-valuation:freshness": "rerun with fresh target valuation inputs",
  "peer-valuation:coverage": "expand peer coverage or rerun",
  "peer-valuation:freshness": "rerun with fresh peer valuation inputs",
  "subject-profile:coverage": "configure MARKET_BOT_EXA_API_KEY or rerun --deep",
  "subject-profile:freshness": "rerun with a fresh subject profile",
  "macro-context:coverage": "configure macro context coverage or rerun",
  "macro-context:freshness": "rerun with fresh macro context",
  "verified-snapshot:coverage": "rerun after verified snapshot data is available",
  "verified-snapshot:freshness": "rerun with a fresh verified snapshot",
  "sec-edgar:coverage": "configure SEC access or rerun after filings are available",
  "sec-edgar:freshness": "rerun with current SEC filing data",
  "equity-events:coverage": "configure MARKET_BOT_FINNHUB_API_TOKEN or rerun",
  "equity-events:freshness": "rerun with fresh equity event data",
  "extended-fred-macro:coverage": "configure MARKET_BOT_FRED_API_KEY or rerun",
  "extended-fred-macro:freshness": "rerun with fresh FRED macro data",
  "options-iv:coverage": "configure MARKET_BOT_TRADIER_API_TOKEN or rerun",
  "options-iv:freshness": "rerun with fresh options IV data",
  "valuation:coverage": "improve normalized valuation inputs or rerun",
  "valuation:freshness": "rerun with fresh valuation inputs",
};

function isEvidenceLane(value: string): value is EvidenceLane {
  return ([...EVIDENCE_LANES, ...LEGACY_EVIDENCE_LANES] as readonly string[]).includes(value);
}

function laneLabel(capability: string): string {
  return isEvidenceLane(capability) ? LANE_LABELS[capability] : capability;
}

function remediationFor(capability: string, kind: FailedCheckKind): string {
  return (
    REMEDIATION_BY_FAILURE[`${capability}:${kind}`] ??
    "improve source coverage for the listed lanes"
  );
}

function failedKinds(check: EvidenceQualityCheck): readonly FailedCheckKind[] {
  return FAILED_CHECK_ORDER.filter((kind) => check[kind] === "fail");
}

function evidenceDriverParts(assessment: EvidenceQualityAssessment): {
  readonly drivers: readonly string[];
  readonly remediations: readonly string[];
} {
  const failedChecks = [
    ...assessment.checks.filter((check) => check.evidenceClass === "core" && !check.passed),
    ...assessment.checks.filter((check) => check.evidenceClass === "material" && !check.passed),
  ].slice(0, 2);
  const failures = failedChecks.flatMap((check) =>
    failedKinds(check).map((kind) => ({ capability: check.capability, kind })),
  );
  return {
    drivers: failures.map(({ capability, kind }) => {
      const label = laneLabel(capability);
      if (kind === "coverage") {
        return `${label} evidence missing`;
      }
      if (kind === "freshness") {
        return `${label} evidence stale`;
      }
      return `${label} lacks corroboration`;
    }),
    remediations: failures.map(({ capability, kind }) => remediationFor(capability, kind)),
  };
}

function sectionName(location: string): string {
  const section = location.split("[", 1)[0] ?? location;
  if (section === "keyFindings") {
    return "key findings";
  }
  if (section === "bullCase") {
    return "bull case";
  }
  if (section === "bearCase") {
    return "bear case";
  }
  return section;
}

function integrityDriverParts(integrity: QualityDriverIntegrityResult): {
  readonly drivers: readonly string[];
  readonly remediations: readonly string[];
} {
  const sections = [...new Set(integrity.pruned.map((item) => sectionName(item.location)))];
  const target = sections.join(", ");
  return {
    drivers: [`report integrity pruning removed unsupported content from ${target}`],
    remediations: ["improve source coverage for the pruned sections"],
  };
}

function dedupe(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

export function deriveResearchQualityDriver(
  assessment: EvidenceQualityAssessment | undefined,
  integrity: QualityDriverIntegrityResult,
): string | undefined {
  if (integrity.researchQuality === "high") {
    return undefined;
  }
  // Callers pass the same evidence assessment used to derive `researchQuality`;
  // If that invariant is broken, do not fabricate an evidence-bound driver.
  const evidenceBinds = assessment !== undefined && assessment.label === integrity.researchQuality;
  const integrityBinds = integrity.reportIntegrity === integrity.researchQuality;
  const evidence =
    evidenceBinds && assessment !== undefined
      ? evidenceDriverParts(assessment)
      : {
          drivers: [],
          remediations: [],
        };
  const reportIntegrity = integrityBinds
    ? integrityDriverParts(integrity)
    : { drivers: [], remediations: [] };
  const drivers = [...evidence.drivers, ...reportIntegrity.drivers];
  if (drivers.length === 0) {
    return undefined;
  }
  const remediations = dedupe([...evidence.remediations, ...reportIntegrity.remediations]);
  return `${drivers.join("; ")}; remediation: ${remediations.join("; ")}`;
}
