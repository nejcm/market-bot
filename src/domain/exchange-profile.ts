// Exchange-specific facts the non-SEC path needs; an exchange without a row keeps US proxies with a gap.
export interface ExchangeProfile {
  readonly exchange: string;
  readonly suffix: string;
  readonly benchmark: string;
  readonly benchmarkName: string;
  readonly currency: string;
  // Hosts whose pages count as issuer report text (ADR 0006): the exchange's own, then allowlisted mirrors.
  readonly reportHosts: {
    readonly primary: readonly string[];
    readonly mirror: readonly string[];
  };
}

export type IssuerReportHostKind = "primary" | "mirror";

const EXCHANGE_PROFILES: readonly ExchangeProfile[] = [
  {
    exchange: "Bursa Malaysia",
    suffix: "KL",
    benchmark: "^KLSE",
    benchmarkName: "FTSE Bursa Malaysia KLCI",
    currency: "MYR",
    reportHosts: {
      primary: ["bursamalaysia.com"],
      mirror: ["klsescreener.com", "marketscreener.com"],
    },
  },
];

export function exchangeProfileFor(symbol: string): ExchangeProfile | undefined {
  const suffix = symbol.toUpperCase().match(/\.([A-Z]{1,4})$/u)?.[1];
  return EXCHANGE_PROFILES.find((profile) => profile.suffix === suffix);
}

export function issuerReportHostKind(
  profile: ExchangeProfile,
  url: string | undefined,
): IssuerReportHostKind | undefined {
  const host = URL.parse(url ?? "")?.hostname.toLowerCase();
  if (host === undefined) {
    return undefined;
  }
  const matches = (allowed: string): boolean => host === allowed || host.endsWith(`.${allowed}`);
  if (profile.reportHosts.primary.some(matches)) {
    return "primary";
  }
  return profile.reportHosts.mirror.some(matches) ? "mirror" : undefined;
}
