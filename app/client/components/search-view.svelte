<script lang="ts">
  import { Input } from "$lib/components/ui/input";
  import {
    ASSET_CLASS_OPTIONS,
    SEARCH_JOB_TYPE_OPTIONS,
  } from "../../../src/cli/job-registry";
  import type { RunSearchResult } from "../../types";
  import { formatDateMinute, groupedSearchResults, runLabel } from "../view-model";
  import type { SearchFormField, SearchFormState } from "./console-types";
  import SelectField from "./select-field.svelte";

  interface Props {
    readonly searchResults: readonly RunSearchResult[];
    readonly searchLoading: boolean;
    readonly searchNotice: string;
    readonly searchForm: SearchFormState;
    readonly hasSearched: boolean;
    readonly onRunSearch: () => void;
    readonly onOpenSearchResult: (result: RunSearchResult) => void;
    readonly onSearchFormChange: (field: SearchFormField, value: string) => void;
  }

  let {
    searchResults,
    searchLoading,
    searchNotice,
    searchForm,
    hasSearched,
    onRunSearch,
    onOpenSearchResult,
    onSearchFormChange,
  }: Props = $props();

  const searchGroups = $derived(groupedSearchResults(searchResults));
</script>

<div class="mx-auto max-w-230" data-screen-label="Search">
  <h1 class="text-xl font-semibold tracking-tight">Search</h1>
  <div class="mt-1 text-[12.5px] text-[#5c6066]">
    Searches report sections across all runs on disk.
  </div>

  <form
    class="mt-4.5 rounded-lg border border-border bg-card px-4.5 py-4"
    onsubmit={(event) => {
      event.preventDefault();
      onRunSearch();
    }}
  >
    <div class="flex gap-2.5">
      <Input
        class="flex-1 bg-background"
        value={searchForm.query}
        placeholder="e.g. capex, breadth, term premium…"
        oninput={(event) => onSearchFormChange("query", event.currentTarget.value)}
      />
      <button
        class="rounded-md bg-primary px-4.5 py-2 text-[12.5px] font-semibold text-primary-foreground transition hover:bg-[#135f6c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-60"
        type="submit"
        disabled={searchLoading}
      >
        Search
      </button>
    </div>
    <div class="mt-2.5 flex flex-wrap gap-2">
      <Input
        class="h-8 w-32 bg-background font-mono text-xs"
        value={searchForm.symbol}
        placeholder="any symbol"
        aria-label="Symbol"
        oninput={(event) => onSearchFormChange("symbol", event.currentTarget.value)}
      />
      <SelectField
        label=""
        value={searchForm.assetClass}
        options={["", ...ASSET_CLASS_OPTIONS]}
        onChange={(value) => onSearchFormChange("assetClass", value)}
      />
      <SelectField
        label=""
        value={searchForm.jobType}
        options={SEARCH_JOB_TYPE_OPTIONS}
        onChange={(value) => onSearchFormChange("jobType", value)}
      />
      <Input
        class="h-8 w-36 bg-background text-xs"
        type="date"
        value={searchForm.from}
        aria-label="From date"
        oninput={(event) => onSearchFormChange("from", event.currentTarget.value)}
      />
      <Input
        class="h-8 w-36 bg-background text-xs"
        type="date"
        value={searchForm.to}
        aria-label="To date"
        oninput={(event) => onSearchFormChange("to", event.currentTarget.value)}
      />
    </div>
  </form>

  {#if searchLoading}
    <div class="mt-9 text-center text-[13px] text-muted-foreground">Searching reports…</div>
  {:else if !hasSearched}
    <div class="mt-9 text-center text-[13px] leading-relaxed text-muted-foreground">
      Type a query and press Enter.<br />
      <span class="font-mono text-[11px]">search covers findings, cases, risks, catalysts, forecasts and gaps</span>
    </div>
  {:else if searchNotice !== ""}
    <div
      class="mt-9 rounded-lg border border-dashed border-input p-9 text-center text-[13px] text-muted-foreground"
    >
      {searchNotice}
    </div>
  {:else}
    {#each searchGroups as group}
      <div class="mt-6">
        <div class="flex items-baseline gap-2.5">
          <span class="text-[13px] font-semibold">{runLabel(group.run)}</span>
          <span class="font-mono text-[10.5px] text-muted-foreground">
            {formatDateMinute(group.run.generatedAt)}
          </span>
          <span class="font-mono text-[10.5px] text-[#a8acb1]">
            {group.results.length}
            {group.results.length === 1 ? "hit" : "hits"}
          </span>
        </div>
        <div class="mt-2 overflow-hidden rounded-lg border border-border bg-card">
          {#each group.results as result}
            <div
              class="flex items-start gap-3.5 border-b border-[#f0ede7] px-4 py-3 last:border-b-0"
            >
              <span
                class="mt-0.5 shrink-0 rounded border border-border bg-secondary px-1.75 py-0.5 font-mono text-[10px] text-[#5c6066]"
              >
                {result.section}
              </span>
              <div class="min-w-0 flex-1 font-serif text-[13.5px] leading-[1.55] text-[#2a2d30]">
                {result.snippet}
              </div>
              <button
                class="shrink-0 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                type="button"
                onclick={() => onOpenSearchResult(result)}
              >
                open →
              </button>
            </div>
          {/each}
        </div>
      </div>
    {/each}
  {/if}
</div>
