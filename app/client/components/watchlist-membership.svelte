<script lang="ts">
  import Bookmark from "@lucide/svelte/icons/bookmark";
  import { Popover } from "bits-ui";
  import {
    addWatchlistItem,
    createWatchlist,
    fetchWatchlistMembership,
    removeWatchlistItem,
  } from "../api";
  import type { WatchlistSummary } from "../../types";

  interface Props {
    readonly symbol: string;
    readonly watchlists: readonly WatchlistSummary[];
    readonly watchlistLoadError: string;
    readonly onChanged: (id: number) => void;
    readonly onOpenWatchlists: () => void;
    readonly size?: "default" | "header";
  }

  let { symbol, watchlists, watchlistLoadError, onChanged, onOpenWatchlists, size = "default" }: Props =
    $props();

  let open = $state(false);
  let memberIds = $state<readonly number[]>([]);
  let loading = $state(false);
  let pendingIds = $state<readonly number[]>([]);
  let creating = $state(false);
  let newName = $state("");
  let error = $state("");
  const membershipLabel = $derived(
    `In ${String(memberIds.length)} watchlist${memberIds.length === 1 ? "" : "s"}`,
  );

  function message(caughtError: unknown): string {
    return caughtError instanceof Error ? caughtError.message : String(caughtError);
  }

  async function loadMembership(target: string): Promise<void> {
    loading = true;
    error = "";
    try {
      const next = await fetchWatchlistMembership(target);
      if (target === symbol) {
        memberIds = next;
      }
    } catch (caughtError: unknown) {
      if (target === symbol) {
        error = message(caughtError);
      }
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void loadMembership(symbol);
  });

  async function toggle(id: number): Promise<void> {
    const member = memberIds.includes(id);
    pendingIds = [...pendingIds, id];
    error = "";
    try {
      await (member ? removeWatchlistItem(id, symbol) : addWatchlistItem(id, symbol));
      memberIds = member ? memberIds.filter((memberId) => memberId !== id) : [...memberIds, id];
      onChanged(id);
    } catch (caughtError: unknown) {
      error = message(caughtError);
    } finally {
      pendingIds = pendingIds.filter((pendingId) => pendingId !== id);
    }
  }

  async function createAndAdd(): Promise<void> {
    const name = newName.trim();
    if (name === "" || creating) {
      return;
    }
    creating = true;
    error = "";
    try {
      const created = await createWatchlist(name);
      newName = "";
      try {
        await addWatchlistItem(created.id, symbol);
        memberIds = [...memberIds, created.id];
      } finally {
        onChanged(created.id);
      }
    } catch (caughtError: unknown) {
      error = message(caughtError);
    } finally {
      creating = false;
    }
  }
</script>

<Popover.Root
  bind:open
  onOpenChange={(next) => {
    if (next) {
      void loadMembership(symbol);
    }
  }}
>
  <Popover.Trigger
    class="flex shrink-0 items-center gap-1.5 border bg-secondary font-mono text-[10.5px] transition hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring {size ===
    'header'
      ? 'size-8.75 justify-center rounded-full border-border text-muted-foreground'
      : 'h-8 rounded-md border-input px-2.5'}"
    aria-label="Watchlists for {symbol}{memberIds.length > 0 ? ` (${membershipLabel})` : ''}"
    title="Watchlists for {symbol}{memberIds.length > 0 ? ` (${membershipLabel})` : ''}"
  >
    <Bookmark
      class="{size === 'header' ? 'size-4' : 'size-3.5'} {memberIds.length > 0 ? 'fill-current text-[#c9a24b]' : ''}"
    />
    {#if size !== "header"}
      {memberIds.length > 0 ? membershipLabel : "Watchlists"}
    {/if}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      align="start"
      sideOffset={6}
      collisionPadding={16}
      onOpenAutoFocus={(event) => event.preventDefault()}
      class="z-50 w-64 rounded-md border border-border bg-popover p-3 text-popover-foreground shadow-md"
    >
      <div class="font-mono text-[10px] tracking-widest text-muted-foreground">WATCHLISTS</div>
      {#if watchlistLoadError !== ""}
        <p class="mt-2 text-[12px] text-[#8a6116]" role="alert">
          Watchlists unavailable: {watchlistLoadError}
        </p>
      {:else if watchlists.length === 0}
        <p class="mt-2 text-[12px] text-muted-foreground">No watchlists yet.</p>
      {:else}
        <ul class="mt-2 max-h-60 space-y-0.5 overflow-y-auto">
          {#each watchlists as list (list.id)}
            <li>
              <label class="flex items-center gap-2 rounded px-1.5 py-1 text-[12.5px] hover:bg-accent">
                <input
                  class="accent-primary"
                  type="checkbox"
                  checked={memberIds.includes(list.id)}
                  disabled={loading || pendingIds.includes(list.id)}
                  onchange={() => void toggle(list.id)}
                />
                <span class="min-w-0 flex-1 truncate">{list.name}</span>
              </label>
            </li>
          {/each}
        </ul>
      {/if}
      {#if error !== ""}
        <p class="mt-2 text-[12px] text-[#8a6116]" role="alert">{error}</p>
      {/if}
      {#if watchlistLoadError === ""}
        <form
          class="mt-2.5 flex gap-1.5"
          onsubmit={(event) => {
            event.preventDefault();
            void createAndAdd();
          }}
        >
          <input
            class="h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="New watchlist name"
            placeholder="New list…"
            bind:value={newName}
          />
          <button
            class="h-7 rounded-md border border-input bg-secondary px-2.5 font-mono text-[11px] transition hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            type="submit"
            disabled={creating || newName.trim() === ""}
          >
            Create
          </button>
        </form>
      {/if}
      <button
        class="mt-2.5 font-mono text-[10.5px] text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        type="button"
        onclick={() => {
          open = false;
          onOpenWatchlists();
        }}
      >
        Manage watchlists →
      </button>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
