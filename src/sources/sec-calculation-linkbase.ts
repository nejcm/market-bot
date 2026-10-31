export const DA_CALC_PREFIX = "daCalc|";
export const DA_CALC_READ_KEY = "daCalcRead";

const OPERATING_CASH_FLOW = new Set([
  "NetCashProvidedByUsedInOperatingActivities",
  "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
]);
const DEPRECIATION_OR_AMORTIZATION = /Depreciat|Amortiz/u;
// Standard us-gaap add-backs that amortize debt, investments, contract costs or leases, not PP&E or intangibles.
const NOT_DEPRECIATION_AND_AMORTIZATION =
  /^(?:AmortizationOfFinancingCosts\w*|AmortizationOfDebtDiscountPremium|AccretionAmortizationOfDiscountsAndPremiumsInvestments|CapitalizedContractCostAmortization|OperatingLeaseRightOfUseAssetAmortizationExpense)$/u;

const SUMMATION_ITEM = new Set([
  "http://www.xbrl.org/2003/arcrole/summation-item",
  "https://xbrl.org/2023/arcrole/summation-item",
]);

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s(?:[\\w.-]+:)?${name}="([^"]*)"`, "u").exec(tag)?.[1];
}

function elements(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>`, "gu"))].map(([tag]) => tag);
}

export function xbrlSchemaHref(html: string): string | undefined {
  const tag = elements(html, "schemaRef")[0];
  return tag === undefined ? undefined : attribute(tag, "href");
}

export function calculationLinkbaseHref(schema: string): string | undefined {
  const tag = elements(schema, "linkbaseRef").find((match) =>
    attribute(match, "role")?.endsWith("/calculationLinkbaseRef"),
  );
  return tag === undefined ? undefined : attribute(tag, "href");
}

// `us-gaap_Depreciation` -> `Depreciation`; extension concepts keep their prefix so they never match a us-gaap fact.
function conceptName(href: string): string {
  const id = href.slice(href.indexOf("#") + 1);
  return id.startsWith("us-gaap_") ? id.slice(8) : id;
}

function roleChildren(body: string): Map<string, number> | undefined {
  const locators = new Map(
    elements(body, "loc").flatMap((tag) => {
      const label = attribute(tag, "label");
      const href = attribute(tag, "href");
      return label === undefined || href === undefined ? [] : [[label, conceptName(href)] as const];
    }),
  );
  const children = new Map<string, number>();
  let operatingCashFlow = false;
  for (const tag of elements(body, "calculationArc")) {
    const parent = locators.get(attribute(tag, "from") ?? "");
    const child = locators.get(attribute(tag, "to") ?? "");
    if (
      parent === undefined ||
      child === undefined ||
      !SUMMATION_ITEM.has(attribute(tag, "arcrole") ?? "") ||
      !OPERATING_CASH_FLOW.has(parent)
    ) {
      continue;
    }
    operatingCashFlow = true;
    if (
      DEPRECIATION_OR_AMORTIZATION.test(child) &&
      !NOT_DEPRECIATION_AND_AMORTIZATION.test(child)
    ) {
      children.set(child, Number(attribute(tag, "weight")));
    }
  }
  return operatingCashFlow ? children : undefined;
}

const roleKey = (children: ReadonlyMap<string, number>) =>
  JSON.stringify([...children].toSorted(([a], [b]) => a.localeCompare(b)));

// `daCalc|<concept>`: weight of each D&A-like summation child of operating cash flow; roles that disagree mark `daCalcRead` "conflict".
export function secDepreciationCalcMetrics(xml: string): Record<string, number | string> {
  const roles = [
    ...xml.matchAll(
      /<(?:[\w.-]+:)?calculationLink\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?calculationLink>/gu,
    ),
  ].flatMap(([, body = ""]) => roleChildren(body) ?? []);
  const [first] = roles;
  if (first === undefined) {
    return {};
  }
  if (roles.some((children) => roleKey(children) !== roleKey(first))) {
    return { [DA_CALC_READ_KEY]: "conflict" };
  }
  return {
    ...Object.fromEntries(
      [...first].map(([concept, weight]) => [`${DA_CALC_PREFIX}${concept}`, weight]),
    ),
    [DA_CALC_READ_KEY]: "true",
  };
}
