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

function decode(raw: string): string {
  return raw.replaceAll(/&([^;&]*);?/gu, (whole, ref: string) => {
    const code = /^#x([\da-fA-F]+)$/u.exec(ref)?.[1] ?? /^#(\d+)$/u.exec(ref)?.[1];
    const decoded =
      code === undefined
        ? ENTITIES[ref]
        : String.fromCodePoint(Number.parseInt(code, ref.startsWith("#x") ? 16 : 10));
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

export function parseXml(xml: string): XmlElement {
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
      const tag = startTag(delimited("<", ">"), stack.at(-1)?.element.namespaces ?? new Map());
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

// `prefix:Local` with the canonical prefix for standard namespaces, so an issuer's own prefix spelling never matters.
function canonicalName(namespace: string, local: string, namespaces: ReadonlyMap<string, string>) {
  const canonical = CANONICAL_PREFIXES.find(([pattern]) => pattern.test(namespace))?.[1];
  if (canonical !== undefined) {
    return `${canonical}:${local}`;
  }
  const declared = [...namespaces].filter(([prefix, uri]) => uri === namespace && prefix !== "");
  const prefix = declared[0]?.[0];
  if (prefix === undefined || declared.length > 1 || RESERVED_PREFIXES.has(prefix)) {
    throw new Error(`no unique prefix for ${namespace}`);
  }
  return `${prefix}:${local}`;
}

function qnameText(element: XmlElement): string {
  const { namespace, local } = resolve(element.text.trim(), element.namespaces, false);
  return canonicalName(namespace, local, element.namespaces);
}

interface XbrlContext {
  readonly instant?: string;
  readonly start?: string;
  readonly end?: string;
  readonly members: readonly (readonly [axis: string, member: string])[];
}

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
  readonly units: ReadonlyMap<string, readonly string[] | "divide">;
  readonly facts: readonly XbrlFact[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const is = (element: XmlElement, namespace: string, local: string) =>
  element.namespace === namespace && element.local === local;
const childrenOf = (element: XmlElement | undefined, namespace: string, local: string) =>
  (element?.children ?? []).filter((child) => is(child, namespace, local));

function date(element: XmlElement | undefined): string | undefined {
  const text = element?.text.trim();
  if (text !== undefined && !DATE.test(text)) {
    throw new Error(`unreadable date ${text}`);
  }
  return text;
}

function context(element: XmlElement): XbrlContext {
  const [period] = childrenOf(element, XBRLI, "period");
  const [instant] = childrenOf(period, XBRLI, "instant");
  const [start] = childrenOf(period, XBRLI, "startDate");
  const [end] = childrenOf(period, XBRLI, "endDate");
  const periodParts = instant === undefined ? [start, end] : [instant];
  if (periodParts.includes(undefined) || period?.children.length !== periodParts.length) {
    throw new Error("context without instant or start/end");
  }
  const containers = [
    ...childrenOf(element, XBRLI, "entity").flatMap((entity) =>
      childrenOf(entity, XBRLI, "segment"),
    ),
    ...childrenOf(element, XBRLI, "scenario"),
  ];
  const members = containers.flatMap((container) =>
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
  const instantDate = date(instant);
  const startDate = date(start);
  const endDate = date(end);
  return {
    ...(instantDate === undefined ? {} : { instant: instantDate }),
    ...(startDate === undefined ? {} : { start: startDate }),
    ...(endDate === undefined ? {} : { end: endDate }),
    members,
  };
}

function unit(element: XmlElement): readonly string[] | "divide" {
  if (childrenOf(element, XBRLI, "divide").length > 0) {
    return "divide";
  }
  const measures = childrenOf(element, XBRLI, "measure").map(qnameText);
  if (measures.length === 0) {
    throw new Error("unit without measure");
  }
  return measures;
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

export function parseXbrlInstance(xml: string): XbrlInstance {
  const root = parseXml(xml);
  if (!is(root, XBRLI, "xbrl")) {
    throw new Error("not an XBRL instance");
  }
  const contexts = new Map<string, XbrlContext>();
  const units = new Map<string, readonly string[] | "divide">();
  const facts: XbrlFact[] = [];
  for (const element of root.children) {
    const id = attributeOf(element, "", "id");
    if (is(element, XBRLI, "context")) {
      addUnique(contexts, id, context(element));
    } else if (is(element, XBRLI, "unit")) {
      addUnique(units, id, unit(element));
    } else if (element.namespace === XBRLI) {
      throw new Error(`unexpected xbrli:${element.local}`);
    } else if (element.namespace !== LINK) {
      if (element.children.length > 0) {
        throw new Error(`tuple or nested fact ${element.local}`);
      }
      const contextRef = attributeOf(element, "", "contextRef");
      const unitRef = attributeOf(element, "", "unitRef");
      const nil = nilOf(element);
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
  return { contexts, units, facts };
}
