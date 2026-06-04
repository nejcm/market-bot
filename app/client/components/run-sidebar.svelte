<script lang="ts">
  import { Clock, FileSearch, History, Menu, Search } from "@lucide/svelte";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Sheet from "$lib/components/ui/sheet";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { formatDate, runLabel } from "../view-model";
  import type { RunSummary } from "../../types";

  interface Props {
    readonly runs: readonly RunSummary[];
    readonly selectedRunId: string;
    readonly loadingRuns: boolean;
    readonly queryText: string;
    readonly onQueryChange: (value: string) => void;
    readonly onSelectRun: (runId: string) => void;
  }

  let {
    runs,
    selectedRunId,
    loadingRuns,
    queryText,
    onQueryChange,
    onSelectRun,
  }: Props = $props();

  let mobileOpen = $state(false);

  function selectAndClose(runId: string): void {
    onSelectRun(runId);
    mobileOpen = false;
  }
</script>

{#snippet content()}
  <div class="flex h-full flex-col gap-4 bg-sidebar p-4 text-sidebar-foreground">
    <div class="space-y-1">
      <div class="flex items-center gap-2 text-xs uppercase tracking-wider text-cyan-200/70">
        <FileSearch class="size-4" />
        Market Bot
      </div>
      <h1 class="text-lg font-semibold tracking-normal">Research Console App</h1>
    </div>

    <label class="space-y-2">
      <span class="text-xs font-medium text-cyan-100/80">Search runs</span>
      <div class="relative">
        <Search class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-cyan-100/45" />
        <Input
          class="border-sidebar-border bg-sidebar-accent pl-8 text-sidebar-foreground placeholder:text-cyan-100/40"
          value={queryText}
          placeholder="ticker, asset, job"
          oninput={(event) => onQueryChange(event.currentTarget.value)}
        />
      </div>
    </label>

    <div class="flex items-center justify-between border-t border-sidebar-border pt-3">
      <div class="flex items-center gap-2 text-sm font-medium">
        <History class="size-4 text-cyan-300" />
        Run history
      </div>
      <Badge variant="outline" class="border-cyan-300/25 bg-cyan-300/10 text-cyan-100">
        {runs.length}
      </Badge>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto pr-1">
      {#if loadingRuns}
        <div class="space-y-2">
          {#each Array.from({ length: 6 }) as _}
            <Skeleton class="h-20 rounded-md bg-sidebar-accent" />
          {/each}
        </div>
      {:else if runs.length === 0}
        <p class="rounded-md border border-sidebar-border bg-sidebar-accent p-3 text-sm text-cyan-100/70">
          No matching runs.
        </p>
      {:else}
        <div class="space-y-2">
          {#each runs as run}
            <button
              class="w-full rounded-md border p-3 text-left transition hover:border-cyan-300/40 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring {run.runId ===
              selectedRunId
                ? 'border-cyan-300/55 bg-sidebar-accent'
                : 'border-sidebar-border bg-transparent'}"
              type="button"
              onclick={() => selectAndClose(run.runId)}
            >
              <span class="block truncate text-sm font-medium">{runLabel(run)}</span>
              <span class="mt-1 flex items-center gap-1 text-xs text-cyan-100/60">
                <Clock class="size-3" />
                {formatDate(run.generatedAt)}
              </span>
              <span class="mt-2 block text-xs text-cyan-100/65">
                {run.findingCount} findings / {run.predictionCount} forecasts / {run.dataGapCount} gaps
              </span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  </div>
{/snippet}

<aside class="hidden min-h-screen w-[310px] shrink-0 border-r border-sidebar-border bg-sidebar lg:block">
  {@render content()}
</aside>

<div class="sticky top-0 z-30 border-b border-border bg-background/95 px-3 py-2 backdrop-blur lg:hidden">
  <Sheet.Sheet bind:open={mobileOpen}>
    <Sheet.SheetTrigger>
      {#snippet child({ props })}
        <Button variant="outline" size="sm" {...props}>
          <Menu class="size-4" />
          Runs
        </Button>
      {/snippet}
    </Sheet.SheetTrigger>
    <Sheet.SheetContent side="left" class="w-[310px] border-sidebar-border bg-sidebar p-0">
      {@render content()}
    </Sheet.SheetContent>
  </Sheet.Sheet>
</div>
