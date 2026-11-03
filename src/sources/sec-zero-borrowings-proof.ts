import type { ExtendedEvidenceItem } from "../domain/evidence";
import { isRecord } from "../guards";
import { isDebtPresenceConcept } from "./extended-evidence/financial-statement-definitions";
import { isStandardTaxonomyNamespace, type SummationParent } from "./sec-calculation-linkbase";
import type { XbrlFact, XbrlInstance, XbrlUnit } from "./sec-xbrl-instance";

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

const shares = (unit: XbrlUnit) => "measures" in unit && unit.measures.join(",") === "xbrli:shares";
const pure = (unit: XbrlUnit) => "measures" in unit && unit.measures.join(",") === "xbrli:pure";
const perShare = (unit: XbrlUnit) =>
  "numerator" in unit &&
  unit.numerator.length === 1 &&
  unit.numerator[0]!.startsWith("iso4217:") &&
  unit.denominator.join(",") === "xbrli:shares";
const noCurrency = (unit: XbrlUnit) =>
  ("measures" in unit ? unit.measures : [...unit.numerator, ...unit.denominator]).every(
    (measure) => !measure.startsWith("iso4217:"),
  );
const NUMERIC_NONMONETARY: Readonly<Record<string, (unit: XbrlUnit) => boolean>> = {
  sharesItemType: shares,
  perShareItemType: perShare,
  pureItemType: pure,
  percentItemType: pure,
  ...Object.fromEntries(
    [
      "integerItemType",
      "nonNegativeIntegerItemType",
      "positiveIntegerItemType",
      "decimalItemType",
      "areaItemType",
      "volumeItemType",
      "massItemType",
      "energyItemType",
      "powerItemType",
      "lengthItemType",
    ].map((type) => [type, noCurrency]),
  ),
};
// Non-numeric MetaLinks types, whose facts carry no unit.
const NON_NUMERIC = new Set([
  "stringItemType",
  "normalizedStringItemType",
  "textBlockItemType",
  "dateItemType",
  "gYearItemType",
  "gMonthDayItemType",
  "booleanItemType",
  "durationItemType",
  "domainItemType",
  "enumerationItemType",
  "enumerationSetItemType",
  "yesNoItemType",
  "tradingSymbolItemType",
  "submissionTypeItemType",
  "stateOrProvinceItemType",
  "securityTitleItemType",
  "fiscalPeriodItemType",
  "filerCategoryItemType",
  "fileNumberItemType",
  "employerIdItemType",
  "edgarStateCountryItemType",
  "edgarExchangeCodeItemType",
  "centralIndexKeyItemType",
]);

// A fact is nonmonetary only when its MetaLinks type is a known nonmonetary one and its unit fits that type.
function nonmonetary(xbrltype: string, unit: XbrlUnit | undefined): boolean {
  if (NON_NUMERIC.has(xbrltype)) {
    return unit === undefined;
  }
  const fits = Object.hasOwn(NUMERIC_NONMONETARY, xbrltype)
    ? NUMERIC_NONMONETARY[xbrltype]
    : undefined;
  return fits !== undefined && unit !== undefined && fits(unit);
}

export interface ConceptTag {
  readonly crdr?: "credit" | "debit";
  readonly xbrltype: string;
}

// MetaLinks.json `instance[<primary document>].tag`, keyed `<namespace URI>#<local name>`; undefined when an entry
// Is unreadable or two entries give one concept different balance or type.
export function metaLinksTags(
  payload: unknown,
  primaryDocument: string,
): ReadonlyMap<string, ConceptTag> | undefined {
  const instance = isRecord(payload) && isRecord(payload.instance) ? payload.instance : undefined;
  const entry = instance?.[primaryDocument];
  if (!isRecord(entry) || !isRecord(entry.tag)) {
    return undefined;
  }
  const tags = new Map<string, ConceptTag>();
  for (const tag of Object.values(entry.tag)) {
    if (
      !isRecord(tag) ||
      typeof tag.nsuri !== "string" ||
      typeof tag.localname !== "string" ||
      typeof tag.xbrltype !== "string" ||
      (tag.crdr !== undefined && tag.crdr !== "credit" && tag.crdr !== "debit")
    ) {
      return undefined;
    }
    const key = `${tag.nsuri}#${tag.localname}`;
    const read: ConceptTag = {
      xbrltype: tag.xbrltype,
      ...(tag.crdr === undefined ? {} : { crdr: tag.crdr }),
    };
    const seen = tags.get(key);
    if (seen !== undefined && (seen.crdr !== read.crdr || seen.xbrltype !== read.xbrltype)) {
      return undefined;
    }
    tags.set(key, read);
  }
  return tags;
}

// A filing's calculation placements, read against its extension schema; only that namespace's concepts are placed.
export interface CalculationPlacement {
  readonly extensionNamespace: string;
  readonly parents: ReadonlyMap<string, readonly SummationParent[]>;
}

export type ZeroBorrowingsProof =
  | { readonly proof: string; readonly currency: string }
  | { readonly reject: string };

const isBorrowingConcept = (concept: string) =>
  ZERO_BORROWING_CONCEPTS.has(concept) ||
  NON_DEBT_CREDIT.has(concept) ||
  isDebtPresenceConcept("us-gaap", concept);
const local = (concept: string) => concept.slice(concept.indexOf(":") + 1);
const isUsGaap = (concept: string) => concept.startsWith("us-gaap:");
const US_GAAP_NAMESPACE = /^http:\/\/fasb\.org\/us-gaap\/\d{4}$/u;
const reject = (code: string) => ({ reject: code });
// Lexical xs:decimal; a value is zero when no digit is nonzero, never via binary floating point.
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;
const isZero = (value: string | undefined) => value !== undefined && !/[1-9]/u.test(value);
const expanded = ({ namespace, local: name }: XbrlFact) => `${namespace}#${name}`;
const cikNumber = (identifier: string) =>
  /^\d{1,10}$/u.test(identifier) ? String(Number(identifier)) : undefined;

// Borrowings are 0 at `periodEnd` when the issuer's filing tags a borrowing concept 0 there and every nonzero
// Non-debit monetary fact at that instant, in any dimension, is a listed non-debt concept or an extension placed under one.
export function zeroBorrowingsInstanceProof(
  { contexts, units, facts }: XbrlInstance,
  tags: ReadonlyMap<string, ConceptTag>,
  placement: CalculationPlacement | undefined,
  {
    periodEnd,
    file,
    cik,
  }: { readonly periodEnd: string; readonly file: string; readonly cik: string },
): ZeroBorrowingsProof {
  const foreignEntity = [...contexts.values()].find(
    ({ entity }) =>
      entity.scheme !== "http://www.sec.gov/CIK" || cikNumber(entity.identifier) !== cikNumber(cik),
  );
  if (foreignEntity !== undefined) {
    return reject(`entity-mismatch:${foreignEntity.entity.identifier}`);
  }
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
  const instantFacts = facts.flatMap((fact) => {
    const context = contexts.get(fact.contextRef!)!;
    return context.instant === periodEnd ? [{ ...fact, members: context.members }] : [];
  });
  const untyped = instantFacts.find((fact) => !tags.has(expanded(fact)));
  if (untyped !== undefined) {
    return reject(`metalinks-missing:${untyped.concept}`);
  }
  const tagOf = (fact: XbrlFact) => tags.get(expanded(fact))!;
  const unitOf = ({ unitRef }: XbrlFact) =>
    unitRef === undefined ? undefined : units.get(unitRef);
  const currencyOf = (fact: XbrlFact) => {
    const read = unitOf(fact);
    const [measure, ...more] = read !== undefined && "measures" in read ? read.measures : [];
    return measure?.startsWith("iso4217:") === true && more.length === 0
      ? measure.slice(8)
      : undefined;
  };
  const lexicalZero = (value: string | undefined) => DECIMAL.test(value ?? "") && isZero(value);
  // XBRL 2.1 §5.1.1.2 allows a balance only on monetary items, and a borrowing concept is monetary.
  const contradicted = instantFacts.find((fact) => {
    const { crdr, xbrltype } = tagOf(fact);
    return (
      nonmonetary(xbrltype, unitOf(fact)) &&
      (crdr !== undefined || (isUsGaap(fact.concept) && isBorrowingConcept(local(fact.concept))))
    );
  });
  if (contradicted !== undefined) {
    return reject(`metalinks-contradicts:${contradicted.concept}`);
  }
  const census = instantFacts.filter((fact) => {
    const { crdr, xbrltype } = tagOf(fact);
    return (
      !nonmonetary(xbrltype, unitOf(fact)) &&
      (xbrltype === "monetaryItemType" ||
        currencyOf(fact) !== undefined ||
        (crdr !== "debit" && (fact.nil || !lexicalZero(fact.value))))
    );
  });
  const nilFact = census.find((fact) => fact.nil && tagOf(fact).crdr !== "debit");
  if (nilFact !== undefined) {
    return reject(`nil-fact:${nilFact.concept}`);
  }
  const monetary = census.filter((fact) => !fact.nil);
  const unitless = monetary.find((fact) => currencyOf(fact) === undefined);
  if (unitless !== undefined) {
    return reject(`unit-unreadable:${unitless.concept}`);
  }
  const atInstant = monetary.map((fact) => ({ ...fact, currency: currencyOf(fact)! }));
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
  const malformed = atInstant.find(({ value }) => !DECIMAL.test(value ?? ""));
  if (malformed !== undefined) {
    return reject(`value-unreadable:${malformed.concept}`);
  }
  const tagged = atInstant.filter(
    ({ concept, value }) =>
      isUsGaap(concept) && ZERO_BORROWING_CONCEPTS.has(local(concept)) && isZero(value),
  );
  const anchor = tagged.find(({ members }) => members.every(([axis]) => FACILITY_AXES.has(axis)));
  if (anchor === undefined) {
    const scope = tagged[0]?.members.find(([axis]) => !FACILITY_AXES.has(axis))?.[0];
    return reject(scope === undefined ? UNTAGGED_ZERO : `scoped-zero:${scope}`);
  }
  const listed = (concept: string, issuerWide: boolean) =>
    isUsGaap(concept) &&
    NON_DEBT_CREDIT.has(local(concept)) &&
    (issuerWide || !TOTALS.has(local(concept)));
  const nonDebtParent = (parent: string) => {
    const [namespace = "", name = ""] = parent.split("#");
    return US_GAAP_NAMESPACE.test(namespace) && NON_DEBT_PARENTS.has(name);
  };
  const placed = (fact: XbrlFact) => {
    const parents =
      fact.namespace === placement?.extensionNamespace &&
      !isStandardTaxonomyNamespace(fact.namespace)
        ? (placement.parents.get(expanded(fact)) ?? [])
        : [];
    return (
      parents.length > 0 &&
      parents.every(({ parent, weight }) => weight === "1" && nonDebtParent(parent))
    );
  };
  const unclassified = atInstant.find(
    (fact) =>
      !isZero(fact.value) &&
      tagOf(fact).crdr !== "debit" &&
      !listed(fact.concept, fact.members.length === 0) &&
      !placed(fact),
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
