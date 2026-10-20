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

        saveAppSettings({ reportDetail, showSources, staleAfterDays: 30 }, store);

        expect(loadAppSettings(store)).toEqual({ reportDetail, showSources, staleAfterDays: 30 });
      }
    }
  });

  test("round-trips a custom staleness threshold", () => {
    const store = memoryStore();

    saveAppSettings({ reportDetail: "simple", showSources: false, staleAfterDays: 14 }, store);

    expect(loadAppSettings(store).staleAfterDays).toBe(14);
  });

  test("keeps report detail from a legacy envelope without the sources flag", () => {
    const store = memoryStore({
      [STORAGE_KEY]: JSON.stringify({ v: 1, reportDetail: "advanced" }),
    });

    expect(loadAppSettings(store)).toEqual({
      reportDetail: "advanced",
      showSources: false,
      staleAfterDays: 30,
    });
  });

  test("falls back to defaults for a non-boolean sources flag", () => {
    const store = memoryStore({
      [STORAGE_KEY]: JSON.stringify({ v: 1, reportDetail: "advanced", showSources: "yes" }),
    });

    expect(loadAppSettings(store)).toEqual({
      reportDetail: "simple",
      showSources: false,
      staleAfterDays: 30,
    });
  });

  test("falls back to defaults for a non-integer or zero staleness threshold", () => {
    for (const staleAfterDays of [0, -1, 1.5, "soon"]) {
      const store = memoryStore({
        [STORAGE_KEY]: JSON.stringify({
          v: 1,
          reportDetail: "advanced",
          showSources: true,
          staleAfterDays,
        }),
      });

      expect(loadAppSettings(store), String(staleAfterDays)).toEqual({
        reportDetail: "simple",
        showSources: false,
        staleAfterDays: 30,
      });
    }
  });

  test("falls back to simple for corrupt JSON", () => {
    const store = memoryStore({ [STORAGE_KEY]: "{not json" });

    expect(loadAppSettings(store)).toEqual({
      reportDetail: "simple",
      showSources: false,
      staleAfterDays: 30,
    });
  });

  test("falls back to simple for an unknown report detail", () => {
    const store = memoryStore({
      [STORAGE_KEY]: JSON.stringify({ v: 1, reportDetail: "full", showSources: true }),
    });

    expect(loadAppSettings(store)).toEqual({
      reportDetail: "simple",
      showSources: false,
      staleAfterDays: 30,
    });
  });

  test("falls back to simple for a wrong envelope version", () => {
    const store = memoryStore({
      [STORAGE_KEY]: JSON.stringify({ v: 2, reportDetail: "advanced", showSources: true }),
    });

    expect(loadAppSettings(store)).toEqual({
      reportDetail: "simple",
      showSources: false,
      staleAfterDays: 30,
    });
  });

  test("uses defaults and saves silently without a store", () => {
    expect(loadAppSettings(null)).toEqual({
      reportDetail: "simple",
      showSources: false,
      staleAfterDays: 30,
    });
    expect(() =>
      saveAppSettings({ reportDetail: "advanced", showSources: true, staleAfterDays: 30 }, null),
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
      saveAppSettings({ reportDetail: "advanced", showSources: true, staleAfterDays: 30 }, store),
    ).not.toThrow();
  });
});
