import type { CollectContext } from "../types";
import {
  collectSecPeriodicFilingItems,
  type EvidenceRequestToolOutput,
} from "../evidence-request-tools";
import { deriveFinancialStatements } from "./financial-statements";
import type { FinancialStatementsArtifact } from "./financial-statements-contract";
import { fetchSecCompanyFactsForSymbol } from "./sec-edgar";

interface CollectedFinancialStatements {
  readonly statements: FinancialStatementsArtifact | undefined;
  readonly periodicFilings?: EvidenceRequestToolOutput;
}

export async function collectFinancialStatements(
  context: CollectContext,
  symbol: string,
): Promise<CollectedFinancialStatements> {
  const facts = await fetchSecCompanyFactsForSymbol(context, symbol);
  if (facts.factsPayload === undefined || facts.sourceId === undefined) {
    return { statements: undefined };
  }
  const periodicFilings =
    context.secUserAgent === undefined
      ? undefined
      : await collectSecPeriodicFilingItems(context, facts);
  const statements = deriveFinancialStatements(facts.factsPayload, {
    symbol,
    generatedAt: context.fetchedAt,
    analysisAsOf: context.fetchedAt,
    sourceId: facts.sourceId,
    ...(facts.sourceUrl !== undefined ? { sourceUrl: facts.sourceUrl } : {}),
    ...(facts.submissionsPayload !== undefined
      ? { submissionsPayload: facts.submissionsPayload }
      : {}),
    ...(facts.submissionsSourceId !== undefined
      ? { submissionsSourceId: facts.submissionsSourceId }
      : {}),
    ...(periodicFilings !== undefined ? { secFilings: periodicFilings.items } : {}),
  });
  return {
    statements,
    ...(periodicFilings !== undefined ? { periodicFilings } : {}),
  };
}
