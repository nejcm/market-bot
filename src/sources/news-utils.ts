import type { ResearchCommand } from "../cli/args";

const TRACKING_PARAMS = new Set(["fbclid", "gclid", "igshid", "mc_cid", "mc_eid", "ref", "spm"]);

export function encodeQuery(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export function newsQuery(command: ResearchCommand): string {
  if (command.jobType === "ticker") {
    return command.symbol;
  }

  return command.assetClass === "equity" ? "stock market" : "crypto market";
}

export function recencyDays(command: ResearchCommand): number {
  if (command.jobType === "daily") {
    return 3;
  }

  if (command.jobType === "weekly") {
    return 10;
  }

  return 30;
}

export function dateDaysBefore(fetchedAt: string, days: number): Date {
  const date = new Date(fetchedAt);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

export function ymd(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function canonicalizeUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./u, "");

    const sorted = new URLSearchParams();
    [...url.searchParams.entries()]
      .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !TRACKING_PARAMS.has(key))
      .toSorted(([left], [right]) => left.localeCompare(right))
      .forEach(([key, paramValue]) => sorted.append(key, paramValue));
    url.search = sorted.toString();

    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/u, "");
    }

    return url.toString();
  } catch {
    return value.trim();
  }
}
