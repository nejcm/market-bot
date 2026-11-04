import { isStandardTaxonomyNamespace } from "./sec-calculation-linkbase";
import type { XbrlFact, XbrlInstance } from "./sec-xbrl-instance";
import type { CalculationPlacement } from "./sec-zero-borrowings-proof";

export const EXTENSION_SHORT_TERM_INVESTMENTS_PREFIX = "extensionShortTermInvestments|";
export const EXTENSION_SHORT_TERM_INVESTMENTS_PROOF_PREFIX = "extensionShortTermInvestmentsProof|";
export const EXTENSION_INVESTMENTS_SOURCE_INFIX = "-investments-";

const LOCATION_AXIS = "us-gaap:StatementOfFinancialPositionLocationBalanceAxis";
// Closed list of us-gaap investment carrying amounts that may sum to a located line; it grows only from filed evidence.
const LOCATED_INVESTMENT_CONCEPTS = new Set(["us-gaap:AvailableForSaleSecuritiesDebtSecurities"]);
const US_GAAP_NAMESPACE = /^http:\/\/fasb\.org\/us-gaap\/\d{4}$/u;
const INTEGER = /^-?\d+$/u;
const cikNumber = (identifier: string) =>
  /^\d{1,10}$/u.test(identifier) ? String(Number(identifier)) : undefined;
const isAssetsCurrent = (expandedName: string) => {
  const [namespace = "", name = ""] = expandedName.split("#");
  return US_GAAP_NAMESPACE.test(namespace) && name === "AssetsCurrent";
};
const expanded = ({ namespace, local }: XbrlFact) => `${namespace}#${local}`;

interface ExtensionShortTermInvestment {
  readonly periodEnd: string;
  readonly concept: string;
  readonly value: number;
  readonly currency: string;
  readonly assetsCurrent: number;
  readonly proof: string;
}

export type ExtensionShortTermInvestmentsProof =
  | { readonly reject: string }
  | {
      readonly proved: readonly ExtensionShortTermInvestment[];
      readonly rejected: readonly { readonly periodEnd: string; readonly reject: string }[];
    };

const groupBy = <T>(rows: readonly T[], key: (row: T) => string) => {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  }
  return groups;
};

// Issuer-extension concepts that some context names as a typed balance-sheet location member (eBay 10-Q).
function locatedExtensionLines(instance: XbrlInstance, extensionNamespace: string) {
  const extensionConcepts = new Set(
    instance.facts
      .filter(
        ({ namespace }) =>
          namespace === extensionNamespace && !isStandardTaxonomyNamespace(namespace),
      )
      .map(({ concept }) => concept),
  );
  return new Set(
    [...instance.contexts.values()].flatMap(({ members }) =>
      members.flatMap(([axis, member]) =>
        axis === LOCATION_AXIS &&
        member.startsWith("typed:") &&
        extensionConcepts.has(member.slice(6))
          ? [member.slice(6)]
          : [],
      ),
    ),
  );
}

// An extension line is short-term investments at an instant only when it adds into AssetsCurrent at weight 1, the
// AssetsCurrent lines foot exactly, and listed us-gaap investment facts located on that line sum to its value.
export function extensionShortTermInvestmentsProof(
  instance: XbrlInstance,
  placement: CalculationPlacement,
  { file, cik }: { readonly file: string; readonly cik: string },
): ExtensionShortTermInvestmentsProof {
  const { contexts, units, facts } = instance;
  const foreign = [...contexts.values()].find(
    ({ entity }) =>
      entity.scheme !== "http://www.sec.gov/CIK" || cikNumber(entity.identifier) !== cikNumber(cik),
  );
  if (foreign !== undefined) {
    return { reject: `entity-mismatch:${foreign.entity.identifier}` };
  }
  const read = facts.flatMap((fact) => {
    const context = fact.contextRef === undefined ? undefined : contexts.get(fact.contextRef);
    const unit = fact.unitRef === undefined ? undefined : units.get(fact.unitRef);
    const [measure, ...more] = unit !== undefined && "measures" in unit ? unit.measures : [];
    return context?.instant === undefined || fact.nil || fact.value === undefined
      ? []
      : [
          {
            ...fact,
            instant: context.instant,
            members: context.members,
            currency:
              measure?.startsWith("iso4217:") === true && more.length === 0
                ? measure.slice(8)
                : undefined,
          },
        ];
  });
  type Read = (typeof read)[number];
  // Duplicate facts must agree; a second value for one concept and context is unreadable.
  const valueOf = (rows: readonly Read[]): bigint | string => {
    const values = new Set(rows.map(({ value }) => value));
    const [only] = values;
    if (values.size !== 1 || only === undefined || !INTEGER.test(only)) {
      return `value-unreadable:${rows[0]?.concept ?? "none"}`;
    }
    return BigInt(only);
  };
  const children = [...placement.parents].flatMap(([child, parents]) =>
    parents
      .filter(({ parent }) => isAssetsCurrent(parent))
      .map(({ weight }) => ({ child, weight })),
  );
  const proved: ExtensionShortTermInvestment[] = [];
  const rejected: { periodEnd: string; reject: string }[] = [];
  for (const line of locatedExtensionLines(instance, placement.extensionNamespace)) {
    const faces = read.filter(({ concept, members }) => concept === line && members.length === 0);
    const lineKey = faces[0] === undefined ? undefined : expanded(faces[0]);
    for (const periodEnd of new Set(faces.map(({ instant }) => instant))) {
      const reject = (code: string) => rejected.push({ periodEnd, reject: code });
      const at = (key: string) =>
        read.filter(
          (fact) =>
            fact.instant === periodEnd && fact.members.length === 0 && expanded(fact) === key,
        );
      const lineFacts = faces.filter(({ instant }) => instant === periodEnd);
      const currency = lineFacts[0]?.currency;
      const value = valueOf(lineFacts);
      const placed = children.filter(({ child }) => child === lineKey);
      // A located line outside current assets (eBay's long-term investments) is not a candidate, not a failure.
      if (placed.length === 0) {
        continue;
      }
      const assetsCurrent = read.filter(
        (fact) =>
          fact.instant === periodEnd &&
          fact.members.length === 0 &&
          isAssetsCurrent(expanded(fact)) &&
          fact.concept === "us-gaap:AssetsCurrent",
      );
      const total = valueOf(assetsCurrent);
      if (currency === undefined || lineFacts.some((fact) => fact.currency !== currency)) {
        reject(`unit-unreadable:${line}`);
      } else if (typeof value === "string") {
        reject(value);
      } else if (placed.some(({ weight }) => weight !== "1")) {
        reject(`assets-current-weight:${placed.find(({ weight }) => weight !== "1")!.weight}`);
      } else if (assetsCurrent.length === 0) {
        reject("no-assets-current-fact");
      } else if (typeof total === "string") {
        reject(total);
      } else if (assetsCurrent.some((fact) => fact.currency !== currency)) {
        reject(`currency-mismatch:us-gaap:AssetsCurrent`);
      } else {
        let footed: bigint | string = 0n;
        for (const { child, weight } of children) {
          const rows = at(child);
          if (rows.length === 0 || typeof footed === "string") {
            continue;
          }
          const amount = valueOf(rows);
          footed =
            weight !== "1" && weight !== "-1"
              ? `assets-current-weight:${weight}`
              : rows.some((row) => row.currency !== currency)
                ? `currency-mismatch:${rows[0]!.concept}`
                : typeof amount === "string"
                  ? amount
                  : footed + (weight === "1" ? amount : -amount);
        }
        const located = read.filter(
          (fact) =>
            fact.instant === periodEnd &&
            LOCATED_INVESTMENT_CONCEPTS.has(fact.concept) &&
            fact.members.length === 1 &&
            fact.members[0]![0] === LOCATION_AXIS &&
            fact.members[0]![1] === `typed:${line}`,
        );
        const byConcept = groupBy(located, ({ concept }) => concept);
        const sums = [...byConcept.values()].map(valueOf);
        const unreadable = sums.find((sum) => typeof sum === "string");
        const locatedSum = sums.reduce<bigint>(
          (sum, part) => sum + (typeof part === "bigint" ? part : 0n),
          0n,
        );
        if (typeof footed === "string") {
          reject(footed);
        } else if (footed !== total) {
          reject(`current-assets-do-not-foot:${String(footed)}≠${String(total)}`);
        } else if (located.length === 0) {
          reject("no-located-investment-facts");
        } else if (unreadable !== undefined) {
          reject(unreadable);
        } else if (located.some((fact) => fact.currency !== currency)) {
          reject(`currency-mismatch:${located[0]!.concept}`);
        } else if (locatedSum !== value) {
          reject(`located-investments-do-not-sum:${String(locatedSum)}≠${String(value)}`);
        } else {
          proved.push({
            periodEnd,
            concept: line,
            value: Number(value),
            currency,
            assetsCurrent: Number(total),
            proof: `${line} = ${String(value)} ${currency} at ${periodEnd}: adds into us-gaap:AssetsCurrent at weight 1, current assets foot to ${String(total)}, and ${[...byConcept.keys()].join(" + ")} located on it sum to ${String(value)}; fact ${lineFacts[0]!.id ?? "(no id)"}, ${file}`,
          });
        }
      }
    }
  }
  const instants = groupBy(proved, ({ periodEnd }) => periodEnd);
  return {
    proved: proved.filter(({ periodEnd }) => instants.get(periodEnd)!.length === 1),
    rejected: [
      ...rejected,
      ...[...instants]
        .filter(([, lines]) => lines.length > 1)
        .map(([periodEnd]) => ({ periodEnd, reject: "several-located-lines" })),
    ],
  };
}
