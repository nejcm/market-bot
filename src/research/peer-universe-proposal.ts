import { RESEARCH_SUBJECT_SYMBOL_RE, SEC_TICKERS_URL } from "../config/shared";
import type { ModelProvider } from "../model/types";
import { isFetchJsonResult, type SourceRequestExecutor } from "../sources/types";
import { isRecord } from "../sources/guards";
import { isUsListing } from "../sources/instrument-capability";
import { findSecTicker } from "../sources/extended-evidence/sec-edgar";
import { collectListedUniverse, type ListedUniverseEntry } from "../alpha-search/listed-universe";
import {
  MAX_PEERS,
  MIN_PROPOSED_PEERS,
  type PeerUniverse,
  type PeerUniversePeer,
  type PeerUniverseSource,
  type ProposalAudit,
} from "./peer-universe";

const UNSUPPORTED_SECURITY_NAME_RE =
  /\b(ADR|ADS|AMERICAN DEPOSITARY|ETF|ETN|FUND|TRUST|INDEX|UNIT|WARRANT|RIGHT|PREFERRED|PREFERENCE|NOTE|NOTES|DEBENTURE|BOND)\b/iu;

const SEC_TICKERS_SOURCE_ID = "sec-company-tickers";

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

function buildUserPrompt(targetSymbol: string, targetName?: string): string {
  const subject = targetName !== undefined ? `${targetName} (${targetSymbol})` : targetSymbol;
  return (
    `List up to ${String(MAX_PEERS)} US-listed common-stock comparable companies for ${subject}. ` +
    `Return JSON with this exact shape: ` +
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

// Runs the structured-JSON model call; returns the raw content, or an empty string
// When the provider throws (network/timeout). Empty content parses to zero candidates,
// So the caller degrades to the existing too-few-survivors gap without a special case.
async function generatePeerProposal(deps: ProposerDeps, target: string): Promise<string> {
  try {
    const response = await deps.provider.generate({
      model: deps.model,
      responseFormat: "json",
      params: {
        temperature: 0,
        top_p: 1,
        seed: symbolSeed(target),
        reasoningEffort: "low",
        max_completion_tokens: 400,
      },
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(target, deps.targetName) },
      ],
    });
    return response.content;
  } catch {
    return "";
  }
}

// Creates a proposer function that calls the model for peer candidates, then
// Deterministically validates each one (SEC directory + US-listing + ETF exclusion).
// Returns a `PeerUniverse` when at least MIN_PROPOSED_PEERS survivors pass; otherwise
// Undefined. Cache write is the caller's responsibility.
export function createPeerUniverseProposer(
  deps: ProposerDeps,
): (symbol: string) => Promise<{ universe?: PeerUniverse; audit: ProposalAudit }> {
  return async (targetSymbol: string) => {
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
      // SEC directory unavailable — degrade to existing unsupported-coverage gap
      return { audit: emptyAudit("(sec-fetch-failed)") };
    }
    const listedUniverse = await collectListedUniverse(deps.request);
    if (listedUniverse.entries.length === 0) {
      return { audit: emptyAudit("(listing-fetch-failed)") };
    }
    const tickersPayload = tickersResult.payload;

    // Model call: structured JSON, low token budget, temperature:0 for reproducibility
    const modelContent = await generatePeerProposal(deps, target);
    const rawPeers = parseProposedPeers(modelContent);
    const modelId = deps.model;

    // Deterministic per-candidate validation
    let rejectedByDirectory = 0;
    let rejectedByEtf = 0;
    let rejectedByListing = 0;
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
      return { audit };
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
