<script lang="ts">
  import {
    Activity,
    LayoutGrid,
    List,
    ListFilter,
    Menu,
    Play,
    Search,
    Star,
    Target,
  } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Sheet, SheetContent, SheetTrigger } from "$lib/components/ui/sheet";
  import { Skeleton } from "$lib/components/ui/skeleton";
  import {
    formatDateMinute,
    isFailedRun,
    runCountsLabel,
    runLabel,
    type InstrumentRunHistoryRow,
    type SidebarView,
    type StarredSidebarEntry,
  } from "../view-model";
  import type { View } from "./console-types";
  import type { Star as StarRecord } from "../../types";
  import { instrumentFreshness, type RunFreshness } from "../run-freshness";
  import TickerLogo from "./ticker-logo.svelte";
  import logoUrl from "../../../assets/logo.png";

  interface Props {
    readonly rows: readonly InstrumentRunHistoryRow[];
    readonly runTypes: readonly string[];
    readonly selectedRunId: string;
    readonly loadingRuns: boolean;
    readonly view: View;
    readonly activeJobCount: number;
    readonly queryText: string;
    readonly typeFilter: string;
    readonly expandedGroups: readonly string[];
    readonly stars: readonly StarredSidebarEntry[];
    readonly staleAfterDays: number;
    readonly onQueryChange: (value: string) => void;
    readonly onTypeFilterChange: (value: string) => void;
    readonly onSelectRun: (runId: string) => void;
    readonly onToggleGroup: (groupKey: string) => void;
    readonly onNavigate: (view: SidebarView) => void;
    readonly onOpenInstrument: (assetClass: string, symbol: string) => void;
    readonly onRemoveStar: (star: StarRecord) => void;
    mobileOpen?: boolean | undefined;
  }

  const typeTextMap: Record<string, string> = {
    all: "All",
    "market-overview": "Overview",
    daily: "Daily",
    weekly: "Weekly",
    equity: "Equity",
    crypto: "Crypto",
    "alpha-search": "Alpha",
    research: "Research",
    run: "Other",
  };

  let {
    rows,
    runTypes,
    selectedRunId,
    loadingRuns,
    view,
    activeJobCount,
    queryText,
    typeFilter,
    expandedGroups,
    stars,
    staleAfterDays,
    onQueryChange,
    onTypeFilterChange,
    onSelectRun,
    onToggleGroup,
    onNavigate,
    onOpenInstrument,
    onRemoveStar,
    mobileOpen = $bindable(false),
  }: Props = $props();

  const navItems = $derived([
    {
      key: "dashboard" as SidebarView,
      label: "Dashboard",
      icon: LayoutGrid,
      badge: 0,
    },
    { key: "search" as SidebarView, label: "Search", icon: Search, badge: 0 },
    { key: "jobs" as SidebarView, label: "Jobs", icon: Play, badge: activeJobCount },
    {
      key: "watchlists" as SidebarView,
      label: "Watchlists",
      icon: List,
      badge: 0,
    },
    {
      key: "calibration" as SidebarView,
      label: "Calibration",
      icon: Target,
      badge: 0,
    },
    {
      key: "alpha-cohorts" as SidebarView,
      label: "Alpha Cohorts",
      icon: ListFilter,
      badge: 0,
    },
    { key: "health" as SidebarView, label: "Health", icon: Activity, badge: 0 },
  ]);
  const typeOptions = $derived(["all", ...runTypes]);

  function navigateAndClose(target: SidebarView): void {
    onNavigate(target);
    mobileOpen = false;
  }

  function selectAndClose(runId: string): void {
    onSelectRun(runId);
    mobileOpen = false;
  }

  function openStar(entry: StarredSidebarEntry): void {
    if (entry.star.kind === "run") {
      if (!entry.missing) {
        selectAndClose(entry.star.key);
      }
      return;
    }
    if (entry.assetClass !== undefined && entry.symbol !== undefined) {
      onOpenInstrument(entry.assetClass, entry.symbol);
      mobileOpen = false;
    }
  }

  function starFreshness(entry: StarredSidebarEntry): RunFreshness | undefined {
    const staleness = entry.star.staleness;
    return staleness === undefined
      ? undefined
      : instrumentFreshness(staleness, new Date(), staleAfterDays);
  }

  function starFreshnessTitle(entry: StarredSidebarEntry): string {
    const freshness = starFreshness(entry);
    if (freshness?.state !== "stale") {
      return "";
    }
    if (freshness.reason === "earnings") {
      return `stale: earnings date ${freshness.since} has passed`;
    }
    if (freshness.reason === "age") {
      return `stale: latest successful run older than ${String(staleAfterDays)} days`;
    }
    return "stale: run date unknown";
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

    {#if stars.length > 0}
      <div class="px-4.5 pb-1.5 pt-2">
        <span class="font-mono text-[10px] tracking-widest text-[#6e757d]">STARRED</span>
        <div class="mt-1 space-y-0.5">
          {#each stars as entry}
            {#if entry.missing}
              <div class="flex items-center gap-2 rounded-md px-2.5 py-1.25">
                <Star class="size-3 shrink-0 fill-current text-[#8a6116]" />
                <span class="min-w-0 flex-1 truncate font-mono text-[10.5px] text-[#6e757d]">
                  {entry.label}
                </span>
                <span
                  class="shrink-0 rounded border border-[#d9c89a] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-[#8a6116]"
                >
                  missing
                </span>
                <button
                  class="shrink-0 rounded px-1 py-0.5 font-mono text-[10px] text-[#7f868e] transition hover:bg-[#262c31] hover:text-[#d6dadd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  type="button"
                  aria-label="Remove star from {entry.label}"
                  onclick={() => onRemoveStar(entry.star)}
                >
                  ✕
                </button>
              </div>
            {:else}
              <button
                class="flex w-full items-center gap-2 rounded-md px-2.5 py-1.25 text-left transition hover:bg-[#262c31] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                type="button"
                onclick={() => openStar(entry)}
              >
                <Star class="size-3 shrink-0 fill-current text-[#c9a24b]" />
                <span class="min-w-0 flex-1 truncate text-xs text-[#d6dadd]">{entry.label}</span>
                {#if entry.star.kind === "instrument" && entry.star.staleness !== undefined}
                  {#if starFreshness(entry)?.state === "stale"}
                    <span
                      class="shrink-0 rounded border border-[#d9c89a] px-1 py-px font-mono text-[9px] uppercase tracking-wide text-[#8a6116]"
                      title={starFreshnessTitle(entry)}
                    >
                      stale
                    </span>
                  {:else if starFreshness(entry)?.state === "never-run"}
                    <span class="shrink-0 font-mono text-[9px] text-[#6e757d]">never run</span>
                  {/if}
                {/if}
              </button>
            {/if}
          {/each}
        </div>
      </div>
    {/if}

    <div class="mx-4.5 mb-3 mt-3.5 h-px shrink-0 bg-sidebar-border"></div>

    <div class="px-4.5 pb-2">
      <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
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
      <div class="mt-2 flex gap-1 overflow-auto pb-2">
        {#each typeOptions as type}
          <button
            class="rounded-full border px-2 flex-1 py-0.5 font-mono text-[10px] capitalize transition hover:border-[#4a525a] hover:text-[#d6dadd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring {typeFilter ===
            type
              ? 'border-[#4a525a] bg-sidebar-accent text-[#e8eaec]'
              : 'border-sidebar-border bg-transparent text-[#7f868e]'}"
            type="button"
            onclick={() => onTypeFilterChange(type)}
          >
            {typeTextMap[type] ?? type}
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
      {:else if rows.length === 0}
        <p class="px-3 py-5 text-center text-xs leading-relaxed text-[#6e757d]">
          No runs match.<br />Clear the filter or queue a job.
        </p>
      {:else}
        {#each rows as row}
          {@const isSelected = view === "run" && row.run.runId === selectedRunId}
          {#if row.kind === "past"}
            <button
              class="mb-0.5 ml-2.5 block w-[calc(100%-0.625rem)] rounded-r-md border-l border-sidebar-border py-1.25 pl-3.5 pr-2.5 text-left transition hover:bg-[#262c31] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring {isSelected
                ? 'bg-[#262c31]'
                : 'bg-transparent'}"
              type="button"
              onclick={() => selectAndClose(row.run.runId)}
            >
              <span class="flex items-baseline justify-between gap-2">
                <span
                  class="shrink-0 font-mono text-[10.5px] {isSelected
                    ? 'text-white'
                    : 'text-[#9aa1a8]'}"
                >
                  {formatDateMinute(row.run.generatedAt)}
                </span>
                <span
                  class="flex min-w-0 items-center gap-1.5 font-mono text-[10px] {isSelected
                    ? 'text-[#c7cdd4]'
                    : 'text-[#7f868e]'}"
                >
                  {#if row.run.depth !== undefined}
                    <span
                      class="rounded border border-sidebar-border px-1 py-px text-[9px] uppercase tracking-wide"
                    >
                      {row.run.depth}
                    </span>
                  {/if}
                  <span class="truncate">{runCountsLabel(row.run)}</span>
                </span>
              </span>
            </button>
          {:else}
            {@const group = row.group}
            <div class="mb-0.5 flex items-stretch gap-1">
              <button
                class="min-w-0 flex-1 rounded-md px-2.5 py-2 text-left transition hover:bg-[#262c31] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring {isSelected
                  ? 'bg-[#262c31]'
                  : 'bg-transparent'}"
                type="button"
                onclick={() => selectAndClose(row.run.runId)}
              >
                <span class="flex items-baseline justify-between gap-2">
                  <span
                    class="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium {isSelected
                      ? 'text-white'
                      : 'text-[#d6dadd]'}"
                  >
                    {#if row.run.assetClass === "equity"}
                      <TickerLogo symbol={row.run.symbol} class="size-4" />
                    {/if}
                    <span class="truncate">{runLabel(row.run)}</span>
                  </span>
                  {#if isFailedRun(row.run)}
                    <span
                      class="shrink-0 rounded border border-red-900/60 bg-red-950/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-red-300"
                    >failed</span>
                  {:else}
                    <span class="shrink-0 font-mono text-[10px] text-[#6e757d]">
                      {formatDateMinute(row.run.generatedAt)}
                    </span>
                  {/if}
                </span>
                <span
                  class="mt-1 flex items-baseline justify-between gap-2 font-mono text-[10px] text-[#7f868e]"
                >
                  <span class="truncate">{runCountsLabel(row.run)}</span>
                  {#if row.run.depth !== undefined}
                    <span
                      class="shrink-0 rounded border border-sidebar-border px-1 py-px text-[9px] uppercase tracking-wide text-[#9aa1a8]"
                    >
                      {row.run.depth}
                    </span>
                  {/if}
                </span>
              </button>
              {#if group !== undefined && group.pastRuns.length > 0}
                <button
                  class="flex shrink-0 min-w-10 text-center justify-center items-center gap-1 rounded-md px-1 font-mono text-[10px] text-[#7f868e] transition hover:bg-[#262c31] hover:text-[#d6dadd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                  type="button"
                  aria-expanded={row.expanded === true}
                  aria-label="{row.expanded === true ? 'Collapse' : 'Expand'} {String(
                    group.pastRuns.length,
                  )} past {group.pastRuns.length === 1 ? "run" : "runs"} for {runLabel(row.run)}"
                  onclick={() => onToggleGroup(group.key)}
                >
                  <span
                    class="inline-block transition-transform {row.expanded === true
                      ? 'rotate-90'
                      : ''}"
                  >❭</span>
                  {group.pastRuns.length}
                </button>
              {/if}
            </div>
          {/if}
        {/each}
      {/if}
    </div>
  </div>
{/snippet}

<aside
  class="hidden h-screen w-81.5 shrink-0 border-r border-[#14171a] bg-sidebar lg:sticky lg:top-0 lg:block"
>
  {@render content()}
</aside>

<!-- The run workspace carries its own trigger in the sticky run nav, so this
     bar stands down there; the sheet itself stays mounted and portalled. -->
<div
  class="fixed top-0 z-30 w-full border-b border-border bg-background/95 px-3 py-2 backdrop-blur lg:hidden {view ===
  'run'
    ? 'hidden'
    : ''}"
>
  <Sheet bind:open={mobileOpen}>
    <SheetTrigger>
      {#snippet child({ props })}
        <Button variant="outline" size="sm" {...props}>
          <Menu class="size-4" />
          Menu
        </Button>
      {/snippet}
    </SheetTrigger>
    <SheetContent
      side="left"
      class="w-81.5 border-sidebar-border bg-sidebar p-0 [&>[data-slot=sheet-close]]:text-[#9aa1a8] [&>[data-slot=sheet-close]:hover]:bg-[#262c31] [&>[data-slot=sheet-close]:hover]:text-white"
    >
      {@render content()}
    </SheetContent>
  </Sheet>
</div>
