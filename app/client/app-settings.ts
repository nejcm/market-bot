const STORAGE_KEY = "market-bot:app-settings";
const SCHEMA_VERSION = 1;

export type ReportDetail = "simple" | "advanced";

export interface AppSettings {
  reportDetail: ReportDetail;
  showSources: boolean;
}

export interface AppSettingsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface StoredEnvelope {
  readonly v: number;
  readonly reportDetail: ReportDetail;
  readonly showSources?: boolean;
}

function defaultSettings(): AppSettings {
  return { reportDetail: "simple", showSources: false };
}

function defaultStore(): AppSettingsStore | null {
  // Accessing localStorage can throw (private mode, disabled storage).
  // It is also absent outside the browser; fail soft to a null store.
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReportDetail(value: unknown): value is ReportDetail {
  return value === "simple" || value === "advanced";
}

// Source visibility arrived after the first envelope shipped, so a payload
// Without it keeps its report detail and falls back to hidden chips.
function isStoredEnvelope(value: unknown): value is StoredEnvelope {
  return (
    isObject(value) &&
    value.v === SCHEMA_VERSION &&
    isReportDetail(value.reportDetail) &&
    (value.showSources === undefined || typeof value.showSources === "boolean")
  );
}

export function loadAppSettings(store: AppSettingsStore | null = defaultStore()): AppSettings {
  if (store === null) {
    return defaultSettings();
  }
  const raw = store.getItem(STORAGE_KEY);
  if (raw === null) {
    return defaultSettings();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredEnvelope(parsed)
      ? { reportDetail: parsed.reportDetail, showSources: parsed.showSources ?? false }
      : defaultSettings();
  } catch {
    return defaultSettings();
  }
}

export function saveAppSettings(settings: AppSettings, store?: AppSettingsStore | null): void {
  const target = store === undefined ? defaultStore() : store;
  if (target === null) {
    return;
  }
  const envelope: StoredEnvelope = {
    v: SCHEMA_VERSION,
    reportDetail: settings.reportDetail,
    showSources: settings.showSources,
  };
  try {
    target.setItem(STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Persistence is best-effort; storage failures must not break the UI.
  }
}
