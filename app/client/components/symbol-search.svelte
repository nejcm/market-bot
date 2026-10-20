<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import type { SymbolSearchResult } from "../../types";
  import { fetchSymbols } from "../api";

  interface Props {
    readonly onOpenInstrument: (assetClass: string, symbol: string) => void;
  }

  let { onOpenInstrument }: Props = $props();

  let query = $state("");
  let results = $state<readonly SymbolSearchResult[]>([]);
  let loading = $state(false);
  let notice = $state("");
  let requestId = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  function reset(): void {
    query = "";
    results = [];
    loading = false;
    notice = "";
    requestId += 1;
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer);
      searchTimer = undefined;
    }
  }

  function scheduleSearch(value: string): void {
    query = value;
    if (searchTimer !== undefined) {
      clearTimeout(searchTimer);
      searchTimer = undefined;
    }
    const trimmed = value.trim();
    if (trimmed === "") {
      requestId += 1;
      results = [];
      loading = false;
      notice = "";
      return;
    }
    searchTimer = setTimeout(() => void runSearch(trimmed), 250);
  }

  async function runSearch(trimmed: string): Promise<void> {
    const current = ++requestId;
    loading = true;
    notice = "";
    try {
      const next = await fetchSymbols(trimmed);
      if (current !== requestId) {
        return;
      }
      results = next;
      if (next.length === 0) {
        notice = `No SEC-registered ticker matches “${trimmed}”.`;
      }
    } catch (caughtError: unknown) {
      if (current !== requestId) {
        return;
      }
      results = [];
      notice = caughtError instanceof Error ? caughtError.message : String(caughtError);
    } finally {
      if (current === requestId) {
        loading = false;
      }
    }
  }

  function select(result: SymbolSearchResult): void {
    reset();
    onOpenInstrument("equity", result.symbol);
  }

  function submitFirst(): void {
    const [first] = results;
    if (first !== undefined) {
      select(first);
    }
  }
</script>

<div class="relative">
  <Input
    value={query}
    placeholder="Find an SEC-registered equity symbol…"
    aria-label="Find an SEC-registered equity symbol"
    class="bg-background"
    oninput={(event) => scheduleSearch(event.currentTarget.value)}
    onkeydown={(event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitFirst();
      }
    }}
  />
  {#if loading}
    <div class="absolute inset-x-0 top-full z-10 mt-1 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
      Searching…
    </div>
  {:else if results.length > 0}
    <div
      class="absolute inset-x-0 top-full z-10 mt-1 max-h-72 overflow-auto rounded-md border border-border bg-card py-1 shadow-lg"
    >
      {#each results as result (result.symbol)}
        <button
          class="flex w-full items-baseline justify-between gap-3 px-3 py-1.75 text-left transition hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
          onclick={() => select(result)}
        >
          <span class="font-mono text-xs font-medium text-foreground">{result.symbol}</span>
          <span class="min-w-0 truncate text-xs text-muted-foreground">{result.name ?? ""}</span>
        </button>
      {/each}
    </div>
  {/if}
  {#if notice !== ""}
    <div class="mt-1.5 text-[11.5px] text-[#8a8f96]">{notice}</div>
  {/if}
</div>
