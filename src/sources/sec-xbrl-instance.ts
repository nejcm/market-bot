// Strict namespace-aware XML reader for SEC XBRL instances and linkbases; anything it cannot read throws.
export interface XmlElement {
  readonly namespace: string;
  readonly local: string;
  // Keyed `<namespace URI>|<local>`; an unprefixed attribute has an empty namespace.
  readonly attributes: ReadonlyMap<string, string>;
  readonly children: readonly XmlElement[];
  readonly text: string;
  readonly namespaces: ReadonlyMap<string, string>;
}

export const XLINK = "http://www.w3.org/1999/xlink";
const XBRLI = "http://www.xbrl.org/2003/instance";
const XBRLDI = "http://xbrl.org/2006/xbrldi";
const LINK = "http://www.xbrl.org/2003/linkbase";
const XSI = "http://www.w3.org/2001/XMLSchema-instance";
const XMLNS = "http://www.w3.org/XML/1998/namespace";
const CANONICAL_PREFIXES: readonly (readonly [RegExp, string])[] = [
  [/^http:\/\/fasb\.org\/us-gaap\/\d{4}$/u, "us-gaap"],
  [/^http:\/\/fasb\.org\/srt\/\d{4}$/u, "srt"],
  [/^http:\/\/xbrl\.sec\.gov\/dei\/\d{4}$/u, "dei"],
  [/^http:\/\/www\.xbrl\.org\/2003\/iso4217$/u, "iso4217"],
  [/^http:\/\/www\.xbrl\.org\/2003\/instance$/u, "xbrli"],
];
const RESERVED_PREFIXES = new Set(CANONICAL_PREFIXES.map(([, prefix]) => prefix));
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/u;

// XML 1.0 `Char`: tab, newline, carriage return and the non-surrogate planes, minus U+FFFE/U+FFFF.
const xmlChar = (code: number) =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7_ff) ||
  (code >= 0xe0_00 && code <= 0xff_fd) ||
  (code >= 0x1_00_00 && code <= 0x10_ff_ff);

function decode(raw: string): string {
  return raw.replaceAll(/&([^;&]*);?/gu, (whole, ref: string) => {
    const hex = /^#x([\da-fA-F]+)$/u.exec(ref)?.[1];
    const digits = hex ?? /^#(\d+)$/u.exec(ref)?.[1];
    const code =
      digits === undefined ? undefined : Number.parseInt(digits, hex === undefined ? 10 : 16);
    if (code !== undefined && !xmlChar(code)) {
      throw new Error(`illegal character reference &${ref};`);
    }
    const decoded = code === undefined ? ENTITIES[ref] : String.fromCodePoint(code);
    if (!whole.endsWith(";") || decoded === undefined) {
      throw new Error(`unreadable entity &${ref}`);
    }
    return decoded;
  });
}

function resolve(qname: string, namespaces: ReadonlyMap<string, string>, attribute: boolean) {
  const colon = qname.indexOf(":");
  const prefix = colon === -1 ? "" : qname.slice(0, colon);
  if (prefix === "xml") {
    return { namespace: XMLNS, local: qname.slice(4) };
  }
  const namespace = prefix === "" && attribute ? "" : namespaces.get(prefix);
  if (namespace === undefined) {
    throw new Error(`undeclared prefix in ${qname}`);
  }
  return { namespace, local: qname.slice(colon + 1) };
}

interface OpenElement {
  readonly name: string;
  readonly element: Omit<XmlElement, "children" | "text">;
  readonly children: XmlElement[];
  text: string;
}

function startTag(source: string, parent: ReadonlyMap<string, string>) {
  const name = /^[^\s/>]+/u.exec(source)?.[0] ?? "";
  const raw = new Map<string, string>();
  let rest = source.slice(name.length);
  for (;;) {
    const match = /^\s+([^\s=/>]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/u.exec(rest);
    if (match === null) {
      break;
    }
    const [whole, key = "", double, single] = match;
    if (raw.has(key) || !NAME.test(key)) {
      throw new Error(`bad attribute ${key}`);
    }
    raw.set(key, decode(double ?? single ?? ""));
    rest = rest.slice(whole.length);
  }
  const selfClosing = /^\s*\/$/u.test(rest);
  if (!NAME.test(name) || (!selfClosing && rest.trim() !== "")) {
    throw new Error(`unreadable tag <${source}>`);
  }
  const namespaces = new Map(parent);
  for (const [key, value] of raw) {
    if (key === "xmlns" || key.startsWith("xmlns:")) {
      namespaces.set(key === "xmlns" ? "" : key.slice(6), value);
    }
  }
  const attributes = new Map<string, string>();
  for (const [key, value] of raw) {
    if (key !== "xmlns" && !key.startsWith("xmlns:")) {
      const { namespace, local } = resolve(key, namespaces, true);
      const id = `${namespace}|${local}`;
      // SEC EFM forbids xml:base, and an unapplied base would misidentify every href beneath it.
      if (namespace === XMLNS && local === "base") {
        throw new Error("xml:base is not supported");
      }
      if (attributes.has(id)) {
        throw new Error(`duplicate attribute ${key}`);
      }
      attributes.set(id, value);
    }
  }
  return {
    name,
    selfClosing,
    element: { ...resolve(name, namespaces, false), attributes, namespaces },
  };
}

// Index of the `>` closing the start tag at `from`, skipping quoted attribute values.
function startTagEnd(xml: string, from: number): number {
  let quote = "";
  for (let at = from; at < xml.length; at += 1) {
    const char = xml[at]!;
    if (quote !== "") {
      quote = char === quote ? "" : quote;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return at;
    }
  }
  throw new Error("unterminated <");
}

export function parseXml(xml: string): XmlElement {
  if (![...xml].every((char) => xmlChar(char.codePointAt(0)!))) {
    throw new Error("character outside XML 1.0");
  }
  const stack: OpenElement[] = [];
  let root: XmlElement | undefined = undefined;
  let at = xml.startsWith("﻿") ? 1 : 0;
  const addText = (text: string) => {
    const top = stack.at(-1);
    if (top === undefined) {
      if (text.trim() !== "") {
        throw new Error("text outside the root element");
      }
      return;
    }
    top.text += text;
  };
  while (at < xml.length) {
    const lt = xml.indexOf("<", at);
    if (lt === -1) {
      addText(decode(xml.slice(at)));
      break;
    }
    addText(decode(xml.slice(at, lt)));
    const delimited = (open: string, close: string) => {
      const end = xml.indexOf(close, lt + open.length);
      if (end === -1) {
        throw new Error(`unterminated ${open}`);
      }
      at = end + close.length;
      return xml.slice(lt + open.length, end);
    };
    if (xml.startsWith("<!--", lt)) {
      delimited("<!--", "-->");
    } else if (xml.startsWith("<![CDATA[", lt)) {
      addText(delimited("<![CDATA[", "]]>"));
    } else if (xml.startsWith("<?", lt)) {
      delimited("<?", "?>");
    } else if (xml.startsWith("<!", lt)) {
      throw new Error("DOCTYPE or markup declaration");
    } else if (xml.startsWith("</", lt)) {
      const name = delimited("</", ">").trim();
      const top = stack.pop();
      if (top?.name !== name) {
        throw new Error(`unbalanced </${name}>`);
      }
      const closed: XmlElement = { ...top.element, children: top.children, text: top.text };
      const parent = stack.at(-1);
      if (parent === undefined) {
        if (root !== undefined) {
          throw new Error("second root element");
        }
        root = closed;
      } else {
        parent.children.push(closed);
      }
    } else {
      const end = startTagEnd(xml, lt + 1);
      at = end + 1;
      const tag = startTag(xml.slice(lt + 1, end), stack.at(-1)?.element.namespaces ?? new Map());
      if (stack.length === 0 && root !== undefined) {
        throw new Error("second root element");
      }
      const parent = stack.at(-1);
      if (tag.selfClosing) {
        const closed: XmlElement = { ...tag.element, children: [], text: "" };
        if (parent === undefined) {
          root = closed;
        } else {
          parent.children.push(closed);
        }
      } else {
        stack.push({ name: tag.name, element: tag.element, children: [], text: "" });
      }
    }
  }
  if (stack.length > 0 || root === undefined) {
    throw new Error("unclosed element");
  }
  return root;
}

export function attributeOf(
  element: XmlElement,
  namespace: string,
  local: string,
): string | undefined {
  return element.attributes.get(`${namespace}|${local}`);
}

const NON_CALCULATION_LINKBASE_ROLES = new Set(
  ["presentation", "label", "definition", "reference"].map(
    (kind) => `http://www.xbrl.org/2003/role/${kind}LinkbaseRef`,
  ),
);

// XBRL 2.1 §4.3.4: a linkbaseRef with no role, or any role but the four non-calculation ones, may hold calculations.
export const mayHoldCalculations = (linkbaseRef: XmlElement): boolean =>
  !NON_CALCULATION_LINKBASE_ROLES.has(attributeOf(linkbaseRef, XLINK, "role") ?? "");

// `prefix:Local`: the canonical prefix for standard namespaces, else the first declared alias; identity stays the
// Expanded name, and a reserved standard prefix bound to another namespace is unreadable.
function canonicalName(namespace: string, local: string, namespaces: ReadonlyMap<string, string>) {
  const canonical = CANONICAL_PREFIXES.find(([pattern]) => pattern.test(namespace))?.[1];
  if (canonical !== undefined) {
    return `${canonical}:${local}`;
  }
  const declared = [...namespaces]
    .filter(([name, uri]) => uri === namespace && name !== "")
    .map(([name]) => name)
    .toSorted();
  if (declared.length === 0 || declared.some((name) => RESERVED_PREFIXES.has(name))) {
    throw new Error(`no readable prefix for ${namespace}`);
  }
  return `${declared[0]}:${local}`;
}

// Text of an element that may hold no child elements.
function simpleText(element: XmlElement): string {
  if (element.children.length > 0) {
    throw new Error(`element inside simple value ${element.local}`);
  }
  return element.text.trim();
}

function qnameText(element: XmlElement): string {
  const { namespace, local } = resolve(simpleText(element), element.namespaces, false);
  return canonicalName(namespace, local, element.namespaces);
}

interface XbrlContext {
  readonly entity: { readonly scheme: string; readonly identifier: string };
  readonly instant?: string;
  readonly start?: string;
  readonly end?: string;
  readonly members: readonly (readonly [axis: string, member: string])[];
}

export type XbrlUnit =
  | { readonly measures: readonly string[] }
  | { readonly numerator: readonly string[]; readonly denominator: readonly string[] };

export interface XbrlFact {
  readonly concept: string;
  readonly namespace: string;
  readonly local: string;
  readonly contextRef?: string;
  readonly unitRef?: string;
  readonly id?: string;
  readonly nil: boolean;
  readonly value?: string;
}

export interface XbrlInstance {
  readonly contexts: ReadonlyMap<string, XbrlContext>;
  readonly units: ReadonlyMap<string, XbrlUnit>;
  readonly facts: readonly XbrlFact[];
  readonly schemaRefs: readonly string[];
  readonly calculationLinkbaseRefs: readonly string[];
}

const is = (element: XmlElement, namespace: string, local: string) =>
  element.namespace === namespace && element.local === local;

// Children of `element` by xbrli local name, each within [min, max]; any other child throws.
function grammar(
  element: XmlElement,
  allowed: Readonly<Record<string, readonly [min: number, max: number]>>,
): Readonly<Record<string, readonly XmlElement[]>> {
  const found: Record<string, XmlElement[]> = Object.fromEntries(
    Object.keys(allowed).map((local) => [local, []]),
  );
  for (const child of element.children) {
    const slot = child.namespace === XBRLI ? found[child.local] : undefined;
    if (slot === undefined) {
      throw new Error(`unexpected ${child.local} in ${element.local}`);
    }
    slot.push(child);
  }
  for (const [local, [min, max]] of Object.entries(allowed)) {
    const count = found[local]!.length;
    if (count < min || count > max) {
      throw new Error(`${element.local} needs ${String(min)}-${String(max)} ${local}`);
    }
  }
  return found;
}

function date(element: XmlElement | undefined): string | undefined {
  if (element === undefined) {
    return undefined;
  }
  const text = simpleText(element);
  const parsed = /^\d{4}-\d{2}-\d{2}$/u.test(text) ? new Date(`${text}T00:00:00Z`) : undefined;
  if (
    parsed === undefined ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== text
  ) {
    throw new Error(`unreadable date ${text}`);
  }
  return text;
}

function context(element: XmlElement): XbrlContext {
  const parts = grammar(element, { entity: [1, 1], period: [1, 1], scenario: [0, 1] });
  const entity = grammar(parts.entity![0]!, { identifier: [1, 1], segment: [0, 1] });
  const identifier = entity.identifier![0]!;
  const scheme = attributeOf(identifier, "", "scheme");
  if (scheme === undefined) {
    throw new Error("entity identifier without scheme");
  }
  const period = parts.period![0]!;
  const instantPeriod = period.children.some((child) => is(child, XBRLI, "instant"));
  const dates = grammar(
    period,
    instantPeriod ? { instant: [1, 1] } : { startDate: [1, 1], endDate: [1, 1] },
  );
  const members = [...(entity.segment ?? []), ...(parts.scenario ?? [])].flatMap((container) =>
    container.children.map((member): readonly [string, string] => {
      const dimension = attributeOf(member, "", "dimension");
      if (dimension === undefined || member.namespace !== XBRLDI) {
        throw new Error("unreadable dimension member");
      }
      const axis = resolve(dimension, member.namespaces, false);
      const axisName = canonicalName(axis.namespace, axis.local, member.namespaces);
      if (member.local === "explicitMember") {
        return [axisName, qnameText(member)];
      }
      if (member.local === "typedMember") {
        return [axisName, `typed:${member.children.map((child) => child.text.trim()).join(",")}`];
      }
      throw new Error(`unreadable dimension member ${member.local}`);
    }),
  );
  const instant = date(dates.instant?.[0]);
  const start = date(dates.startDate?.[0]);
  const end = date(dates.endDate?.[0]);
  return {
    entity: { scheme, identifier: simpleText(identifier) },
    ...(instant === undefined ? {} : { instant }),
    ...(start === undefined ? {} : { start }),
    ...(end === undefined ? {} : { end }),
    members,
  };
}

const measures = (element: XmlElement) =>
  grammar(element, { measure: [1, Infinity] }).measure!.map(qnameText);

function unit(element: XmlElement): XbrlUnit {
  if (!element.children.some((child) => is(child, XBRLI, "divide"))) {
    return { measures: measures(element) };
  }
  const divide = grammar(grammar(element, { divide: [1, 1] }).divide![0]!, {
    unitNumerator: [1, 1],
    unitDenominator: [1, 1],
  });
  return {
    numerator: measures(divide.unitNumerator![0]!),
    denominator: measures(divide.unitDenominator![0]!),
  };
}

function nilOf(element: XmlElement): boolean {
  const nil = attributeOf(element, XSI, "nil")?.trim();
  if (nil !== undefined && !["true", "1", "false", "0"].includes(nil)) {
    throw new Error(`unreadable xsi:nil ${nil}`);
  }
  return nil === "true" || nil === "1";
}

function addUnique<T>(map: Map<string, T>, id: string | undefined, value: T): void {
  if (id === undefined || map.has(id)) {
    throw new Error(`missing or duplicate id ${String(id)}`);
  }
  map.set(id, value);
}

const SIMPLE_LINKS = new Set(["schemaRef", "linkbaseRef", "roleRef", "arcroleRef"]);
const FOOTNOTE_PARTS = new Set(["loc", "footnote", "footnoteArc"]);
const XHTML = "http://www.w3.org/1999/xhtml";
const onlyXhtml = (element: XmlElement): boolean =>
  element.children.every((child) => child.namespace === XHTML && onlyXhtml(child));

// Footnote links hold locators, arcs and XHTML footnote text, never facts.
function checkRootLink(element: XmlElement): void {
  const readable = SIMPLE_LINKS.has(element.local)
    ? element.children.length === 0 && element.text.trim() === ""
    : element.local === "footnoteLink" &&
      element.children.every(
        (part) =>
          part.namespace === LINK &&
          FOOTNOTE_PARTS.has(part.local) &&
          (part.local === "footnote" ? onlyXhtml(part) : part.children.length === 0),
      );
  if (!readable) {
    throw new Error(`unreadable ${element.local} in xbrl`);
  }
}
const NOT_CONCEPT_NAMESPACES = new Set([XBRLI, LINK, XBRLDI, XSI, XLINK]);

export function parseXbrlInstance(xml: string): XbrlInstance {
  const root = parseXml(xml);
  if (!is(root, XBRLI, "xbrl")) {
    throw new Error("not an XBRL instance");
  }
  const contexts = new Map<string, XbrlContext>();
  const units = new Map<string, XbrlUnit>();
  const facts: XbrlFact[] = [];
  const schemaRefs: string[] = [];
  const calculationLinkbaseRefs: string[] = [];
  for (const element of root.children) {
    const id = attributeOf(element, "", "id");
    if (is(element, XBRLI, "context")) {
      addUnique(contexts, id, context(element));
    } else if (is(element, XBRLI, "unit")) {
      addUnique(units, id, unit(element));
    } else if (element.namespace === LINK) {
      checkRootLink(element);
      const href = attributeOf(element, XLINK, "href");
      if (element.local === "schemaRef" && href !== undefined) {
        schemaRefs.push(href);
      }
      if (element.local === "linkbaseRef" && mayHoldCalculations(element)) {
        calculationLinkbaseRefs.push(href ?? "");
      }
    } else if (NOT_CONCEPT_NAMESPACES.has(element.namespace)) {
      throw new Error(`unexpected ${element.local} in xbrl`);
    } else {
      if (element.children.length > 0) {
        throw new Error(`tuple or nested fact ${element.local}`);
      }
      const contextRef = attributeOf(element, "", "contextRef");
      const unitRef = attributeOf(element, "", "unitRef");
      const nil = nilOf(element);
      if (nil && element.text.trim() !== "") {
        throw new Error(`nil fact with content ${element.local}`);
      }
      facts.push({
        concept: canonicalName(element.namespace, element.local, element.namespaces),
        namespace: element.namespace,
        local: element.local,
        ...(contextRef === undefined ? {} : { contextRef }),
        ...(unitRef === undefined ? {} : { unitRef }),
        ...(id === undefined ? {} : { id }),
        nil,
        ...(nil ? {} : { value: element.text.trim() }),
      });
    }
  }
  return { contexts, units, facts, schemaRefs, calculationLinkbaseRefs };
}
