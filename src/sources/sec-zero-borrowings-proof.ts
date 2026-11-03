import type { ExtendedEvidenceItem } from "../domain/evidence";
import { isRecord } from "../guards";
import type { XbrlFact, XbrlInstance } from "./sec-xbrl-instance";

export const ZERO_BORROWINGS_PROOF_KEY = "zeroBorrowingProof";
export const ZERO_BORROWINGS_CURRENCY_KEY = "zeroBorrowingCurrency";
export const ZERO_BORROWINGS_REJECT_KEY = "zeroBorrowingReject";
export const UNTAGGED_ZERO = "untagged-zero";
export const UNCLASSIFIED_CREDIT = "unclassified-credit";

const ZERO_BORROWING_CONCEPTS = new Set([
  "LineOfCredit",
  "CommercialPaper",
  "ShortTermBorrowings",
  "DebtCurrent",
  "DebtInstrumentCarryingAmount",
  "LongTermLineOfCredit",
  "LineOfCreditFacilityAmountOutstanding",
  "LongTermDebt",
  "LongTermDebtNoncurrent",
  "LongTermDebtCurrent",
  "NotesPayable",
]);
// Axes that name a facility; any other axis (disposal group, legal entity, segment) narrows the zero's scope.
const FACILITY_AXES = new Set([
  "us-gaap:CreditFacilityAxis",
  "us-gaap:DebtInstrumentAxis",
  "us-gaap:LineOfCreditFacilityAxis",
  "us-gaap:ShortTermDebtTypeAxis",
  "us-gaap:LongtermDebtTypeAxis",
]);
// Totals can sum a subsidiary's untagged borrowing, so they pass only issuer-wide and never vouch for a child.
const TOTALS = new Set([
  "Liabilities",
  "LiabilitiesCurrent",
  "LiabilitiesNoncurrent",
  "LiabilitiesAndStockholdersEquity",
]);
// Operating-lease maturities are the only parents an unlisted credit fact may sit under (CLFD's lease extension).
const NON_DEBT_PARENTS = new Set([
  "LesseeOperatingLeaseLiabilityPaymentsDue",
  "OperatingLeaseLiability",
  "OperatingLeaseLiabilityCurrent",
  "OperatingLeaseLiabilityNoncurrent",
]);
// Closed list of us-gaap credit concepts that are never a borrowing balance; it grows only from filed evidence.
const NON_DEBT_CREDIT = new Set([
  ...TOTALS,
  ...NON_DEBT_PARENTS,
  "AccountsPayableCurrent",
  "AccountsPayableNoncurrent",
  "AccruedLiabilitiesCurrent",
  "EmployeeRelatedLiabilitiesCurrent",
  "ContractWithCustomerLiability",
  "ContractWithCustomerLiabilityCurrent",
  "ContractWithCustomerLiabilityNoncurrent",
  "DeferredRevenue",
  "DeferredRevenueCurrent",
  "DeferredRevenueNoncurrent",
  "AccruedIncomeTaxesCurrent",
  "AccruedIncomeTaxesNoncurrent",
  "DeferredIncomeTaxLiabilities",
  "DeferredIncomeTaxLiabilitiesNet",
  "LesseeOperatingLeaseLiabilityPaymentsDueNextTwelveMonths",
  "LesseeOperatingLeaseLiabilityPaymentsRemainderOfFiscalYear",
  "LesseeOperatingLeaseLiabilityPaymentsDueYearTwo",
  "LesseeOperatingLeaseLiabilityPaymentsDueYearThree",
  "LesseeOperatingLeaseLiabilityPaymentsDueYearFour",
  "LesseeOperatingLeaseLiabilityPaymentsDueYearFive",
  "LesseeOperatingLeaseLiabilityPaymentsDueAfterYearFive",
  "LesseeOperatingLeaseLiabilityUndiscountedExcessAmount",
  "StockholdersEquity",
  "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  "MinorityInterest",
  "CommonStockValue",
  "AdditionalPaidInCapital",
  "AdditionalPaidInCapitalCommonStock",
  "RetainedEarningsAccumulatedDeficit",
  "AccumulatedOtherComprehensiveIncomeLossNetOfTax",
  "TreasuryStockValue",
  "AccumulatedDepreciationDepletionAndAmortizationPropertyPlantAndEquipment",
  "FiniteLivedIntangibleAssetsAccumulatedAmortization",
  "AllowanceForDoubtfulAccountsReceivableCurrent",
  "AccountsReceivableAllowanceForCreditLossCurrent",
  "InventoryValuationReserves",
  "AvailableForSaleDebtSecuritiesAccumulatedGrossUnrealizedGainBeforeTax",
  "LineOfCreditFacilityMaximumBorrowingCapacity",
  "LineOfCreditFacilityRemainingBorrowingCapacity",
]);

export interface ConceptTag {
  readonly crdr?: string;
}

// MetaLinks.json `instance[<primary document>].tag`, keyed `<namespace URI>#<local name>`.
export function metaLinksTags(
  payload: unknown,
  primaryDocument: string,
): ReadonlyMap<string, ConceptTag> | undefined {
  const instance = isRecord(payload) && isRecord(payload.instance) ? payload.instance : undefined;
  const entry = instance?.[primaryDocument];
  if (!isRecord(entry) || !isRecord(entry.tag)) {
    return undefined;
  }
  return new Map(
    Object.values(entry.tag).flatMap((tag) =>
      isRecord(tag) && typeof tag.nsuri === "string" && typeof tag.localname === "string"
        ? [
            [
              `${tag.nsuri}#${tag.localname}`,
              typeof tag.crdr === "string" ? { crdr: tag.crdr } : {},
            ] as const,
          ]
        : [],
    ),
  );
}

export type ZeroBorrowingsProof =
  | { readonly proof: string; readonly currency: string }
  | { readonly reject: string };

const local = (concept: string) => concept.slice(concept.indexOf(":") + 1);
const isUsGaap = (concept: string) => concept.startsWith("us-gaap:");
const reject = (code: string) => ({ reject: code });
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;

// Borrowings are 0 at `periodEnd` when the filing tags a borrowing concept 0 there and every nonzero credit (or
// Unclassified) monetary fact at that instant, in any dimension, is a listed non-debt concept or sits under one.
export function zeroBorrowingsInstanceProof(
  { contexts, units, facts }: XbrlInstance,
  tags: ReadonlyMap<string, ConceptTag>,
  calcParents: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  periodEnd: string,
  file: string,
): ZeroBorrowingsProof {
  const unread = facts.find(
    ({ contextRef, unitRef }) =>
      contextRef === undefined ||
      !contexts.has(contextRef) ||
      (unitRef !== undefined && !units.has(unitRef)),
  );
  if (unread !== undefined) {
    return reject(
      unread.contextRef === undefined || !contexts.has(unread.contextRef)
        ? `context-unreadable:${unread.contextRef ?? unread.concept}`
        : `unit-unreadable:${String(unread.unitRef)}`,
    );
  }
  const currencyOf = ({ unitRef }: XbrlFact) => {
    const measures = unitRef === undefined ? undefined : units.get(unitRef);
    return Array.isArray(measures) && measures.length === 1 && measures[0]!.startsWith("iso4217:")
      ? measures[0]!.slice(8)
      : undefined;
  };
  const atInstant = facts.flatMap((fact) => {
    const context = contexts.get(fact.contextRef!)!;
    const currency = currencyOf(fact);
    return context.instant === periodEnd && currency !== undefined
      ? [{ ...fact, currency, members: context.members }]
      : [];
  });
  const faceCurrency = atInstant.find(
    ({ concept, members }) => concept === "us-gaap:Liabilities" && members.length === 0,
  )?.currency;
  if (faceCurrency === undefined) {
    return reject("no-liabilities-fact");
  }
  const foreign = atInstant.find(({ currency }) => currency !== faceCurrency);
  if (foreign !== undefined) {
    return reject(`currency-mismatch:${foreign.concept}:${foreign.currency}`);
  }
  const malformed = atInstant.find(({ nil, value }) => !nil && !DECIMAL.test(value ?? ""));
  if (malformed !== undefined) {
    return reject(`value-unreadable:${malformed.concept}`);
  }
  const tagged = atInstant.filter(
    ({ concept, nil, value }) =>
      isUsGaap(concept) &&
      ZERO_BORROWING_CONCEPTS.has(local(concept)) &&
      !nil &&
      Number(value) === 0,
  );
  const anchor = tagged.find(({ members }) => members.every(([axis]) => FACILITY_AXES.has(axis)));
  if (anchor === undefined) {
    const scope = tagged[0]?.members.find(([axis]) => !FACILITY_AXES.has(axis))?.[0];
    return reject(scope === undefined ? UNTAGGED_ZERO : `scoped-zero:${scope}`);
  }
  const crdr = ({ namespace, local: name }: XbrlFact) => tags.get(`${namespace}#${name}`)?.crdr;
  const nilFact = atInstant.find((fact) => fact.nil && crdr(fact) !== "debit");
  if (nilFact !== undefined) {
    return reject(`nil-fact:${nilFact.concept}`);
  }
  const listed = (concept: string, issuerWide: boolean) =>
    isUsGaap(concept) &&
    NON_DEBT_CREDIT.has(local(concept)) &&
    (issuerWide || !TOTALS.has(local(concept)));
  const placed = (concept: string) => {
    const parents = [...(calcParents?.get(concept) ?? [])];
    return (
      parents.length > 0 &&
      parents.every((parent) => isUsGaap(parent) && NON_DEBT_PARENTS.has(local(parent)))
    );
  };
  const unclassified = atInstant.find(
    (fact) =>
      Number(fact.value) !== 0 &&
      crdr(fact) !== "debit" &&
      !listed(fact.concept, fact.members.length === 0) &&
      !placed(fact.concept),
  );
  if (unclassified !== undefined) {
    return reject(`${UNCLASSIFIED_CREDIT}:${unclassified.concept}`);
  }
  const members = anchor.members.map(([axis, member]) => `${axis}=${member}`).join(", ");
  return {
    proof: `${anchor.concept} = 0 at ${periodEnd}${members === "" ? "" : ` [${members}]`}; fact ${anchor.id ?? "(no id)"}, ${file}`,
    currency: faceCurrency,
  };
}

// MARKET_BOT_TAGGED_ZERO_DEBT_DISABLE: the proof is dropped, so the zero stays withheld.
export function withoutTaggedZero(item: ExtendedEvidenceItem): ExtendedEvidenceItem {
  if (item.metrics?.[ZERO_BORROWINGS_PROOF_KEY] === undefined) {
    return item;
  }
  const {
    [ZERO_BORROWINGS_PROOF_KEY]: _proof,
    [ZERO_BORROWINGS_CURRENCY_KEY]: _currency,
    ...metrics
  } = item.metrics;
  return {
    ...item,
    metrics: { ...metrics, [ZERO_BORROWINGS_REJECT_KEY]: "tagged-zero debt disabled" },
  };
}
