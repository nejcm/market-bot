<script lang="ts">
  import { History, Menu, Search } from "@lucide/svelte";
  import logoUrl from "../../../assets/logo.png";
  import { Badge } from "$lib/components/ui/badge";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Sheet from "$lib/components/ui/sheet";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import * as Tabs from "$lib/components/ui/tabs";
  import { formatDateMinute, groupedRunsByType, runLabel } from "../view-model";
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
  let activeRunType = $state("");
  const runGroups = $derived(groupedRunsByType(runs));
  const searchActive = $derived(queryText.trim() !== "");

  $effect(() => {
    if (searchActive || runGroups.length === 0) {
      return;
    }

    if (!runGroups.some((group) => group.type === activeRunType)) {
      activeRunType = runGroups[0]?.type ?? "";
    }
  });

  function selectAndClose(runId: string): void {
    onSelectRun(runId);
    mobileOpen = false;
  }
</script>

{#snippet runButton(run: RunSummary)}
  <button
    class="w-full rounded-md border px-2.5 py-1.5 text-left transition hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring {run.runId ===
    selectedRunId
      ? 'border-sidebar-primary bg-sidebar-primary/10'
      : 'border-sidebar-border bg-transparent'}"
    type="button"
    onclick={() => selectAndClose(run.runId)}
  >
    <span class="flex items-baseline justify-between gap-2">
      <span class="truncate text-sm font-medium">{runLabel(run)}</span>
      <span class="shrink-0 text-xs text-sidebar-foreground/55">
        {formatDateMinute(run.generatedAt)}
      </span>
    </span>
    <span class="mt-0.5 block text-xs text-sidebar-foreground/60">
      {run.findingCount} findings / {run.predictionCount} forecasts / {run.dataGapCount}
      gaps
    </span>
  </button>
{/snippet}

{#snippet content()}
  <div
    class="flex h-full flex-col gap-4 bg-sidebar p-4 text-sidebar-foreground"
  >
    <a
      class="flex items-center gap-2 rounded-md text-sidebar-foreground transition hover:text-sidebar-foreground/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      href="/"
    >
      <img class="size-8 shrink-0" src={logoUrl} alt="" />
      <h1 class="text-lg font-semibold tracking-normal">
        Research Console App
      </h1>
    </a>

    <label class="space-y-2">
      <span class="text-xs font-medium text-sidebar-foreground/70"
        >Search runs</span
      >
      <div class="relative">
        <Search
          class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-sidebar-foreground/45"
        />
        <Input
          class="border-sidebar-border bg-sidebar-accent pl-8 text-sidebar-foreground placeholder:text-sidebar-foreground/40"
          value={queryText}
          placeholder="ticker, asset, job"
          oninput={(event) => onQueryChange(event.currentTarget.value)}
        />
      </div>
    </label>

    <div
      class="flex items-center justify-between border-t border-sidebar-border pt-3"
    >
      <div class="flex items-center gap-2 text-sm font-medium">
        <History class="size-4 text-sidebar-foreground/70" />
        Run history
      </div>
      <Badge
        variant="outline"
        class="border-sidebar-border bg-sidebar-accent text-sidebar-foreground"
      >
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
        <p
          class="rounded-md border border-sidebar-border bg-sidebar-accent p-3 text-sm text-sidebar-foreground/70"
        >
          No matching runs.
        </p>
      {:else}
        <div class="space-y-2">
          {#if searchActive}
            {#each runs as run}
              {@render runButton(run)}
            {/each}
          {:else}
            <Tabs.Tabs value={activeRunType} class="gap-3">
              <Tabs.TabsList
                class="h-auto w-full gap-1 rounded-full border border-sidebar-border bg-sidebar-accent p-1"
              >
                {#each runGroups as group}
                  <Tabs.TabsTrigger
                    value={group.type}
                    onclick={() => (activeRunType = group.type)}
                    class="flex-1 rounded-full px-2.5 py-1 text-xs capitalize hover:text-sidebar-foreground/80 {activeRunType ===
                    group.type
                      ? 'bg-white text-foreground shadow-sm'
                      : 'text-sidebar-foreground'}"
                  >
                    {group.type}
                    <span
                      class={activeRunType === group.type
                        ? "text-foreground/80"
                        : "text-sidebar-foreground/45"}
                      >{group.runs.length}</span
                    >
                  </Tabs.TabsTrigger>
                {/each}
              </Tabs.TabsList>

              {#each runGroups as group}
                <Tabs.TabsContent value={group.type} class="mt-0 space-y-2">
                  {#each group.runs as run}
                    {@render runButton(run)}
                  {/each}
                </Tabs.TabsContent>
              {/each}
            </Tabs.Tabs>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/snippet}

<aside
  class="hidden min-h-screen w-77.5 shrink-0 border-r border-sidebar-border bg-sidebar lg:block"
>
  {@render content()}
</aside>

<div
  class="sticky top-0 z-30 border-b border-border bg-background/95 px-3 py-2 backdrop-blur lg:hidden"
>
  <Sheet.Sheet bind:open={mobileOpen}>
    <Sheet.SheetTrigger>
      {#snippet child({ props })}
        <Button variant="outline" size="sm" {...props}>
          <Menu class="size-4" />
          Runs
        </Button>
      {/snippet}
    </Sheet.SheetTrigger>
    <Sheet.SheetContent
      side="left"
      class="w-[310px] border-sidebar-border bg-sidebar p-0"
    >
      {@render content()}
    </Sheet.SheetContent>
  </Sheet.Sheet>
</div>
