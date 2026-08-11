import { describe, expect, test } from "bun:test";
import {
  loadAppSettings,
  saveAppSettings,
  type AppSettingsStore,
} from "../app/client/app-settings";

const STORAGE_KEY = "market-bot:app-settings";

interface MemoryStore extends AppSettingsStore {
  readonly entries: Map<string, string>;
}

function memoryStore(initial: Record<string, string> = {}): MemoryStore {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

describe("app settings", () => {
  test("round-trips report detail and source visibility", () => {
    for (const reportDetail of ["simple", "advanced"] as const) {
      for (const showSources of [false, true]) {
        const store = memoryStore();

        saveAppSettings({ reportDetail, showSources }, store);

        expect(loadAppSettings(store)).toEqual({ reportDetail, showSources });
      }
    }
  });

  test("keeps report detail from a legacy envelope without the sources flag", () => {
    const store = memoryStore({
      [STORAGE_KEY]: JSON.stringify({ v: 1, reportDetail: "advanced" }),
    });

    expect(loadAppSettings(store)).toEqual({ reportDetail: "advanced", showSources: false });
  });

  test("falls back to defaults for a non-boolean sources flag", () => {
    const store = memoryStore({
      [STORAGE_KEY]: JSON.stringify({ v: 1, reportDetail: "advanced", showSources: "yes" }),
    });

    expect(loadAppSettings(store)).toEqual({ reportDetail: "simple", showSources: false });
  });

  test("falls back to simple for corrupt JSON", () => {
    const store = memoryStore({ [STORAGE_KEY]: "{not json" });

    expect(loadAppSettings(store)).toEqual({ reportDetail: "simple", showSources: false });
  });

  test("falls back to simple for an unknown report detail", () => {
    const store = memoryStore({
      [STORAGE_KEY]: JSON.stringify({ v: 1, reportDetail: "full", showSources: true }),
    });

    expect(loadAppSettings(store)).toEqual({ reportDetail: "simple", showSources: false });
  });

  test("falls back to simple for a wrong envelope version", () => {
    const store = memoryStore({
      [STORAGE_KEY]: JSON.stringify({ v: 2, reportDetail: "advanced", showSources: true }),
    });

    expect(loadAppSettings(store)).toEqual({ reportDetail: "simple", showSources: false });
  });

  test("uses defaults and saves silently without a store", () => {
    expect(loadAppSettings(null)).toEqual({ reportDetail: "simple", showSources: false });
    expect(() =>
      saveAppSettings({ reportDetail: "advanced", showSources: true }, null),
    ).not.toThrow();
  });

  test("swallows setItem failures", () => {
    const store: AppSettingsStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
    };

    expect(() =>
      saveAppSettings({ reportDetail: "advanced", showSources: true }, store),
    ).not.toThrow();
  });
});
