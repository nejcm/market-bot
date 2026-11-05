// Exchange-specific facts the non-SEC path needs; an exchange without a row keeps US proxies with a gap.
export interface ExchangeProfile {
  readonly exchange: string;
  readonly suffix: string;
  readonly benchmark: string;
  readonly benchmarkName: string;
  readonly currency: string;
}

const EXCHANGE_PROFILES: readonly ExchangeProfile[] = [
  {
    exchange: "Bursa Malaysia",
    suffix: "KL",
    benchmark: "^KLSE",
    benchmarkName: "FTSE Bursa Malaysia KLCI",
    currency: "MYR",
  },
];

export function exchangeProfileFor(symbol: string): ExchangeProfile | undefined {
  const suffix = symbol.toUpperCase().match(/\.([A-Z]{1,4})$/u)?.[1];
  return EXCHANGE_PROFILES.find((profile) => profile.suffix === suffix);
}
