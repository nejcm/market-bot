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

type Network = Map<string, Map<string, number>>;

// Adds one link's summation arcs to its (role, arcrole) network; false on a re-weighted, prohibited or prioritized arc.
function mergeLink(networks: Map<string, Network>, role: string, body: string): boolean {
  const locators = new Map(
    elements(body, "loc").flatMap((tag) => {
      const label = attribute(tag, "label");
      const href = attribute(tag, "href");
      return label === undefined || href === undefined ? [] : [[label, conceptName(href)] as const];
    }),
  );
  for (const tag of elements(body, "calculationArc")) {
    const parent = locators.get(attribute(tag, "from") ?? "");
    const child = locators.get(attribute(tag, "to") ?? "");
    if (
      parent === undefined ||
      child === undefined ||
      !SUMMATION_ITEM.has(attribute(tag, "arcrole") ?? "")
    ) {
      continue;
    }
    const priority = attribute(tag, "priority");
    if (
      attribute(tag, "use") === "prohibited" ||
      (priority !== undefined && Number(priority) !== 0)
    ) {
      return false;
    }
    const key = `${role}|${attribute(tag, "arcrole")}`;
    const network = networks.get(key) ?? new Map<string, Map<string, number>>();
    networks.set(key, network);
    const weight = Number(attribute(tag, "weight"));
    const children = network.get(parent) ?? new Map<string, number>();
    if (children.has(child) && children.get(child) !== weight) {
      return false;
    }
    network.set(parent, children.set(child, weight));
  }
  return true;
}

// D&A-like descendants of operating cash flow at any depth, weights composed; "conflict" when a node is reached twice.
function roleChildren(network: Network): Map<string, number> | "conflict" | undefined {
  const present = [...OPERATING_CASH_FLOW].filter((concept) => network.has(concept));
  const roots = present.filter(
    (concept) => !present.some((total) => network.get(total)?.has(concept) && total !== concept),
  );
  if (present.length === 0) {
    return undefined;
  }
  if (roots.length === 0) {
    return "conflict";
  }
  const found = new Map<string, number>();
  const visited = new Set<string>();
  const walk = (parent: string, factor: number): boolean =>
    [...(network.get(parent) ?? [])].every(([child, weight]) => {
      if (visited.has(child)) {
        return false;
      }
      visited.add(child);
      if (DEPRECIATION_OR_AMORTIZATION.test(child)) {
        if (!NOT_DEPRECIATION_AND_AMORTIZATION.test(child)) {
          found.set(child, factor * weight);
        }
        return true;
      }
      return walk(child, factor * weight);
    });
  return roots.every((root) => walk(root, 1)) ? found : "conflict";
}

const roleKey = (children: ReadonlyMap<string, number>) =>
  JSON.stringify([...children].toSorted(([a], [b]) => a.localeCompare(b)));

// `daCalc|<concept>`: composed weight of each D&A-like descendant of operating cash flow; roles that disagree mark `daCalcRead` "conflict".
export function secDepreciationCalcMetrics(xml: string): Record<string, number | string> {
  const networks = new Map<string, Network>();
  for (const [, open = "", body = ""] of xml.matchAll(
    /<((?:[\w.-]+:)?calculationLink\b[^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?calculationLink>/gu,
  )) {
    if (!mergeLink(networks, attribute(open, "role") ?? "", body)) {
      return { [DA_CALC_READ_KEY]: "conflict" };
    }
  }
  const roles = [...networks.values()].flatMap((network) => roleChildren(network) ?? []);
  const proofs = roles.filter((children) => children !== "conflict");
  const [first] = proofs;
  if (roles.length === 0) {
    return {};
  }
  if (
    first === undefined ||
    proofs.length !== roles.length ||
    proofs.some((children) => roleKey(children) !== roleKey(first))
  ) {
    return { [DA_CALC_READ_KEY]: "conflict" };
  }
  return {
    ...Object.fromEntries(
      [...first].map(([concept, weight]) => [`${DA_CALC_PREFIX}${concept}`, weight]),
    ),
    [DA_CALC_READ_KEY]: "true",
  };
}
