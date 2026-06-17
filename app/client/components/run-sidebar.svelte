<script lang="ts">
  import { Activity, LayoutGrid, ListFilter, Menu, Play, Search, Target } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import * as Sheet from "$lib/components/ui/sheet";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import { formatDateMinute, runCountsLabel, runLabel } from "../view-model";
  import type { View } from "./console-types";
  import type { RunSummary } from "../../types";
  import logoUrl from "../../../assets/logo.png";

  interface Props {
    readonly runs: readonly RunSummary[];
    readonly runTypes: readonly string[];
    readonly selectedRunId: string;
    readonly loadingRuns: boolean;
    readonly view: View;
    readonly activeJobCount: number;
    readonly queryText: string;
    readonly typeFilter: string;
    readonly onQueryChange: (value: string) => void;
    readonly onTypeFilterChange: (value: string) => void;
    readonly onSelectRun: (runId: string) => void;
    readonly onNavigate: (view: View) => void;
  }

  const typeTextMap: Record<string, string> = {
    all: "All",
    "market-overview": "Overview",
    daily: "Daily",
    weekly: "Weekly",
    ticker: "Ticker",
    "alpha-search": "Alpha",
  };

  let {
    runs,
    runTypes,
    selectedRunId,
    loadingRuns,
    view,
    activeJobCount,
    queryText,
    typeFilter,
    onQueryChange,
    onTypeFilterChange,
    onSelectRun,
    onNavigate,
  }: Props = $props();

  let mobileOpen = $state(false);

  const navItems = $derived([
    {
      key: "dashboard" as View,
      label: "Dashboard",
      icon: LayoutGrid,
      badge: 0,
    },
    { key: "search" as View, label: "Search", icon: Search, badge: 0 },
    { key: "jobs" as View, label: "Jobs", icon: Play, badge: activeJobCount },
    { key: "calibration" as View, label: "Calibration", icon: Target, badge: 0 },
    { key: "alpha-cohorts" as View, label: "Alpha Cohorts", icon: ListFilter, badge: 0 },
    { key: "health" as View, label: "Health", icon: Activity, badge: 0 },
  ]);
  const typeOptions = $derived(["all", ...runTypes]);

  function navigateAndClose(target: View): void {
    onNavigate(target);
    mobileOpen = false;
  }

  function selectAndClose(runId: string): void {
    onSelectRun(runId);
    mobileOpen = false;
  }
</script>

{#snippet content()}
  <div class="flex h-full flex-col bg-sidebar text-sidebar-foreground">
    <button
      class="px-4.5 pb-3.5 pt-4.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      type="button"
      onclick={() => navigateAndClose("dashboard")}
    >
      <span class="flex items-center gap-2">
        <img
          src={logoUrl}
          alt="Research Console logo"
          class="size-5.5 shrink-0 rounded-[5px]"
        />
        <span class="text-sm font-semibold tracking-tight text-[#f2f3f4]"
          >Research Console</span
        >
      </span>
      <span
        class="mt-1.5 block font-mono text-[10px] tracking-wide text-[#6e757d]"
      >
        market-research bot · read-only · local
      </span>
    </button>

    <nav class="flex flex-col gap-px px-2.5">
      {#each navItems as item}
        {@const Icon = item.icon}
        <button
          class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.75 text-left text-xs font-medium transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring {view ===
          item.key
            ? 'bg-sidebar-accent text-[#f2f3f4]'
            : 'text-sidebar-foreground'}"
          type="button"
          onclick={() => navigateAndClose(item.key)}
        >
          <Icon
            class="size-3.5 shrink-0 {view === item.key
              ? 'text-sidebar-primary'
              : 'text-[#6e757d]'}"
          />
          <span class="flex-1">{item.label}</span>
          {#if item.badge > 0}
            <span
              class="rounded-full bg-[#2f363c] px-1.5 py-px font-mono text-[10px] text-[#9aa1a8]"
            >
              {item.badge}
            </span>
          {/if}
        </button>
      {/each}
    </nav>

    <div class="mx-4.5 mb-3 mt-3.5 h-px shrink-0 bg-sidebar-border"></div>

    <div class="px-4.5 pb-2">
      <div class="flex items-baseline justify-between">
        <span class="font-mono text-[10px] tracking-widest text-[#6e757d]"
          >RUNS</span
        >
        <span class="font-mono text-[10px] text-[#565d64]">j / k</span>
      </div>
      <Input
        class="mt-2 h-8 border-sidebar-border bg-[#14171a] text-xs text-[#d6dadd] placeholder:text-sidebar-foreground/40"
        value={queryText}
        placeholder="Filter runs…"
        oninput={(event) => onQueryChange(event.currentTarget.value)}
      />
      <div class="mt-2 flex overflow-auto gap-1">
        {#each typeOptions as type}
          <button
            class="rounded-full border px-2 flex-1 py-0.5 font-mono text-[10px] capitalize transition hover:border-[#4a525a] hover:text-[#d6dadd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring {typeFilter ===
            type
              ? 'border-[#4a525a] bg-sidebar-accent text-[#e8eaec]'
              : 'border-sidebar-border bg-transparent text-[#7f868e]'}"
            type="button"
            onclick={() => onTypeFilterChange(type)}
          >
            {typeTextMap[type]}
          </button>
        {/each}
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4 pt-0.5">
      {#if loadingRuns}
        <div class="space-y-1.5">
          {#each Array.from({ length: 6 }) as _}
            <Skeleton class="h-12 rounded-md bg-sidebar-accent" />
          {/each}
        </div>
      {:else if runs.length === 0}
        <p class="px-3 py-5 text-center text-xs leading-relaxed text-[#6e757d]">
          No runs match.<br />Clear the filter or queue a job.
        </p>
      {:else}
        {#each runs as run}
          <button
            class="mb-0.5 block w-full rounded-md border-l-2 px-2.5 py-2 text-left transition hover:bg-[#262c31] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring {view ===
              'run' && run.runId === selectedRunId
              ? 'border-sidebar-primary bg-[#262c31]'
              : 'border-transparent bg-transparent'}"
            type="button"
            onclick={() => selectAndClose(run.runId)}
          >
            <span class="flex items-baseline justify-between gap-2">
              <span
                class="truncate text-xs font-medium {view === 'run' &&
                run.runId === selectedRunId
                  ? 'text-white'
                  : 'text-[#d6dadd]'}"
              >
                {runLabel(run)}
              </span>
              <span class="shrink-0 font-mono text-[10px] text-[#6e757d]">
                {formatDateMinute(run.generatedAt)}
              </span>
            </span>
            <span class="mt-1 block font-mono text-[10px] text-[#7f868e]">
              {runCountsLabel(run)}
            </span>
          </button>
        {/each}
      {/if}
    </div>
  </div>
{/snippet}

<aside
  class="hidden h-screen w-[320px] shrink-0 border-r border-[#14171a] bg-sidebar lg:sticky lg:top-0 lg:block"
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
          Menu
        </Button>
      {/snippet}
    </Sheet.SheetTrigger>
    <Sheet.SheetContent
      side="left"
      class="w-[320px] border-sidebar-border bg-sidebar p-0"
    >
      {@render content()}
    </Sheet.SheetContent>
  </Sheet.Sheet>
</div>
