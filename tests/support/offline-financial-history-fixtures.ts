import { isRecord } from "../../src/guards";
import {
  isFactObservableAsOf,
  periodMonths,
  readSecFactValue,
} from "../../src/sources/extended-evidence/sec-edgar";
import {
  mutateOfflineCorpusCase,
  type OfflineCorpusCase,
  type OfflineCorpusExecution,
} from "./offline-financial-statements-corpus";
import {
  buildSyntheticAliasPayloads,
  type SyntheticAliasVariant,
} from "./synthetic-alias-companyfacts";

const DAY_MS = 86_400_000;
const DAYS_PER_YEAR = 365.2425;

export function cloneCompanyFactsWithMutableUsGaap(companyFacts: unknown): {
  readonly payload: unknown;
  readonly usGaap: Record<string, unknown>;
} {
  const payload: unknown = structuredClone(companyFacts);
  if (!isRecord(payload) || !isRecord(payload.facts) || !isRecord(payload.facts["us-gaap"])) {
    throw new Error("MARA fixture is missing us-gaap companyfacts");
  }
  return { payload, usGaap: payload.facts["us-gaap"] };
}

export function eligibleMaraRevenueFacts(
  companyFacts: unknown,
  concept: string,
  analysisAsOf: string,
): readonly { readonly value: number; readonly periodEnd: string; readonly filedAt: string }[] {
  if (
    !isRecord(companyFacts) ||
    !isRecord(companyFacts.facts) ||
    !isRecord(companyFacts.facts["us-gaap"])
  ) {
    throw new Error("MARA fixture is missing us-gaap companyfacts");
  }
  const rawConcept = companyFacts.facts["us-gaap"][concept];
  if (
    !isRecord(rawConcept) ||
    !isRecord(rawConcept.units) ||
    !Array.isArray(rawConcept.units.USD)
  ) {
    throw new Error(`MARA fixture is missing USD ${concept} facts`);
  }
  const candidates = rawConcept.units.USD.flatMap((value) => {
    const fact = readSecFactValue(value);
    const months = fact === undefined ? undefined : periodMonths(fact);
    return fact?.form === "10-K" &&
      fact.end !== undefined &&
      fact.filed !== undefined &&
      months !== undefined &&
      months >= 10 &&
      months <= 14 &&
      isFactObservableAsOf(fact, analysisAsOf)
      ? [{ value: fact.val, periodEnd: fact.end, filedAt: fact.filed }]
      : [];
  });
  const byPeriodEnd = new Map<string, (typeof candidates)[number][]>();
  for (const fact of candidates) {
    byPeriodEnd.set(fact.periodEnd, [...(byPeriodEnd.get(fact.periodEnd) ?? []), fact]);
  }
  return [...byPeriodEnd.values()]
    .map((facts) => facts.toSorted((left, right) => right.filedAt.localeCompare(left.filedAt))[0]!)
    .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
}

export function syntheticAliasExecution(
  maraCase: OfflineCorpusCase,
  variant: SyntheticAliasVariant,
): OfflineCorpusExecution {
  return mutateOfflineCorpusCase(maraCase, {
    input: { symbol: "ALIAS", ...buildSyntheticAliasPayloads(variant) },
  }).execution;
}

export function yearsBetween(periodStart: string, periodEnd: string): number {
  return (Date.parse(periodEnd) - Date.parse(periodStart)) / DAY_MS / DAYS_PER_YEAR;
}
