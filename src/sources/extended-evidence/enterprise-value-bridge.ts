import { readNumberMetric, readStringMetric } from "./utils";

export type EnterpriseValueBridgeKey =
  | "shortTermInvestments"
  | "noncontrollingInterest"
  | "preferredStock"
  | "temporaryEquity";

export const TEMPORARY_EQUITY_CONCEPT_PRIORITY = [
  "TemporaryEquityCarryingAmountIncludingPortionAttributableToNoncontrollingInterests",
  "TemporaryEquityCarryingAmount",
  "RedeemableNoncontrollingInterestEquityCarryingAmount",
] as const;

// Alternatives in priority order, never summed: the face line outranks note-level components.
export const ENTERPRISE_VALUE_BRIDGE_CONCEPTS = {
  shortTermInvestments: [
    "ShortTermInvestments",
    "MarketableSecuritiesCurrent",
    "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
    "DebtSecuritiesCurrent",
  ],
  cashAndShortTermInvestments: ["CashCashEquivalentsAndShortTermInvestments"],
  // Added to debt-only short-term lines; the generic concept counts only where current assets prove it current (NVDA).
  currentEquitySecurities: ["EquitySecuritiesFvNiCurrent", "EquitySecuritiesFvNi"],
  noncontrollingInterest: ["MinorityInterest"],
  preferredStock: ["PreferredStockValue", "PreferredStockValueOutstanding"],
  temporaryEquity: [
    ...TEMPORARY_EQUITY_CONCEPT_PRIORITY,
    "TemporaryEquityCarryingAmountAttributableToParent",
  ],
  // Balance-sheet identity at mezzanine instants only: proves temporary equity sits outside MinorityInterest.
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  stockholdersEquity: ["StockholdersEquity"],
  stockholdersEquityIncludingNoncontrollingInterest: [
    "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
  ],
  assetsCurrent: ["AssetsCurrent"],
  receivablesCurrent: ["AccountsReceivableNetCurrent"],
  inventory: ["InventoryNet"],
  otherAssetsCurrent: ["PrepaidExpenseAndOtherAssetsCurrent", "OtherAssetsCurrent"],
} as const;

const MEZZANINE_IDENTITY_KEYS = [
  "assets",
  "liabilities",
  "stockholdersEquity",
  "stockholdersEquityIncludingNoncontrollingInterest",
] as const;

const CURRENT_ASSET_IDENTITY_KEYS = [
  "assetsCurrent",
  "receivablesCurrent",
  "inventory",
  "otherAssetsCurrent",
] as const;

export interface BridgeFact {
  readonly value: number;
  readonly periodEnd: string;
  readonly concept: string;
  readonly filedAt: string;
  readonly firstPublicAt?: string;
}

export type EnterpriseValueBridgeFacts<F extends BridgeFact = BridgeFact> = Readonly<
  Record<keyof typeof ENTERPRISE_VALUE_BRIDGE_CONCEPTS, readonly F[]>
>;

type BridgeComponent<F extends BridgeFact = BridgeFact> =
  | {
      readonly status: "tagged";
      readonly value: number;
      readonly concept: string;
      readonly fact: F;
      readonly addend?: F;
    }
  | { readonly status: "untagged" }
  | { readonly status: "incomplete"; readonly reason: string };

export type ResolvedEnterpriseValueBridge<F extends BridgeFact = BridgeFact> = Readonly<
  Record<EnterpriseValueBridgeKey, BridgeComponent<F>>
>;

export const ENTERPRISE_VALUE_BRIDGE_KEYS: readonly EnterpriseValueBridgeKey[] = [
  "shortTermInvestments",
  "noncontrollingInterest",
  "preferredStock",
  "temporaryEquity",
];

const LABELS: Readonly<Record<EnterpriseValueBridgeKey, string>> = {
  shortTermInvestments: "short-term investments",
  noncontrollingInterest: "noncontrolling interest",
  preferredStock: "preferred stock",
  temporaryEquity: "temporary equity (redeemable noncontrolling interest and redeemable preferred)",
};

// Same continuity window as composite debt (ADR 0004): a nonzero line this recent cannot vanish untagged.
const CONTINUITY_DAYS = 400;
const DAY_MS = 86_400_000;
const NONE_TAGGED = "none tagged";
const COMBINED_CONCEPT = "CashCashEquivalentsAndShortTermInvestments";
const CURRENT_EQUITY_CONCEPT = "EquitySecuritiesFvNiCurrent";
const DEBT_ONLY_SHORT_TERM: ReadonlySet<string> = new Set([
  "AvailableForSaleSecuritiesDebtSecuritiesCurrent",
  "DebtSecuritiesCurrent",
]);
const IDENTITY_TOLERANCE = 0.001;
const DERIVED_NONCONTROLLING_CONCEPT =
  "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest − StockholdersEquity";

export const NET_DEBT_BASIS = "debt less cash and short-term investments";
export const ENTERPRISE_VALUE_BASIS =
  "market cap + debt + preferred stock + noncontrolling interest + temporary equity (redeemable noncontrolling interest and preferred) − cash and short-term investments; long-term investments excluded";

// Identity lists are kept only where temporary equity is tagged, NCI must be derived, or equity securities need proof.
export function trimToMezzaninePeriods<F extends BridgeFact>(
  facts: EnterpriseValueBridgeFacts<F>,
): EnterpriseValueBridgeFacts<F> {
  const equityPeriods = new Set(
    facts.currentEquitySecurities.filter((fact) => fact.value !== 0).map((fact) => fact.periodEnd),
  );
  const parentPeriods = new Set(facts.stockholdersEquity.map((fact) => fact.periodEnd));
  const taggedNoncontrolling = new Set(facts.noncontrollingInterest.map((fact) => fact.periodEnd));
  const periods = new Set([
    ...facts.temporaryEquity.map((fact) => fact.periodEnd),
    ...facts.stockholdersEquityIncludingNoncontrollingInterest
      .map((fact) => fact.periodEnd)
      .filter((periodEnd) => parentPeriods.has(periodEnd) && !taggedNoncontrolling.has(periodEnd)),
  ]);
  return {
    ...facts,
    ...Object.fromEntries(
      MEZZANINE_IDENTITY_KEYS.map((key) => [
        key,
        facts[key].filter((fact) => periods.has(fact.periodEnd)),
      ]),
    ),
    ...Object.fromEntries(
      CURRENT_ASSET_IDENTITY_KEYS.map((key) => [
        key,
        facts[key].filter((fact) => equityPeriods.has(fact.periodEnd)),
      ]),
    ),
  };
}

function withinContinuity(periodEnd: string, instant: string): boolean {
  const days = (Date.parse(instant) - Date.parse(periodEnd)) / DAY_MS;
  return days > 0 && days <= CONTINUITY_DAYS;
}

function component<F extends BridgeFact>(
  key: EnterpriseValueBridgeKey,
  facts: readonly F[],
  instant: string,
  derived?: BridgeComponent<F>,
): BridgeComponent<F> {
  const tagged = facts.findLast((fact) => fact.periodEnd === instant);
  if (tagged !== undefined) {
    return { status: "tagged", value: tagged.value, concept: tagged.concept, fact: tagged };
  }
  if (derived !== undefined) {
    return derived;
  }
  const prior = facts.findLast(
    (fact) => fact.value !== 0 && withinContinuity(fact.periodEnd, instant),
  );
  return prior === undefined
    ? { status: "untagged" }
    : {
        status: "incomplete",
        reason: `${LABELS[key]} (${prior.concept}) reported nonzero at ${prior.periodEnd} but not tagged at ${instant}`,
      };
}

function combinedShortTermInvestments<F extends BridgeFact>(
  combined: readonly F[],
  cash: { readonly value: number; readonly periodEnd: string },
): BridgeComponent<F> | undefined {
  const fact = combined.findLast((candidate) => candidate.periodEnd === cash.periodEnd);
  if (fact === undefined) {
    return combined.some((candidate) => withinContinuity(candidate.periodEnd, cash.periodEnd))
      ? {
          status: "incomplete",
          reason: `short-term investments (${COMBINED_CONCEPT}) reported within ${String(CONTINUITY_DAYS)} days but not tagged at ${cash.periodEnd}`,
        }
      : undefined;
  }
  return fact.value < cash.value
    ? {
        status: "incomplete",
        reason: `${COMBINED_CONCEPT} at ${cash.periodEnd} is below cash`,
      }
    : {
        status: "tagged",
        value: fact.value - cash.value,
        concept: `${COMBINED_CONCEPT} − cash`,
        fact,
      };
}

// A combined line above cash + the picked line hides another holding (Check Point: deposits, long-term securities).
function withCombinedCheck<F extends BridgeFact>(
  part: BridgeComponent<F>,
  combined: readonly F[],
  cash: { readonly value: number; readonly periodEnd: string },
): BridgeComponent<F> {
  const total = combined.findLast((candidate) => candidate.periodEnd === cash.periodEnd);
  if (
    part.status !== "tagged" ||
    total === undefined ||
    part.concept.startsWith(COMBINED_CONCEPT)
  ) {
    return part;
  }
  const residual = total.value - cash.value;
  return Math.abs(residual - part.value) > Math.abs(total.value) * IDENTITY_TOLERANCE
    ? {
        status: "incomplete",
        reason: `${COMBINED_CONCEPT} − cash (${String(residual)}) does not equal ${part.concept} (${String(part.value)}) at ${cash.periodEnd}; the difference is not classified`,
      }
    : part;
}

function valueAt<F extends BridgeFact>(facts: readonly F[], instant: string): number | undefined {
  return facts.findLast((fact) => fact.periodEnd === instant)?.value;
}

function currentAssetsResidual<F extends BridgeFact>(
  facts: EnterpriseValueBridgeFacts<F>,
  cash: { readonly value: number; readonly periodEnd: string },
  shortTermInvestments: number,
): number | undefined {
  const total = valueAt(facts.assetsCurrent, cash.periodEnd);
  const lines = (["receivablesCurrent", "inventory", "otherAssetsCurrent"] as const).map((key) =>
    valueAt(facts[key], cash.periodEnd),
  );
  // An untagged line could be the amount that closes the identity, so it proves nothing.
  return total === undefined || lines.includes(undefined)
    ? undefined
    : Math.abs(
        total -
          lines.reduce<number>((sum, line) => sum + (line ?? 0), cash.value + shortTermInvestments),
      );
}

// Current equity securities sit beside debt securities (NVDA FY2027 Q2: 34,143M debt + 42,783M equity).
function withCurrentEquitySecurities<F extends BridgeFact>(
  part: BridgeComponent<F>,
  facts: EnterpriseValueBridgeFacts<F>,
  cash: { readonly value: number; readonly periodEnd: string },
): BridgeComponent<F> {
  if (part.status === "incomplete") {
    return part;
  }
  const explicit = facts.currentEquitySecurities.filter(
    (fact) => fact.concept === CURRENT_EQUITY_CONCEPT,
  );
  const equity = facts.currentEquitySecurities.findLast(
    (fact) => fact.periodEnd === cash.periodEnd,
  );
  if (equity === undefined) {
    const prior = explicit.findLast(
      (fact) => fact.value !== 0 && withinContinuity(fact.periodEnd, cash.periodEnd),
    );
    return prior === undefined
      ? part
      : {
          status: "incomplete",
          reason: `${LABELS.shortTermInvestments} (${CURRENT_EQUITY_CONCEPT}) reported nonzero at ${prior.periodEnd} but not tagged at ${cash.periodEnd}`,
        };
  }
  if (equity.value === 0) {
    return part;
  }
  const base = part.status === "tagged" ? part.value : 0;
  const debtOnly = part.status === "untagged" || DEBT_ONLY_SHORT_TERM.has(part.concept);
  // Total current assets prove the equity a separate current line only when it closes the identity (VRTX sums without it).
  const tolerance =
    Math.abs(valueAt(facts.assetsCurrent, cash.periodEnd) ?? 0) * IDENTITY_TOLERANCE;
  const withEquity = currentAssetsResidual(facts, cash, base + equity.value);
  const withoutEquity = currentAssetsResidual(facts, cash, base);
  const closesIdentity =
    debtOnly &&
    withEquity !== undefined &&
    withoutEquity !== undefined &&
    withEquity <= tolerance &&
    withoutEquity > tolerance;
  const outsideIdentity =
    withoutEquity !== undefined && withoutEquity <= tolerance && (withEquity ?? 0) > tolerance;
  const additive =
    closesIdentity || (equity.concept === CURRENT_EQUITY_CONCEPT && debtOnly && !outsideIdentity);
  if (additive) {
    return part.status === "tagged"
      ? {
          status: "tagged",
          value: base + equity.value,
          concept: `${part.concept} + ${equity.concept}`,
          fact: part.fact,
          addend: equity,
        }
      : { status: "tagged", value: equity.value, concept: equity.concept, fact: equity };
  }
  // The generic concept is usually a noncurrent holding (META, MRK), which stays out like other long-term investments.
  return equity.concept === CURRENT_EQUITY_CONCEPT
    ? {
        status: "incomplete",
        reason: `${CURRENT_EQUITY_CONCEPT} (${String(equity.value)}) at ${cash.periodEnd} may already sit inside ${part.status === "tagged" ? part.concept : "short-term investments"}`,
      }
    : part;
}

// Untagged MinorityInterest is equity incl. NCI − parent equity, kept only when A − L − that equity − temporary equity is zero.
function derivedNoncontrolling<F extends BridgeFact>(
  facts: EnterpriseValueBridgeFacts<F>,
  temporaryEquity: BridgeComponent<F>,
  instant: string,
): BridgeComponent<F> | undefined {
  const including = facts.stockholdersEquityIncludingNoncontrollingInterest.findLast(
    (fact) => fact.periodEnd === instant,
  );
  const parent = valueAt(facts.stockholdersEquity, instant);
  if (including === undefined || parent === undefined || including.value === parent) {
    return undefined;
  }
  const difference = including.value - parent;
  const assets = valueAt(facts.assets, instant);
  const liabilities = valueAt(facts.liabilities, instant);
  const mezzanine = temporaryEquity.status === "tagged" ? temporaryEquity.value : 0;
  const reconciles =
    assets !== undefined &&
    liabilities !== undefined &&
    temporaryEquity.status !== "incomplete" &&
    Math.abs(assets - liabilities - including.value - mezzanine) <=
      Math.abs(assets) * IDENTITY_TOLERANCE;
  return difference > 0 && reconciles
    ? {
        status: "tagged",
        value: difference,
        concept: DERIVED_NONCONTROLLING_CONCEPT,
        fact: including,
      }
    : {
        status: "incomplete",
        reason: `${LABELS.noncontrollingInterest} untagged at ${instant}; ${DERIVED_NONCONTROLLING_CONCEPT} (${String(difference)}) is negative or does not reconcile with assets − liabilities − equity − temporary equity`,
      };
}

// Temporary equity is added only where assets − liabilities − equity leaves exactly it, so it cannot double count MinorityInterest.
function withMezzanineIdentity<F extends BridgeFact>(
  part: BridgeComponent<F>,
  facts: EnterpriseValueBridgeFacts<F>,
  noncontrolling: BridgeComponent<F>,
  instant: string,
): BridgeComponent<F> {
  if (part.status !== "tagged" || part.value === 0) {
    return part;
  }
  const assets = valueAt(facts.assets, instant);
  const liabilities = valueAt(facts.liabilities, instant);
  const including = valueAt(facts.stockholdersEquityIncludingNoncontrollingInterest, instant);
  const parent = valueAt(facts.stockholdersEquity, instant);
  const equity =
    including ??
    (parent === undefined || noncontrolling.status === "incomplete"
      ? undefined
      : parent + (noncontrolling.status === "tagged" ? noncontrolling.value : 0));
  if (assets === undefined || liabilities === undefined || equity === undefined) {
    return {
      status: "incomplete",
      reason: `${LABELS.temporaryEquity} (${part.concept}) at ${instant} cannot be checked against assets − liabilities − equity`,
    };
  }
  const residual = assets - liabilities - equity;
  return Math.abs(residual - part.value) > Math.abs(assets) * IDENTITY_TOLERANCE
    ? {
        status: "incomplete",
        reason: `${LABELS.temporaryEquity} (${part.concept}) ${String(part.value)} does not reconcile with assets − liabilities − equity ${String(residual)} at ${instant}`,
      }
    : part;
}

// Resolves the bridge at the cash instant; `publicAt` keeps point-in-time readers off later filings.
export function resolveEnterpriseValueBridge<F extends BridgeFact>(
  facts: EnterpriseValueBridgeFacts<F> | undefined,
  cash: { readonly value: number; readonly periodEnd: string },
  publicAt?: string,
): ResolvedEnterpriseValueBridge<F> {
  if (facts === undefined) {
    const unresolved: BridgeComponent<F> = {
      status: "incomplete",
      reason:
        "EV bridge (short-term investments, noncontrolling interest, preferred stock, temporary equity) is not in this artifact: it resolves only from us-gaap company facts, and artifacts written before its current keys omit it",
    };
    return {
      shortTermInvestments: unresolved,
      noncontrollingInterest: unresolved,
      preferredStock: unresolved,
      temporaryEquity: unresolved,
    };
  }
  const visible = (list: readonly F[]) =>
    publicAt === undefined
      ? list
      : list.filter((fact) => (fact.firstPublicAt ?? fact.filedAt) <= publicAt);
  const shown = Object.fromEntries(
    Object.entries(facts).map(([key, list]) => [key, visible(list)]),
  ) as unknown as EnterpriseValueBridgeFacts<F>;
  const temporaryEquity = component("temporaryEquity", shown.temporaryEquity, cash.periodEnd);
  const noncontrollingInterest = component(
    "noncontrollingInterest",
    shown.noncontrollingInterest,
    cash.periodEnd,
    derivedNoncontrolling(shown, temporaryEquity, cash.periodEnd),
  );
  return {
    shortTermInvestments: withCombinedCheck(
      withCurrentEquitySecurities(
        component(
          "shortTermInvestments",
          shown.shortTermInvestments,
          cash.periodEnd,
          combinedShortTermInvestments(shown.cashAndShortTermInvestments, cash),
        ),
        shown,
        cash,
      ),
      shown.cashAndShortTermInvestments,
      cash,
    ),
    noncontrollingInterest,
    preferredStock: component("preferredStock", shown.preferredStock, cash.periodEnd),
    temporaryEquity: withMezzanineIdentity(
      temporaryEquity,
      shown,
      noncontrollingInterest,
      cash.periodEnd,
    ),
  };
}

export const CURRENT_EQUITY_DISCLOSURE =
  "current equity securities may include holdings under sale restrictions, not cash on hand";

// Lineage rows for a tagged component: the pick, then any added current equity securities.
export function bridgeContributors<F extends BridgeFact>(
  part: Extract<BridgeComponent<F>, { readonly status: "tagged" }>,
): readonly { readonly fact: F; readonly value: number; readonly label: string }[] {
  return part.addend === undefined
    ? [{ fact: part.fact, value: part.value, label: part.concept }]
    : [
        { fact: part.fact, value: part.value - part.addend.value, label: part.fact.concept },
        {
          fact: part.addend,
          value: part.addend.value,
          label: `${part.addend.concept}; ${CURRENT_EQUITY_DISCLOSURE}`,
        },
      ];
}

export function enterpriseValueBridgeMetrics(
  resolved: ResolvedEnterpriseValueBridge,
): Record<string, number | string> {
  return Object.fromEntries(
    ENTERPRISE_VALUE_BRIDGE_KEYS.flatMap((key) => {
      const part = resolved[key];
      if (part.status === "incomplete") {
        return [[`${key}IncompleteReason`, part.reason]];
      }
      return [
        [key, part.status === "tagged" ? part.value : 0],
        [`${key}Concept`, part.status === "tagged" ? part.concept : NONE_TAGGED],
      ];
    }),
  );
}

type Metrics = Readonly<Record<string, number | string>> | undefined;

export function bridgeIncompleteReasons(
  metrics: Metrics,
  keys: readonly EnterpriseValueBridgeKey[] = ENTERPRISE_VALUE_BRIDGE_KEYS,
): readonly string[] {
  return keys.flatMap((key) => {
    const reason = readStringMetric(metrics, `${key}IncompleteReason`);
    if (reason !== undefined) {
      return [reason];
    }
    return readNumberMetric(metrics, key) === undefined ? [`${LABELS[key]} unavailable`] : [];
  });
}

export function netDebtFromMetrics(metrics: Metrics): number | undefined {
  const debt = readNumberMetric(metrics, "debt");
  const cash = readNumberMetric(metrics, "cash");
  const shortTermInvestments = readNumberMetric(metrics, "shortTermInvestments");
  return debt === undefined || cash === undefined || shortTermInvestments === undefined
    ? undefined
    : debt - cash - shortTermInvestments;
}

export function enterpriseValueFromMetrics(
  marketCap: number,
  metrics: Metrics,
): number | undefined {
  const netDebt = netDebtFromMetrics(metrics);
  const noncontrollingInterest = readNumberMetric(metrics, "noncontrollingInterest");
  const preferredStock = readNumberMetric(metrics, "preferredStock");
  const temporaryEquity = readNumberMetric(metrics, "temporaryEquity");
  return netDebt === undefined ||
    noncontrollingInterest === undefined ||
    preferredStock === undefined ||
    temporaryEquity === undefined
    ? undefined
    : marketCap + netDebt + noncontrollingInterest + preferredStock + temporaryEquity;
}

export function copyBridgeMetrics(metrics: Metrics): Record<string, number | string> {
  return Object.fromEntries(
    Object.entries(metrics ?? {}).filter(([key]) =>
      ENTERPRISE_VALUE_BRIDGE_KEYS.some(
        (bridgeKey) =>
          key === bridgeKey ||
          key === `${bridgeKey}Concept` ||
          key === `${bridgeKey}IncompleteReason`,
      ),
    ),
  );
}
