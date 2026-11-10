import { FINANCIAL_STATEMENT_SERIES_DEFINITIONS } from "./financial-statement-definitions";
import {
  financialStatementFacts,
  earlierShareBasisPeriods,
  touchesEarlierShareBasis,
} from "./financial-statement-selection";
import {
  type FinancialStatementFact,
  type FinancialStatementNote,
  type FinancialStatementSeries,
  type FinancialStatementSeriesKey,
  type OriginalFiling,
} from "./financial-statements-contract";

const SPLIT_EVIDENCE_SERIES: ReadonlySet<FinancialStatementSeriesKey> = new Set([
  "dilutedEps",
  "continuingDilutedEps",
  "dilutedShares",
]);

// Dividend corrections do not corroborate or veto a split; its periods only receive the notes.
const SHARE_BASIS_SERIES: ReadonlySet<FinancialStatementSeriesKey> = new Set([
  ...SPLIT_EVIDENCE_SERIES,
  "dividendsPerShare",
]);

// Thousand-fold restatements are unit-scale corrections, not share-basis changes.
const MAX_SHARE_FACTOR = 1000;

interface ShareBasisRestatement {
  readonly key: FinancialStatementSeriesKey;
  readonly fact: FinancialStatementFact & { readonly restatedFrom: OriginalFiling };
}

interface ShareBasisChange {
  readonly at: string;
  readonly factor: number;
  readonly restatements: readonly ShareBasisRestatement[];
}

// Share-count multiplier the restatement implies: 5 for 5-for-1, -5 for 1-for-5.
function impliedShareFactor({ fact }: ShareBasisRestatement): number {
  const multiplier =
    fact.unit === "shares"
      ? fact.value / fact.restatedFrom.value
      : fact.restatedFrom.value / fact.value;
  return multiplier >= 1 ? Math.round(multiplier) : -Math.round(1 / multiplier);
}

// Tolerance covers cent rounding of both per-share values and 2% filing noise.
function matchesShareFactor(restatement: ShareBasisRestatement, factor: number): boolean {
  const values = [Math.abs(restatement.fact.value), Math.abs(restatement.fact.restatedFrom.value)];
  const [small, big] = [Math.min(...values), Math.max(...values)];
  const size = Math.abs(factor);
  return (
    (size === 1 || factor > 0 === impliedShareFactor(restatement) > 0) &&
    Math.abs(big - size * small) <= Math.max(0.02 * big, 0.005 * (size + 1))
  );
}

// Share counts must corroborate: an integer per-share restatement alone also fits an earnings correction.
// Ponytail: issuers without a restated diluted-share tag (Alphabet) get no gap; read split 8-Ks if one matters.
function shareBasisChanges(
  series: readonly FinancialStatementSeries[],
): readonly ShareBasisChange[] {
  const byDate = new Map<string, ShareBasisRestatement[]>();
  for (const item of series.filter((candidate) => SPLIT_EVIDENCE_SERIES.has(candidate.key))) {
    for (const fact of financialStatementFacts(item)) {
      const original = fact.restatedFrom;
      if (original !== undefined && fact.value * original.value > 0) {
        byDate.set(fact.firstPublicAt, [
          ...(byDate.get(fact.firstPublicAt) ?? []),
          { key: item.key, fact: { ...fact, restatedFrom: original } },
        ]);
      }
    }
  }
  const events = [...byDate].flatMap(([at, restated]): ShareBasisChange[] => {
    const changed = restated.filter((restatement) => !matchesShareFactor(restatement, 1));
    const factor = changed
      .filter((restatement) => restatement.key === "dilutedShares")
      .map((restatement) => impliedShareFactor(restatement))
      .find(
        (candidate) =>
          Math.abs(candidate) >= 2 &&
          Math.abs(candidate) < MAX_SHARE_FACTOR &&
          changed.every((restatement) => matchesShareFactor(restatement, candidate)),
      );
    return factor === undefined || changed.length < 2
      ? []
      : [{ at, factor, restatements: changed }];
  });
  return events.toSorted((left, right) => left.at.localeCompare(right.at));
}

// A period's own share count places it on the old or new basis; without one the basis is unconfirmed.
function onEarlierShareBasis(
  periodShares: number | undefined,
  periodEnd: string,
  change: ShareBasisChange,
): boolean {
  const reference = change.restatements
    .filter((restatement) => restatement.key === "dilutedShares")
    .toSorted(
      (left, right) =>
        Math.abs(Date.parse(left.fact.periodEnd) - Date.parse(periodEnd)) -
        Math.abs(Date.parse(right.fact.periodEnd) - Date.parse(periodEnd)),
    )[0]!.fact.value;
  const multiplier = change.factor > 0 ? change.factor : -1 / change.factor;
  return (
    periodShares === undefined ||
    Math.abs(Math.log((periodShares * multiplier) / reference)) <
      Math.abs(Math.log(periodShares / reference))
  );
}

function lowerFirst(label: string): string {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

function shareFactorLabel(key: FinancialStatementSeriesKey, factor: number): string {
  const size = String(Math.abs(factor));
  return factor > 0 === (key === "dilutedShares") ? `${size}x` : `1/${size}`;
}

// Never-refiled periods stay on their filed basis; they are declared, not rescaled.
export function mixedShareBasisNotes(
  uncapped: readonly FinancialStatementSeries[],
  retained: readonly FinancialStatementSeries[],
): readonly FinancialStatementNote[] {
  const changes = shareBasisChanges(uncapped);
  const change = changes.at(-1);
  if (change === undefined) {
    return [];
  }
  const sameFactor = changes.filter((candidate) => candidate.factor === change.factor);
  const citedRestatements = sameFactor.flatMap((candidate) => candidate.restatements);
  const shares = uncapped.find((item) => item.key === "dilutedShares");
  const sharesByPeriod = new Map(
    (shares === undefined ? [] : financialStatementFacts(shares)).map((fact) => [
      fact.periodKey,
      fact,
    ]),
  );
  // The share count in effect when the fact was filed: a later restatement does not re-base it.
  const sharesWhenFiled = (fact: FinancialStatementFact) => {
    const periodShares = sharesByPeriod.get(fact.periodKey);
    return periodShares !== undefined && periodShares.firstPublicAt > fact.filedAt
      ? periodShares.restatedFrom?.value
      : periodShares?.value;
  };
  return retained
    .filter((item) => SHARE_BASIS_SERIES.has(item.key))
    .flatMap((item): FinancialStatementNote[] => {
      const earlier = financialStatementFacts(item)
        .filter(
          (fact) =>
            fact.filedAt < change.at &&
            onEarlierShareBasis(sharesWhenFiled(fact), fact.periodEnd, change),
        )
        .toSorted((left, right) => left.periodEnd.localeCompare(right.periodEnd));
      if (earlier.length === 0) {
        return [];
      }
      const citedKey = citedRestatements.some((restatement) => restatement.key === item.key)
        ? item.key
        : "dilutedShares";
      const cited = citedRestatements
        .filter((restatement) => restatement.key === citedKey)
        .map((restatement) => restatement.fact.periodEnd)
        .toSorted();
      const citedLabel = FINANCIAL_STATEMENT_SERIES_DEFINITIONS.find(
        (definition) => definition.key === citedKey,
      )!.label;
      return [
        {
          code: "mixed-share-basis",
          seriesKey: item.key,
          message: `SEC ${lowerFirst(item.label)} periods ending ${earlier[0]!.periodEnd} to ${earlier.at(-1)!.periodEnd} (${String(earlier.length)} retained) were last filed before ${change.at}, the latest filing to restate share-based history; filings restate ${lowerFirst(citedLabel)} for periods ending ${cited[0]!} to ${cited.at(-1)!} by ~${shareFactorLabel(citedKey, change.factor)}, so those periods are on an earlier or unconfirmed share basis and are not adjusted`,
        },
        ...earlier.map(
          (fact): FinancialStatementNote => ({
            code: "earlier-share-basis",
            seriesKey: item.key,
            periodKey: fact.periodKey,
            message: `${item.label} ${fact.periodKey} is on an earlier or unconfirmed share basis`,
          }),
        ),
      ];
    });
}

export function withoutMixedShareBasisTtm(
  series: FinancialStatementSeries,
  notes: readonly FinancialStatementNote[],
): { readonly series: FinancialStatementSeries; readonly note?: FinancialStatementNote } {
  const { ttm, ...rest } = series;
  return ttm === undefined ||
    !touchesEarlierShareBasis(
      Object.values(ttm.components),
      earlierShareBasisPeriods(notes, series.key),
    )
    ? { series }
    : {
        series: rest,
        note: {
          code: "unreconciled-ttm",
          seriesKey: series.key,
          message:
            "FY/latest-YTD/prior-YTD facts include a period on an earlier or unconfirmed share basis",
        },
      };
}
