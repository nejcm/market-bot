import type { RunConfig } from "../types";
import { cryptoProfile } from "./crypto";
import { equityProfile } from "./equity";
import { marketOverviewCryptoProfile } from "./market-overview-crypto";
import { marketOverviewEquityProfile } from "./market-overview-equity";
import { researchEquityProfile } from "./research-equity";

export const runConfig: RunConfig = {
  "market-overview-equity": marketOverviewEquityProfile,
  "market-overview-crypto": marketOverviewCryptoProfile,
  equity: equityProfile,
  crypto: cryptoProfile,
  "research-equity": researchEquityProfile,
};
