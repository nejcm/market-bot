<script lang="ts">
  import { ArrowDown, ArrowUp, Play, Plus, Trash2, X } from "@lucide/svelte";
  import { Input } from "$lib/components/ui/input";
  import type {
    ConsoleJob,
    WatchlistDetail,
    WatchlistItem,
    WatchlistSummary,
  } from "../../types";
  import { deepEquityJobForSymbol, formatAge, formatDate, formatDateMinute } from "../view-model";
  import TickerLogo from "./ticker-logo.svelte";

  interface Props {
    readonly lists: readonly WatchlistSummary[];
    readonly selectedId: number | null;
    readonly detail: WatchlistDetail | null;
    readonly loading: boolean;
    readonly loadError: string;
    readonly jobs: readonly ConsoleJob[];
    readonly onSelectList: (id: number) => void;
    readonly onCreate: (name: string) => void;
    readonly onRename: (id: number, name: string) => void;
    readonly onDelete: (id: number) => void;
    readonly onAddItem: (symbol: string) => void;
    readonly onRemoveItem: (symbol: string) => void;
    readonly onMoveItem: (index: number, direction: -1 | 1) => void;
    readonly onQueueDeepEquity: (symbol: string) => void;
    readonly onOpenInstrument: (assetClass: string, symbol: string) => void;
  }

  let {
    lists,
    selectedId,
    detail,
    loading,
    loadError,
    jobs,
    onSelectList,
    onCreate,
    onRename,
    onDelete,
    onAddItem,
    onRemoveItem,
    onMoveItem,
    onQueueDeepEquity,
    onOpenInstrument,
  }: Props = $props();

  let newName = $state("");
  let addSymbol = $state("");
  let editingId = $state<number | null>(null);
  let editingName = $state("");

  const selected = $derived(lists.find((list) => list.id === selectedId) ?? null);
  const selectedDetail = $derived(
    detail !== null && detail.id === selectedId ? detail : null,
  );

  function submitCreate(): void {
    const name = newName.trim();
    if (name === "") {
      return;
    }
    onCreate(name);
    newName = "";
  }

  function submitRename(): void {
    if (selectedId === null) {
      return;
    }
    const name = editingName.trim();
    if (name === "") {
      editingId = null;
      return;
    }
    onRename(selectedId, name);
    editingId = null;
  }

  function submitAddItem(): void {
    const symbol = addSymbol.trim().toUpperCase();
    if (symbol === "") {
      return;
    }
    onAddItem(symbol);
    addSymbol = "";
  }

  function confirmQueueDeepEquity(symbol: string): void {
    if (
      globalThis.confirm(
        `Queue a deep equity run for ${symbol}? A deep run takes about 12 minutes and uses roughly 438k live model tokens.`,
      )
    ) {
      onQueueDeepEquity(symbol);
    }
  }

  function deepEquityJob(symbol: string): ConsoleJob | undefined {
    return deepEquityJobForSymbol(jobs, symbol);
  }

  function latestRunText(item: WatchlistItem): string {
    const {row} = item;
    if (row.state === "never-run") {
      return "never run";
    }
    if (row.state === "index-unavailable") {
      return "index unavailable";
    }
    return `${formatDateMinute(row.latestRunAt)} · ${formatAge(row.latestRunAt)}`;
  }

  function calibrationText(item: WatchlistItem): string {
    const {row} = item;
    if (row.state !== "available" || row.latestCalibration === undefined) {
      return "—";
    }
    return `${row.latestCalibration.outcome} · ${formatDate(row.latestCalibration.at)}`;
  }

  function calibrationClass(item: WatchlistItem): string {
    const {row} = item;
    if (row.state !== "available" || row.latestCalibration === undefined) {
      return "border-border bg-secondary text-[#5c6066]";
    }
    return row.latestCalibration.outcome === "hit"
      ? "border-[#9fc2c8] bg-[#e7f1f3] text-[#166e7d]"
      : "border-border bg-secondary text-[#5c6066]";
  }
</script>

<div data-screen-label="Watchlists">
  <h1 class="text-xl font-semibold tracking-tight">Watchlists</h1>
  <div class="mt-1 text-[12.5px] text-[#5c6066]">
    Named lists of equities with derived run data from the Run Artifact Index.
  </div>

  {#if lists.length === 0}
    {#if loadError !== ""}
      <div
        class="mt-4.5 flex items-start gap-3 rounded-lg border border-[#d9c89a] bg-[#fbf6ea] px-4 py-3"
      >
        <span
          class="mt-px shrink-0 rounded border border-[#d9c89a] bg-[#f5ecd6] px-1.5 py-px font-mono text-[10px] text-[#8a6116]"
        >
          UNAVAILABLE
        </span>
        <span class="text-[12.5px] leading-normal text-[#4a4334]">
          Watchlists could not be loaded: {loadError}
        </span>
      </div>
    {:else}
      <div
        class="mt-4.5 rounded-lg border border-dashed border-input p-9 text-center text-sm text-muted-foreground"
      >
        <p>No watchlists yet.</p>
        <p class="mt-1">Create one to track equities across their latest runs.</p>
        <form
          class="mx-auto mt-4 flex max-w-70 items-center gap-2"
          onsubmit={(event) => {
            event.preventDefault();
            submitCreate();
          }}
        >
          <Input
            class="h-8 bg-background font-mono text-xs"
            value={newName}
            placeholder="Watchlist name"
            oninput={(event) => (newName = event.currentTarget.value)}
          />
          <button
            class="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-3 py-1.75 text-xs font-semibold text-primary-foreground transition hover:bg-[#135f6c] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            type="submit"
          >
            <Plus class="size-3.5" />
            Create
          </button>
        </form>
      </div>
    {/if}
  {:else}
    <div class="mt-4.5 flex flex-wrap items-center gap-1.5">
      {#each lists as list (list.id)}
        <button
          class="rounded-md border px-2.5 py-1.25 font-mono text-[11px] transition hover:border-[#4a525a] hover:text-[#d6dadd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {selectedId ===
          list.id
            ? 'border-[#4a525a] bg-sidebar-accent text-[#e8eaec]'
            : 'border-border bg-transparent text-[#7f868e]'}"
          type="button"
          onclick={() => onSelectList(list.id)}
        >
          {list.name}
        </button>
      {/each}
      <form
        class="ml-1 flex items-center gap-1.5"
        onsubmit={(event) => {
          event.preventDefault();
          submitCreate();
        }}
      >
        <Input
          class="h-7.5 w-36 bg-background font-mono text-[11px]"
          value={newName}
          placeholder="New list…"
          oninput={(event) => (newName = event.currentTarget.value)}
        />
        <button
          class="flex shrink-0 items-center gap-1 rounded-md border border-input bg-secondary px-2 py-1 font-mono text-[10.5px] text-foreground transition hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          type="submit"
        >
          <Plus class="size-3" />
          add
        </button>
      </form>
    </div>

    {#if selected === null}
      <div
        class="mt-4 rounded-lg border border-dashed border-input p-9 text-center text-sm text-muted-foreground"
      >
        Select a watchlist.
      </div>
    {:else}
      <div class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
        {#if editingId === selected.id}
          <form
            class="flex items-center gap-1.5"
            onsubmit={(event) => {
              event.preventDefault();
              submitRename();
            }}
          >
            <Input
              class="h-7.5 w-44 bg-background text-xs"
              value={editingName}
              oninput={(event) => (editingName = event.currentTarget.value)}
            />
            <button
              class="rounded border border-[#cfe0e3] bg-accent px-2 py-1 font-mono text-[10px] text-primary transition hover:border-[#9fc2c8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="submit"
            >
              save
            </button>
            <button
              class="rounded border border-input bg-secondary px-2 py-1 font-mono text-[10px] text-foreground transition hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              onclick={() => (editingId = null)}
            >
              cancel
            </button>
          </form>
        {:else}
          <h2 class="text-sm font-semibold">{selected.name}</h2>
          <button
            class="font-mono text-[10px] text-[#7f868e] underline-offset-2 transition hover:text-[#d6dadd] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
            onclick={() => {
              editingId = selected.id;
              editingName = selected.name;
            }}
          >
            rename
          </button>
          <button
            class="flex items-center gap-1 rounded border border-input bg-secondary px-2 py-1 font-mono text-[10px] text-[#8a5a5a] transition hover:border-[#c9a29a] hover:text-[#b04848] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            type="button"
            onclick={() => onDelete(selected.id)}
          >
            <Trash2 class="size-3" />
            delete
          </button>
        {/if}
        <span class="font-mono text-[10.5px] text-muted-foreground">
          {selectedDetail?.items.length ?? 0} item{(selectedDetail?.items.length ?? 0) === 1 ? "" : "s"}
        </span>
      </div>

      <form
        class="mt-3.5 flex items-center gap-2"
        onsubmit={(event) => {
          event.preventDefault();
          submitAddItem();
        }}
      >
        <Input
          class="h-8 w-40 bg-background font-mono text-xs uppercase"
          value={addSymbol}
          placeholder="Symbol, e.g. AAPL"
          oninput={(event) => (addSymbol = event.currentTarget.value)}
        />
        <button
          class="flex items-center gap-1.5 rounded-md border border-[#cfe0e3] bg-accent px-3 py-1.75 font-mono text-[11px] text-primary transition hover:border-[#9fc2c8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          type="submit"
        >
          <Plus class="size-3.5" />
          Add equity
        </button>
      </form>

      <div class="mt-3.5 overflow-x-auto rounded-lg border border-border bg-card" aria-live="polite">
        <div class="min-w-210">
          <div
            class="grid grid-cols-[52px_150px_minmax(0,1fr)_92px_110px_130px_110px_40px] gap-3.5 border-b border-border bg-secondary px-4.5 py-2.5 font-mono text-[10px] tracking-[0.08em] text-muted-foreground"
          >
            <div>ORDER</div>
            <div>SYMBOL</div>
            <div>LATEST RUN</div>
            <div>DEPTH</div>
            <div>OPEN PREDICTIONS</div>
            <div>LATEST CALIBRATION</div>
            <div>QUEUE</div>
            <div></div>
          </div>
          {#if loading && selectedDetail === null}
            <div class="px-4.5 py-6 text-sm text-muted-foreground">Loading watchlist...</div>
          {:else if selectedDetail === null}
            <div class="px-4.5 py-6 text-sm text-muted-foreground">Watchlist unavailable.</div>
          {:else if selectedDetail.items.length === 0}
            <div class="px-4.5 py-6 text-sm text-muted-foreground">
              This watchlist is empty. Add a symbol above.
            </div>
          {:else}
            {#each selectedDetail.items as item, index (item.symbol)}
              <div
                class="grid grid-cols-[52px_150px_minmax(0,1fr)_92px_110px_130px_110px_40px] items-center gap-3.5 border-b border-[#f0ede7] px-4.5 py-2.75 last:border-b-0"
              >
                <div class="flex items-center gap-0.5">
                  <button
                    class="rounded p-0.5 text-[#7f868e] transition hover:bg-[#262c31] hover:text-[#d6dadd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
                    type="button"
                    aria-label="Move {item.symbol} up"
                    disabled={index === 0}
                    onclick={() => onMoveItem(index, -1)}
                  >
                    <ArrowUp class="size-3.5" />
                  </button>
                  <button
                    class="rounded p-0.5 text-[#7f868e] transition hover:bg-[#262c31] hover:text-[#d6dadd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"
                    type="button"
                    aria-label="Move {item.symbol} down"
                    disabled={index === selectedDetail.items.length - 1}
                    onclick={() => onMoveItem(index, 1)}
                  >
                    <ArrowDown class="size-3.5" />
                  </button>
                </div>
                <button
                  class="flex items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  onclick={() => onOpenInstrument(item.assetClass, item.symbol)}
                >
                  <TickerLogo symbol={item.symbol} class="size-4" />
                  <span class="font-mono text-xs text-primary hover:underline">{item.symbol}</span>
                </button>
                <div class="font-mono text-[11px] text-[#5c6066]">{latestRunText(item)}</div>
                <div>
                  {#if item.row.state === "available" && item.row.depth !== undefined}
                    <span
                      class="rounded border border-sidebar-border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-[#9aa1a8]"
                    >
                      {item.row.depth}
                    </span>
                  {:else}
                    <span class="font-mono text-[11px] text-[#8a8f96]">—</span>
                  {/if}
                </div>
                <div class="font-mono text-[11.5px] text-[#5c6066]">
                  {#if item.row.state === "available"}
                    {item.row.openPredictionCount} open
                  {:else}
                    <span class="text-[#8a8f96]">—</span>
                  {/if}
                </div>
                <div>
                  {#if item.row.state === "available" && item.row.latestCalibration !== undefined}
                    <span
                      class="rounded border px-1.75 py-0.5 font-mono text-[10px] {calibrationClass(item)}"
                      title={calibrationText(item)}
                    >
                      {item.row.latestCalibration.outcome}
                    </span>
                  {:else}
                    <span class="font-mono text-[11px] text-[#8a8f96]">—</span>
                  {/if}
                </div>
                <div>
                  {#if deepEquityJob(item.symbol) !== undefined}
                    <span
                      class="rounded-md border border-[#cfe0e3] bg-accent px-2.5 py-1.5 font-mono text-[10.5px] text-primary"
                    >
                      deep equity {deepEquityJob(item.symbol)?.status}
                    </span>
                  {:else}
                    <button
                      class="flex items-center gap-1.5 rounded-md border border-[#cfe0e3] bg-accent px-2 py-1 font-mono text-[10px] text-primary transition hover:border-[#9fc2c8] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      type="button"
                      aria-label="Queue deep equity run for {item.symbol}"
                      onclick={() => confirmQueueDeepEquity(item.symbol)}
                    >
                      <Play class="size-3" />
                      run deep
                    </button>
                  {/if}
                </div>
                <button
                  class="justify-self-end rounded p-1 text-[#7f868e] transition hover:bg-[#262c31] hover:text-[#d6dadd] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  aria-label="Remove {item.symbol} from watchlist"
                  onclick={() => onRemoveItem(item.symbol)}
                >
                  <X class="size-3.5" />
                </button>
              </div>
            {/each}
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>
