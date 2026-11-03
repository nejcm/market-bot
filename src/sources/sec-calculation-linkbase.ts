import {
  XLINK,
  attributeOf,
  mayHoldCalculations,
  parseXml,
  type XmlElement,
} from "./sec-xbrl-instance";

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
  const match = new RegExp(`\\s(?:[\\w.-]+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "u").exec(
    tag,
  );
  return match?.[1] ?? match?.[2];
}

function elements(xml: string, name: string): string[] {
  return [
    ...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "gu")),
  ].map(([tag]) => tag);
}

// Inline XBRL is HTML, not XML, so its schemaRef is read lexically with either quote.
export function xbrlSchemaHref(html: string): string | undefined {
  const tag = elements(html, "schemaRef")[0];
  return tag === undefined ? undefined : attribute(tag, "href");
}

export interface SchemaCalculation {
  readonly hrefs: readonly string[];
  // The schema carries its own calculationLink.
  readonly embedded: boolean;
}

// No hrefs and not embedded, so the schema itself is read as the linkbase, when it is not well-formed XML.
export function schemaCalculation(schema: string): SchemaCalculation {
  let root: XmlElement;
  try {
    root = parseXml(schema);
  } catch {
    return { hrefs: [], embedded: false };
  }
  return {
    hrefs: descendants(root, LINKBASE, "linkbaseRef")
      .filter(mayHoldCalculations)
      .map((element) => attributeOf(element, XLINK, "href") ?? ""),
    embedded: descendants(root, LINKBASE, "calculationLink").length > 0,
  };
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
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean =>
    [...(network.get(from)?.keys() ?? [])].some(
      (child) => child === to || (!seen.has(child) && seen.add(child) && reaches(child, to, seen)),
    );
  const roots = present.filter(
    (concept) => !present.some((total) => total !== concept && reaches(total, concept)),
  );
  if (present.length === 0) {
    return undefined;
  }
  // Disconnected OCF totals in one role are separate calculations, never one proof.
  if (roots.length !== 1) {
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

const LINKBASE = "http://www.xbrl.org/2003/linkbase";
const XSD = "http://www.w3.org/2001/XMLSchema";
const descendants = (
  element: XmlElement,
  namespace: string,
  local: string,
): readonly XmlElement[] =>
  element.children.flatMap((child) => [
    ...(child.namespace === namespace && child.local === local ? [child] : []),
    ...descendants(child, namespace, local),
  ]);

export interface ExtensionSchema {
  // The schema's absolute URL, against which the filing's locators resolve.
  readonly url: string;
  readonly namespace: string;
  readonly localById: ReadonlyMap<string, string>;
}

const STANDARD_TAXONOMY_HOST = /^(?:[\w-]+\.)*(?:fasb\.org|xbrl\.org|sec\.gov|ifrs\.org|w3\.org)$/u;

// A namespace a standard-setter or the SEC publishes; an issuer extension never claims one.
export function isStandardTaxonomyNamespace(namespace: string): boolean {
  try {
    return STANDARD_TAXONOMY_HOST.test(new URL(namespace).hostname);
  } catch {
    return false;
  }
}

const allIds = (element: XmlElement): readonly string[] => {
  const id = attributeOf(element, "", "id");
  return [...(id === undefined ? [] : [id]), ...element.children.flatMap(allIds)];
};

// Concepts are the schema's top-level element declarations; a duplicate id or standard targetNamespace throws.
export function extensionSchema(url: string, xsd: string): ExtensionSchema {
  const root = parseXml(xsd);
  const namespace = attributeOf(root, "", "targetNamespace");
  if (root.namespace !== XSD || root.local !== "schema" || namespace === undefined) {
    throw new Error("extension schema without targetNamespace");
  }
  if (isStandardTaxonomyNamespace(namespace)) {
    throw new Error(`extension schema claims standard namespace ${namespace}`);
  }
  const ids = allIds(root);
  if (new Set(ids).size !== ids.length) {
    throw new Error("extension schema with a duplicate id");
  }
  const localById = new Map<string, string>();
  for (const element of root.children) {
    const id = attributeOf(element, "", "id");
    const name = attributeOf(element, "", "name");
    if (
      element.namespace === XSD &&
      element.local === "element" &&
      id !== undefined &&
      name !== undefined
    ) {
      localById.set(id, name);
    }
  }
  return { url: new URL(url).href, namespace, localById };
}

const US_GAAP_SCHEMA =
  /^https?:\/\/xbrl\.fasb\.org\/us-gaap\/(\d{4})\/elts\/us-gaap-\1\.xsd#us-gaap_(\w+)$/u;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;

// `<namespace URI>#<local>` of a locator: us-gaap only from the official FASB taxonomy, the filing's own concepts
// Only from its extension schema; any other target stays `unresolved:` and so never matches a fact or an allowlist.
function locatorConcept(href: string, linkbaseUrl: string, schema: ExtensionSchema): string {
  const hash = href.indexOf("#");
  let fragment: string;
  try {
    fragment = decodeURIComponent(hash === -1 ? "" : href.slice(hash + 1));
  } catch {
    throw new Error(`malformed calculation locator fragment ${href}`);
  }
  const gaap = US_GAAP_SCHEMA.exec(`${hash === -1 ? href : href.slice(0, hash)}#${fragment}`);
  if (gaap !== null) {
    return `http://fasb.org/us-gaap/${gaap[1]}#${gaap[2]}`;
  }
  const target = URL.parse(href, linkbaseUrl);
  if (target !== null) {
    target.hash = "";
  }
  if (target?.href !== schema.url) {
    return `unresolved:${href}`;
  }
  const local = schema.localById.get(fragment);
  if (local === undefined) {
    throw new Error(`locator ${href} names no element of ${schema.url}`);
  }
  return `${schema.namespace}#${local}`;
}

// Canonical lexical xs:decimal (`+01.50` -> `1.5`), so weights compare exactly with no binary rounding.
function canonicalDecimal(raw: string): string | undefined {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?$/u.exec(raw);
  if (match === null || !DECIMAL.test(raw)) {
    return undefined;
  }
  const whole = (match[2] ?? "").replace(/^0+/u, "");
  const fraction = (match[3] ?? "").replace(/0+$/u, "");
  if (whole === "" && fraction === "") {
    return "0";
  }
  return `${match[1] === "-" ? "-" : ""}${whole === "" ? "0" : whole}${fraction === "" ? "" : `.${fraction}`}`;
}

export interface SummationParent {
  readonly parent: string;
  // Canonical decimal string; exactly "1" for a weight of one.
  readonly weight: string;
}

// Summation parents of each `<namespace URI>#<local>` child across every network; throws on a prohibited or
// Prioritized arc, a missing or zero weight, or one relationship weighted two ways.
function requireXlinkType(element: XmlElement, type: string): void {
  if (attributeOf(element, XLINK, "type") !== type) {
    throw new Error(`calculation ${element.local} is not xlink:type ${type}`);
  }
}

export function summationParents(
  xml: string,
  linkbaseUrl: string,
  schema: ExtensionSchema,
): ReadonlyMap<string, readonly SummationParent[]> {
  const parents = new Map<string, SummationParent[]>();
  const weights = new Map<string, string>();
  for (const link of descendants(parseXml(xml), LINKBASE, "calculationLink")) {
    requireXlinkType(link, "extended");
    const role = attributeOf(link, XLINK, "role") ?? "";
    const locators = new Map<string, string[]>();
    for (const loc of descendants(link, LINKBASE, "loc")) {
      requireXlinkType(loc, "locator");
      const label = attributeOf(loc, XLINK, "label");
      const href = attributeOf(loc, XLINK, "href");
      if (label === undefined || href === undefined) {
        throw new Error("unreadable calculation locator");
      }
      locators.set(label, [
        ...(locators.get(label) ?? []),
        locatorConcept(href, linkbaseUrl, schema),
      ]);
    }
    for (const arc of descendants(link, LINKBASE, "calculationArc")) {
      requireXlinkType(arc, "arc");
      if (!SUMMATION_ITEM.has(attributeOf(arc, XLINK, "arcrole") ?? "")) {
        continue;
      }
      const priority = attributeOf(arc, "", "priority");
      if (
        attributeOf(arc, "", "use") === "prohibited" ||
        (priority !== undefined && Number(priority) !== 0)
      ) {
        throw new Error("prohibited or prioritized calculation arc");
      }
      const from = locators.get(attributeOf(arc, XLINK, "from") ?? "");
      const to = locators.get(attributeOf(arc, XLINK, "to") ?? "");
      const rawWeight = attributeOf(arc, "", "weight")?.trim() ?? "";
      const weight = canonicalDecimal(rawWeight);
      if (from === undefined || to === undefined) {
        throw new Error("calculation arc to an unknown locator");
      }
      if (weight === undefined || weight === "0") {
        throw new Error(`unreadable calculation weight ${rawWeight}`);
      }
      for (const parent of from) {
        for (const child of to) {
          const key = `${role} ${parent} ${child}`;
          if ((weights.get(key) ?? weight) !== weight) {
            throw new Error(`calculation arc ${key} weighted two ways`);
          }
          weights.set(key, weight);
          parents.set(child, [...(parents.get(child) ?? []), { parent, weight }]);
        }
      }
    }
  }
  return parents;
}
