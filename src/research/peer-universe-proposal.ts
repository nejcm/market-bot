import { RESEARCH_SUBJECT_SYMBOL_RE, SEC_TICKERS_URL } from "../config/shared";
import type { SourceGapCause } from "../domain/types";
import type { ModelProvider } from "../model/types";
import { withUntrustedModelInputRule } from "../model/trust-guard";
import { isFetchJsonResult, type SourceRequestExecutor } from "../sources/types";
import { isRecord } from "../guards";
import { isUsListing } from "../sources/instrument-capability";
import { findSecTicker } from "../sources/extended-evidence/sec-edgar";
import { collectListedUniverse, type ListedUniverseEntry } from "../alpha-search/listed-universe";
import {
  MAX_PEERS,
  MIN_PROPOSED_PEERS,
  type PeerExclusionFeedback,
  type PeerUniverse,
  type PeerUniversePeer,
  type PeerUniverseProposal,
  type PeerUniverseSource,
  type PeerUniverseTargetInputs,
  type ProposalAudit,
} from "./peer-universe";
import {
  SIZE_GATE_MAX_RATIO,
  SIZE_GATE_MIN_RATIO,
} from "../sources/extended-evidence/valuation-comps-contract";

const UNSUPPORTED_SECURITY_NAME_RE =
  /\b(ADR|ADS|AMERICAN DEPOSITARY|ETF|ETN|FUND|TRUST|INDEX|UNIT|WARRANT|RIGHT|PREFERRED|PREFERENCE|NOTE|NOTES|DEBENTURE|BOND)\b/iu;

const SEC_TICKERS_SOURCE_ID = "sec-company-tickers";

// Bump when the proposal prompt changes materially; a refresh spent under an older revision is
// Granted again.
export const PROPOSER_REVISION = 2;

export interface ProposerDeps {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly request: SourceRequestExecutor;
  readonly secUserAgent?: string;
  readonly targetName?: string;
}

const SEED_MODULUS = 2_147_483_647;

// Deterministic non-negative seed derived from a symbol string, so the same
// Ticker produces the same model `seed` (with `temperature:0`) run to run.
function symbolSeed(symbol: string): number {
  let hash = 0;
  for (const char of symbol) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % SEED_MODULUS;
  }
  return hash;
}

function emptyAudit(modelId: string): ProposalAudit {
  return {
    proposed: 0,
    survived: 0,
    rejectedByDirectory: 0,
    rejectedByEtf: 0,
    rejectedByListing: 0,
    modelId,
  };
}

function buildSystemPrompt(): string {
  return (
    "You are a financial analysis assistant. " +
    "Return ONLY valid JSON — no markdown, no commentary. " +
    "Only include US-listed common stocks. " +
    "Exclude ETFs, mutual funds, index funds, ADRs, closed-end funds, trusts, and the target company itself."
  );
}

const COMPACT_USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

function sizeBandClause(label: string, value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return `${label} between ${COMPACT_USD.format(value * SIZE_GATE_MIN_RATIO)} and ${COMPACT_USD.format(value * SIZE_GATE_MAX_RATIO)} (target ${COMPACT_USD.format(value)})`;
}

// Bands are targets, not a filter: the model cannot verify SIC or size, and downstream gates enforce them.
function comparabilityBand(target: PeerUniverseTargetInputs | undefined): string {
  const clauses = [
    target?.sic !== undefined && /^\d{4}$/u.test(target.sic)
      ? `an SEC SIC code in the two-digit group ${target.sic.slice(0, 2)} (target SIC ${target.sic})`
      : undefined,
    sizeBandClause("market capitalization", target?.marketCap),
    sizeBandClause("annualized revenue", target?.annualizedRevenue),
  ].filter((clause): clause is string => clause !== undefined);
  return clauses.length === 0
    ? ""
    : `Target comparability bands: ${clauses.join("; ")}. ` +
        "Downstream code verifies these facts and rejects candidates outside the applicable bands. " +
        "Do not omit a plausible candidate solely because its exact SIC classification or current size is uncertain; " +
        "include plausible near-band candidates after likely in-band candidates. ";
}

// Fixed labels only: exclusion reasons can carry provider text, which must not reach the prompt.
const EXCLUSION_LABELS: Partial<Record<SourceGapCause, string>> = {
  "suppressed-by-design": "outside a comparability gate",
  "provider-data-missing": "required public data unavailable",
};

function exclusionFeedback(exclusions: readonly PeerExclusionFeedback[] | undefined): string {
  const valid = (exclusions ?? []).filter(({ symbol }) => RESEARCH_SUBJECT_SYMBOL_RE.test(symbol));
  if (valid.length === 0) {
    return "";
  }
  const excluded = valid
    .map(({ symbol, cause }) => `${symbol} (${EXCLUSION_LABELS[cause] ?? "excluded"})`)
    .join("; ");
  return (
    `The previous evaluation excluded these candidates downstream: ${excluded}. ` +
    "Do not repeat a candidate unless its exclusion reason is likely to no longer apply. "
  );
}

function buildUserPrompt(
  targetSymbol: string,
  targetName?: string,
  target?: PeerUniverseTargetInputs,
  exclusions?: readonly PeerExclusionFeedback[],
): string {
  const subject = targetName !== undefined ? `${targetName} (${targetSymbol})` : targetSymbol;
  return (
    `Propose ${String(MAX_PEERS)} distinct US-listed common-stock candidates for ${subject}, ` +
    "ranked from strongest to weakest business and likely sector/size fit. " +
    `Aim for at least ${String(MIN_PROPOSED_PEERS)} plausible candidates. ${comparabilityBand(target)}${exclusionFeedback(exclusions)}` +
    "Do not invent companies to reach the requested count. Give each a brief business-fit rationale. " +
    "Return JSON with this exact shape: " +
    `{"peers":[{"symbol":"string","name":"string","role":"core"|"secondary","rationale":"string"}]}`
  );
}

interface RawProposedPeer {
  readonly symbol: string;
  readonly name: string;
  readonly role: "core" | "secondary";
  readonly rationale: string;
}

function parseProposedPeers(content: string): readonly RawProposedPeer[] {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.peers)) {
      return [];
    }
    return parsed.peers.filter((item): item is RawProposedPeer => {
      if (!isRecord(item)) {
        return false;
      }
      if (typeof item.symbol !== "string" || item.symbol.trim() === "") {
        return false;
      }
      if (typeof item.name !== "string" || item.name.trim() === "") {
        return false;
      }
      if (item.role !== "core" && item.role !== "secondary") {
        return false;
      }
      if (typeof item.rationale !== "string" || item.rationale.trim() === "") {
        return false;
      }
      return true;
    });
  } catch {
    return [];
  }
}

function isEligibleListedCommonStock(
  symbol: string,
  listedEntries: readonly ListedUniverseEntry[],
): boolean {
  return listedEntries.some(
    (entry) =>
      entry.symbol === symbol &&
      entry.isActive &&
      entry.isTestIssue !== true &&
      entry.isEtfOrFund !== true &&
      entry.isSupportedStock === true &&
      !UNSUPPORTED_SECURITY_NAME_RE.test(entry.name ?? ""),
  );
}

// A row without a stock classification (Cboe) cannot rule a candidate out; only classified rows can.
function hasAffirmativeListing(
  symbol: string,
  listedEntries: readonly ListedUniverseEntry[],
): boolean {
  return listedEntries.some(
    (entry) => entry.symbol === symbol && entry.isSupportedStock !== undefined,
  );
}

// Runs the structured-JSON model call; null when the provider throws (network/timeout).
async function generatePeerProposal(
  deps: ProposerDeps,
  target: string,
  targetInputs: PeerUniverseTargetInputs | undefined,
  exclusions: readonly PeerExclusionFeedback[] | undefined,
): Promise<string | null> {
  try {
    const response = await deps.provider.generate({
      model: deps.model,
      responseFormat: "json",
      params: {
        temperature: 0,
        top_p: 1,
        seed: symbolSeed(target),
        reasoningEffort: "medium",
        // Eight peer objects need ~600 tokens, and OpenAI reasoning tokens count against this cap.
        max_completion_tokens: 2000,
      },
      messages: [
        { role: "system", content: withUntrustedModelInputRule(buildSystemPrompt()) },
        {
          role: "user",
          content: buildUserPrompt(target, deps.targetName, targetInputs, exclusions),
        },
      ],
    });
    return response.content;
  } catch {
    return null;
  }
}

// Creates a proposer function that calls the model for peer candidates, then
// Deterministically validates each one (SEC directory + US-listing + ETF exclusion).
// Returns a `PeerUniverse` when at least MIN_PROPOSED_PEERS survivors pass; otherwise
// Undefined. Cache write is the caller's responsibility.
export function createPeerUniverseProposer(
  deps: ProposerDeps,
): (
  symbol: string,
  targetInputs?: PeerUniverseTargetInputs,
  exclusions?: readonly PeerExclusionFeedback[],
) => Promise<PeerUniverseProposal> {
  return async (targetSymbol, targetInputs, exclusions) => {
    const target = targetSymbol.trim().toUpperCase();

    // Fetch SEC company_tickers.json — reused (cached) from the peer fetch pipeline
    const secInit: RequestInit | undefined =
      deps.secUserAgent !== undefined
        ? { headers: { accept: "application/json", "user-agent": deps.secUserAgent } }
        : undefined;
    const tickersResult = await deps.request.json({
      url: SEC_TICKERS_URL,
      adapter: "sec-tickers",
      ...(secInit !== undefined ? { init: secInit } : {}),
    });
    if (!isFetchJsonResult(tickersResult)) {
      return { audit: emptyAudit("(sec-fetch-failed)"), unavailable: true };
    }
    const listedUniverse = await collectListedUniverse(deps.request);
    if (listedUniverse.entries.length === 0) {
      return { audit: emptyAudit("(listing-fetch-failed)"), unavailable: true };
    }
    const tickersPayload = tickersResult.payload;

    // Model call: structured JSON, temperature:0 for reproducibility
    const modelContent = await generatePeerProposal(deps, target, targetInputs, exclusions);
    if (modelContent === null) {
      return { audit: emptyAudit(deps.model), unavailable: true };
    }
    const rawPeers = parseProposedPeers(modelContent);
    const modelId = deps.model;

    // Deterministic per-candidate validation
    let rejectedByDirectory = 0;
    let rejectedByEtf = 0;
    let rejectedByListing = 0;
    let unresolvedListings = 0;
    const seen = new Set<string>();
    const survivors: { peer: RawProposedPeer; secName: string }[] = [];

    for (const raw of rawPeers) {
      const symbol = raw.symbol.trim().toUpperCase();

      // Symbol shape
      if (!RESEARCH_SUBJECT_SYMBOL_RE.test(symbol)) {
        continue;
      }
      // Skip target and duplicates
      if (symbol === target || seen.has(symbol)) {
        continue;
      }
      seen.add(symbol);

      // Unsupported security-type exclusion on proposed name
      if (UNSUPPORTED_SECURITY_NAME_RE.test(raw.name)) {
        rejectedByEtf++;
        continue;
      }

      // SEC directory check — anti-hallucination + guarantees CIK for downstream fetch
      const secMatch = findSecTicker(tickersPayload, symbol);
      if (secMatch === undefined) {
        rejectedByDirectory++;
        continue;
      }

      if (!isEligibleListedCommonStock(symbol, listedUniverse.entries)) {
        rejectedByListing++;
        if (!hasAffirmativeListing(symbol, listedUniverse.entries)) {
          unresolvedListings++;
        }
        continue;
      }

      // Unsupported security-type exclusion on SEC title (secondary guard)
      const secTitle = secMatch.name ?? raw.name;
      if (UNSUPPORTED_SECURITY_NAME_RE.test(secTitle)) {
        rejectedByEtf++;
        continue;
      }

      // US-listing check (symbol-suffix based; identity not available at proposal time)
      if (!isUsListing(symbol)) {
        rejectedByListing++;
        continue;
      }

      survivors.push({ peer: raw, secName: secTitle });
      if (survivors.length >= MAX_PEERS) {
        break;
      }
    }

    const audit: ProposalAudit = {
      proposed: rawPeers.length,
      survived: survivors.length,
      rejectedByDirectory,
      rejectedByEtf,
      rejectedByListing,
      modelId,
    };

    if (survivors.length < MIN_PROPOSED_PEERS) {
      // A failed directory may hold the candidates it left unresolved, so this shortfall is an outage.
      return listedUniverse.sourceGaps.length > 0 && unresolvedListings > 0
        ? { audit, unavailable: true }
        : { audit };
    }

    const peerSource: PeerUniverseSource = {
      sourceId: SEC_TICKERS_SOURCE_ID,
      title: "SEC company_tickers.json directory",
      url: SEC_TICKERS_URL,
    };

    const peers: readonly PeerUniversePeer[] = survivors.map(({ peer, secName }) => ({
      symbol: peer.symbol.trim().toUpperCase(),
      name: secName,
      role: peer.role,
      rationale: peer.rationale.trim(),
      sourceIds: [SEC_TICKERS_SOURCE_ID],
    }));

    const universe: PeerUniverse = {
      targetSymbol: target,
      provenance: "model-proposed-validated",
      peers,
      sources: [peerSource],
    };

    return { universe, audit };
  };
}
