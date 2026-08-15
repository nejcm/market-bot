import { isRecord } from "../../guards";
import type { SecMetricKey } from "./financial-lens-canonical";

// The issuer's own SIC lives on the sec-edgar item and nowhere else.
// Reading it is scoped to that category for the same reason readSecStringMetric in
// Financial-lens.ts is: an unscoped sweep over every extendedEvidence item would also match a
// Peer's classification (valuation comps carry peer SICs) and silently classify the issuer as
// Whatever a peer happens to be.
// `satisfies` keeps the key bound to the sec-edgar metric union at compile time even though the
// Value arrives as unknown — a report read back from disk is untyped.
const SEC_SIC_METRIC_KEY = "sic" satisfies SecMetricKey;

// SIC major group 60 *is* "Depository Institutions", so the group prefix is the classification
// Rather than an enumeration of 6021/6022/6029 (commercial banks), 6035/6036 (savings
// Institutions) and 6099: a thrift and a commercial bank then classify identically, and a 60xx
// Code nobody listed here still classifies correctly.
// Two deposit-funded forms SEC numbers outside group 60 join them: 6120 savings & loan
// Associations, and 6712 offices of bank holding companies, whose consolidated statements are a
// Bank's.
// The rest of major group 61 stays out. Nondepository credit institutions fund themselves in the
// Capital markets, so the operating/financing split holds and enterprise value stays well defined
// For them — 6199 in particular is the code MARA files under, and its EV/revenue is meaningful.
const DEPOSITORY_SIC_CODES_OUTSIDE_MAJOR_GROUP_60 = new Set(["6120", "6712"]);

// A prefix rule is only safe on a well-formed code: "60", "60x" and "60000" all start with "60"
// Without being depository SIC codes, and treating malformed upstream data as a bank would
// Suppress valid metrics. sec-edgar.ts already pads to four digits, so anything else is malformed.
const FOUR_DIGIT_SIC = /^\d{4}$/u;

// Whether a SIC code is a depository institution's. The single definition of the set; callers that
// Already hold the issuer's own SIC use this, callers holding evidence use depositoryIssuerSic.
function isDepositorySic(sic: string | undefined): boolean {
  return (
    sic !== undefined &&
    FOUR_DIGIT_SIC.test(sic) &&
    (sic.startsWith("60") || DEPOSITORY_SIC_CODES_OUTSIDE_MAJOR_GROUP_60.has(sic))
  );
}

// The issuer's SIC when it is a depository institution, otherwise undefined.
// The single predicate for "is a depository issuer" — nothing else may decide this independently.
// Five call sites evaluate it (collector's peer gate, valuation, valuation-workbench, reverse-dcf,
// Equity-reader). They agree because canonicalization replaces the sec-edgar item in place and
// Later stages only append, so every site sees the same issuer SIC; keep that true when reordering
// The evidence chain.
// Takes `unknown` because callers hand it evidence of different provenance: the collector passes a
// Typed ExtendedEvidence, the report layer passes the extendedEvidence field of a report JSON read
// Back from disk.
export function depositoryIssuerSic(extendedEvidence: unknown): string | undefined {
  const items =
    isRecord(extendedEvidence) && Array.isArray(extendedEvidence.items)
      ? extendedEvidence.items
      : [];
  for (const item of items) {
    if (!isRecord(item) || item.category !== "sec-edgar" || !isRecord(item.metrics)) {
      continue;
    }
    const sic = item.metrics[SEC_SIC_METRIC_KEY];
    if (typeof sic !== "string") {
      continue;
    }
    return isDepositorySic(sic) ? sic : undefined;
  }
  return undefined;
}
